import { execSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
/* RED: module does not exist yet — import fails until codegen-mcp.ts is created. */
import { generateMCPServer } from "../../../src/codegen-mcp.ts"
import { generateSDK } from "../../../src/codegen.ts"
import { loadMockSpec, startMockServerSubprocess } from "./harness-util.ts"

/* ---- JSON-RPC 2.0 helpers ---- */

type JsonRpcRequest = {
	jsonrpc: "2.0"
	id: number
	method: string
	params?: Record<string, unknown>
}

type JsonRpcResponse = {
	jsonrpc: "2.0"
	id: number
	result?: Record<string, unknown>
	error?: { code: number; message: string; data?: unknown }
}

type McpHarness = {
	dir: string
	proc: ChildProcessWithoutNullStreams
	send: (req: JsonRpcRequest) => Promise<JsonRpcResponse>
	close: () => void
	mockKill: () => void
	mockPort: number
}

/* Harness-authored package.json — codegen no longer emits package.json
 * (it's hand-maintained in the mirror repo). Harness constructs the minimal
 * shape needed for `bun install` in the tmp dir. */
function buildHarnessPackageJson(): string {
	return JSON.stringify(
		{
			dependencies: {
				"@modelcontextprotocol/sdk": "^1",
				"@repo/mock-sdk": "file:./vendor/mock-sdk",
			},
			name: "harness-mcp-server",
			type: "module",
			version: "0.0.0",
		},
		null,
		2,
	)
}

/* Writes SDK + MCP server into tmp dir, spawns MCP subprocess, installs deps,
 * returns a send() closure that writes JSON-RPC requests to stdin and resolves
 * matching responses from stdout. Caller is responsible for calling close(). */
async function setupMcpHarness(): Promise<McpHarness> {
	const spec = loadMockSpec()
	const mcp = generateMCPServer(spec, {
		projectName: "mock",
		sdkClassName: "MockSDK",
		sdkPackageName: "@repo/mock-sdk",
	})
	const sdk = generateSDK(spec, { name: "MockSDK", stem: "mock" })

	const dir = mkdtempSync(join(tmpdir(), "honey-mcp-harness-"))

	/* write MCP server files */
	for (const [rel, content] of Object.entries(mcp.files)) {
		const abs = join(dir, rel)
		mkdirSync(join(abs, ".."), { recursive: true })
		writeFileSync(abs, content, "utf8")
	}

	/* stage generated TS SDK under vendor/mock-sdk (outside node_modules) so
	 * bun install can materialize it via file: protocol — avoids registry lookup
	 * of the fake @repo/mock-sdk package name. */
	const sdkVendorDir = join(dir, "vendor", "mock-sdk")
	mkdirSync(sdkVendorDir, { recursive: true })
	const SDK_FILES: Record<string, string> = {
		client: "mock.client.gen.ts",
		index: "mock.index.gen.ts",
		map: "mock.map.gen.ts",
		runtime: "mock.runtime.gen.ts",
		types: "mock.types.gen.ts",
	}
	for (const [key, filename] of Object.entries(SDK_FILES)) {
		const content = sdk.files[key as keyof typeof sdk.files]
		if (content !== null && content !== undefined) {
			writeFileSync(join(sdkVendorDir, filename), content, "utf8")
		}
	}
	writeFileSync(
		join(sdkVendorDir, "package.json"),
		JSON.stringify({ main: "./mock.index.gen.ts", name: "@repo/mock-sdk", type: "module", version: "0.0.0" }, null, 2),
		"utf8",
	)

	writeFileSync(join(dir, "package.json"), buildHarnessPackageJson(), "utf8")

	/* install MCP-side deps (bun install uses package.json in dir) */
	try {
		execSync("bun install --no-save", { cwd: dir, stdio: "pipe", timeout: 60_000 })
	} catch (err: unknown) {
		const e = err as { stderr?: Buffer; stdout?: Buffer; message?: string }
		throw new Error(
			`bun install failed in ${dir}:\nstderr: ${e.stderr?.toString() ?? ""}\nstdout: ${e.stdout?.toString() ?? ""}\n${e.message ?? ""}`,
			{ cause: err },
		)
	}

	/* start backing mock HTTP server */
	const { kill: mockKill, port: mockPort } = await startMockServerSubprocess()

	/* spawn MCP server subprocess — run via bun so TS executes without a build */
	const proc = spawn("bun", [join(dir, "src/server.ts")], {
		cwd: dir,
		env: {
			...process.env,
			MOCK_API_KEY: "valid-token",
			MOCK_BASE_URL: `http://127.0.0.1:${mockPort}`,
		},
		stdio: ["pipe", "pipe", "pipe"],
	}) as ChildProcessWithoutNullStreams

	/* line-delimited JSON-RPC response parser */
	const pending = new Map<number, (resp: JsonRpcResponse) => void>()
	let buf = ""
	proc.stdout.on("data", (chunk: Buffer) => {
		buf += chunk.toString()
		let nl = buf.indexOf("\n")
		while (nl !== -1) {
			const line = buf.slice(0, nl).trim()
			buf = buf.slice(nl + 1)
			if (line.length > 0) {
				try {
					const parsed = JSON.parse(line) as JsonRpcResponse
					const resolver = pending.get(parsed.id)
					if (resolver) {
						pending.delete(parsed.id)
						resolver(parsed)
					}
				} catch {
					/* non-JSON log line — ignore */
				}
			}
			nl = buf.indexOf("\n")
		}
	})

	const stderrChunks: Buffer[] = []
	proc.stderr.on("data", (c: Buffer) => stderrChunks.push(c))

	function send(req: JsonRpcRequest): Promise<JsonRpcResponse> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(req.id)
				reject(
					new Error(
						`JSON-RPC request id=${req.id} method=${req.method} timed out. stderr: ${Buffer.concat(stderrChunks).toString()}`,
					),
				)
			}, 8_000)
			pending.set(req.id, (resp) => {
				clearTimeout(timer)
				resolve(resp)
			})
			proc.stdin.write(`${JSON.stringify(req)}\n`)
		})
	}

	function close(): void {
		proc.kill("SIGTERM")
	}

	return { close, dir, mockKill, mockPort, proc, send }
}

/* ======================================================================
 * T4 — Static runtime JSON-RPC round-trip
 * ====================================================================== */

describe("MCP integration harness (subprocess + JSON-RPC)", () => {
	/* ---- T4.1 codegen produces all files + package installs cleanly ---- */
	it("T4.1 codegen emits files; bun install exits 0 in tmp dir", () => {
		const spec = loadMockSpec()
		const { files } = generateMCPServer(spec, {
			projectName: "mock",
			sdkClassName: "MockSDK",
			sdkPackageName: "@repo/mock-sdk",
		})
		const dir = mkdtempSync(join(tmpdir(), "honey-mcp-harness-t41-"))
		try {
			for (const [rel, content] of Object.entries(files)) {
				const abs = join(dir, rel)
				mkdirSync(join(abs, ".."), { recursive: true })
				writeFileSync(abs, content, "utf8")
			}
			/* stage SDK stub under vendor/ (outside node_modules) and point the SDK dep
			 * at it via file: protocol. Harness authors its own package.json because
			 * codegen-mcp no longer emits one (hand-maintained in the mirror repo). */
			const sdkVendorDir = join(dir, "vendor", "mock-sdk")
			mkdirSync(sdkVendorDir, { recursive: true })
			writeFileSync(
				join(sdkVendorDir, "package.json"),
				JSON.stringify({ main: "./index.js", name: "@repo/mock-sdk", type: "module", version: "0.0.0" }, null, 2),
				"utf8",
			)
			writeFileSync(join(sdkVendorDir, "index.js"), "export {}\n", "utf8")
			writeFileSync(join(dir, "package.json"), buildHarnessPackageJson(), "utf8")
			/* exitCode 0 assertion via execSync (throws on non-zero) */
			execSync("bun install --no-save", { cwd: dir, stdio: "pipe", timeout: 60_000 })
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})

	/* ---- T4.2 initialize handshake returns server capabilities ---- */
	it("T4.2 initialize handshake returns capabilities.tools", async () => {
		const h = await setupMcpHarness()
		try {
			const resp = await h.send({
				id: 1,
				jsonrpc: "2.0",
				method: "initialize",
				params: {
					capabilities: {},
					clientInfo: { name: "vitest-harness", version: "0.0.0" },
					protocolVersion: "2024-11-05",
				},
			})
			expect(resp.error).toBeUndefined()
			expect(resp.result).toBeDefined()
			const capabilities = (resp.result as { capabilities?: Record<string, unknown> }).capabilities
			expect(capabilities).toBeDefined()
			expect(capabilities?.tools).toBeDefined()
		} finally {
			h.close()
			h.mockKill()
			rmSync(h.dir, { force: true, recursive: true })
		}
	}, 30_000)

	/* ---- T4.3 tools/list returns flagged ops only ---- */
	it("T4.3 tools/list returns only x-mcp: true ops, each with name/description/inputSchema", async () => {
		const h = await setupMcpHarness()
		try {
			/* initialize first (MCP spec requires handshake before tools/list) */
			await h.send({
				id: 1,
				jsonrpc: "2.0",
				method: "initialize",
				params: {
					capabilities: {},
					clientInfo: { name: "vitest-harness", version: "0.0.0" },
					protocolVersion: "2024-11-05",
				},
			})
			const resp = await h.send({ id: 2, jsonrpc: "2.0", method: "tools/list" })
			expect(resp.error).toBeUndefined()
			const tools =
				(resp.result as { tools?: Array<{ name: string; description?: string; inputSchema: unknown }> }).tools ?? []
			expect(Array.isArray(tools)).toBe(true)
			expect(tools.length).toBeGreaterThan(0)
			/* mock spec has only /users POST flagged (see Step 8 in spec) */
			const names = tools.map((t) => t.name)
			expect(names).toContain("mock_create_user")
			for (const t of tools) {
				expect(typeof t.name).toBe("string")
				expect(t.inputSchema).toBeDefined()
			}
		} finally {
			h.close()
			h.mockKill()
			rmSync(h.dir, { force: true, recursive: true })
		}
	}, 30_000)

	/* ---- T4.4 tools/call round-trip: createUser ---- */
	it("T4.4 tools/call createUser returns JSON-stringified user in content[0].text", async () => {
		const h = await setupMcpHarness()
		try {
			await h.send({
				id: 1,
				jsonrpc: "2.0",
				method: "initialize",
				params: {
					capabilities: {},
					clientInfo: { name: "vitest-harness", version: "0.0.0" },
					protocolVersion: "2024-11-05",
				},
			})
			const resp = await h.send({
				id: 2,
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					arguments: { json: { email: "a@b.com", name: "Alice" } },
					name: "mock_create_user",
				},
			})
			expect(resp.error).toBeUndefined()
			const result = resp.result as { content?: Array<{ type: string; text: string }>; isError?: boolean }
			expect(result.isError).not.toBe(true)
			expect(result.content?.[0]?.type).toBe("text")
			const text = result.content?.[0]?.text ?? ""
			const parsed = JSON.parse(text) as { id?: string; name?: string }
			expect(parsed.name).toBe("Alice")
			expect(typeof parsed.id).toBe("string")
		} finally {
			h.close()
			h.mockKill()
			rmSync(h.dir, { force: true, recursive: true })
		}
	}, 30_000)

	/* ---- T4.5 tools/call error mapping: 401 unauthorized ---- */
	it("T4.5 tools/call with invalid MOCK_API_KEY → isError: true, 401/unauthorized in text", async () => {
		/* setup but override env with bad token BEFORE spawning */
		const spec = loadMockSpec()
		const mcp = generateMCPServer(spec, {
			projectName: "mock",
			sdkClassName: "MockSDK",
			sdkPackageName: "@repo/mock-sdk",
		})
		const sdk = generateSDK(spec, { name: "MockSDK", stem: "mock" })
		const dir = mkdtempSync(join(tmpdir(), "honey-mcp-harness-t45-"))
		const { kill: mockKill, port: mockPort } = await startMockServerSubprocess()
		let proc: ChildProcessWithoutNullStreams | null = null
		try {
			for (const [rel, content] of Object.entries(mcp.files)) {
				const abs = join(dir, rel)
				mkdirSync(join(abs, ".."), { recursive: true })
				writeFileSync(abs, content, "utf8")
			}
			const sdkVendorDir = join(dir, "vendor", "mock-sdk")
			mkdirSync(sdkVendorDir, { recursive: true })
			const SDK_FILES: Record<string, string> = {
				client: "mock.client.gen.ts",
				index: "mock.index.gen.ts",
				map: "mock.map.gen.ts",
				runtime: "mock.runtime.gen.ts",
				types: "mock.types.gen.ts",
			}
			for (const [key, filename] of Object.entries(SDK_FILES)) {
				const content = sdk.files[key as keyof typeof sdk.files]
				if (content !== null && content !== undefined) {
					writeFileSync(join(sdkVendorDir, filename), content, "utf8")
				}
			}
			writeFileSync(
				join(sdkVendorDir, "package.json"),
				JSON.stringify({ main: "./mock.index.gen.ts", name: "@repo/mock-sdk", type: "module", version: "0.0.0" }, null, 2),
				"utf8",
			)
			writeFileSync(join(dir, "package.json"), buildHarnessPackageJson(), "utf8")
			execSync("bun install --no-save", { cwd: dir, stdio: "pipe", timeout: 60_000 })

			const spawned = spawn("bun", [join(dir, "src/server.ts")], {
				cwd: dir,
				env: {
					...process.env,
					MOCK_API_KEY: "expired-token",
					MOCK_BASE_URL: `http://127.0.0.1:${mockPort}`,
				},
				stdio: ["pipe", "pipe", "pipe"],
			}) as ChildProcessWithoutNullStreams
			proc = spawned

			const pending = new Map<number, (r: JsonRpcResponse) => void>()
			let buf = ""
			spawned.stdout.on("data", (chunk: Buffer) => {
				buf += chunk.toString()
				let nl = buf.indexOf("\n")
				while (nl !== -1) {
					const line = buf.slice(0, nl).trim()
					buf = buf.slice(nl + 1)
					if (line.length > 0) {
						try {
							const parsed = JSON.parse(line) as JsonRpcResponse
							const resolver = pending.get(parsed.id)
							if (resolver) { pending.delete(parsed.id); resolver(parsed) }
						} catch {
							/* non-JSON log line */
						}
					}
					nl = buf.indexOf("\n")
				}
			})
			const stderrChunks: Buffer[] = []
			spawned.stderr.on("data", (c: Buffer) => stderrChunks.push(c))

			function send(req: JsonRpcRequest): Promise<JsonRpcResponse> {
				return new Promise((resolve, reject) => {
					const t = setTimeout(() => {
						pending.delete(req.id)
						reject(new Error(`timeout id=${req.id} stderr: ${Buffer.concat(stderrChunks).toString()}`))
					}, 8_000)
					pending.set(req.id, (r) => { clearTimeout(t); resolve(r) })
					spawned.stdin.write(`${JSON.stringify(req)}\n`)
				})
			}

			await send({
				id: 1,
				jsonrpc: "2.0",
				method: "initialize",
				params: {
					capabilities: {},
					clientInfo: { name: "vitest-harness", version: "0.0.0" },
					protocolVersion: "2024-11-05",
				},
			})
			const resp = await send({
				id: 2,
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					arguments: { json: { email: "x@y.com", name: "X" } },
					name: "mock_create_user",
				},
			})
			const result = resp.result as { content?: Array<{ type: string; text: string }>; isError?: boolean }
			expect(result.isError).toBe(true)
			const text = result.content?.[0]?.text ?? ""
			expect(text.toLowerCase()).toMatch(/401|unauthorized/)
		} finally {
			if (proc) proc.kill("SIGTERM")
			mockKill()
			rmSync(dir, { force: true, recursive: true })
		}
	}, 30_000)

	/* ---- T4.6 graceful shutdown on stdin close ---- */
	it("T4.6 subprocess exits within 2s of stdin close, exit code 0", async () => {
		const h = await setupMcpHarness()
		try {
			/* handshake so server is ready before stdin closes */
			await h.send({
				id: 1,
				jsonrpc: "2.0",
				method: "initialize",
				params: {
					capabilities: {},
					clientInfo: { name: "vitest-harness", version: "0.0.0" },
					protocolVersion: "2024-11-05",
				},
			})
			const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
				h.proc.on("exit", (code, signal) => resolve({ code, signal }))
			})
			const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2_500))
			h.proc.stdin.end()
			const race = await Promise.race([exited, timeout])
			expect(race).not.toBe("timeout")
			const result = race as { code: number | null; signal: NodeJS.Signals | null }
			expect(result.code).toBe(0)
		} finally {
			h.close()
			h.mockKill()
			rmSync(h.dir, { force: true, recursive: true })
		}
	}, 30_000)
})
