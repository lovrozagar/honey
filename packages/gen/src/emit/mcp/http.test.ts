/**
 * The emitted server's Streamable HTTP mode (bit 21 d), its process run with `--http` against a recording server. It
 * listens on --host (127.0.0.1 by default; another only with --expose) and --port (0 picks one) and says where on
 * stderr. It refuses to start without $<PREFIX>_MCP_TOKEN unless --no-auth, which a token or --expose refuses; on an
 * unknown, repeated or stray argument, a bad port, a bad $<PREFIX>_MAX_BODY_BYTES, or a port taken. The token is the
 * request's bearer, never the API's: the API gets its own key, and a result echoing the token has it scrubbed. A file
 * path is never read over HTTP, its file root set or not. $<PREFIX>_MCP_ORIGINS lists other origins served, and
 * $<PREFIX>_MAX_BODY_BYTES caps a body. SIGTERM exits 0. The hostile requests are
 * tests/security/emit-adversarial.mcp-http.test.ts's, the official clients the conformance grid's http variants.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { served } from "../shared/__fixtures__/recording-server.ts"
import { serving } from "./__fixtures__/http-server.ts"
import { exchange, scratchDir, written } from "./__fixtures__/written.ts"
import { generateMcpServer } from "./server.ts"

const SLOW = { timeout: 120_000 }
const OK = { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }
const TOKEN = "mcp-t0ken-value"

/** The docs document: `docs.upload` a form with a file, `notes.get` a JSON answer. */
const docs = {
	info: { title: "Docs", version: "1.0.0" },
	openapi: "3.1.0",
	paths: {
		"/docs": {
			post: {
				operationId: "docs.upload",
				requestBody: {
					content: {
						"multipart/form-data": {
							schema: { properties: { file: { format: "binary", type: "string" } }, type: "object" },
						},
					},
				},
				responses: OK,
				"x-mcp": true,
			},
		},
		"/notes": { get: { operationId: "notes.get", responses: OK, "x-mcp": true } },
	},
}

const dir = written(generateMcpServer(docs, { envPrefix: "DOCS", name: "docs" }).files)

/** The server with `env` and `args`. */
const command = (env: readonly string[], args: readonly string[]) => [
	"env",
	...env,
	process.execPath,
	join(dir, "dist", "server.js"),
	...args,
]

/** What a start refused: its exit status and stderr. */
const refusedWith = async (env: readonly string[], args: readonly string[]) => {
	const ran = await exchange(command(["DOCS_BASE_URL=http://127.0.0.1:9", ...env], args), [])
	return [ran.status, ran.stderr]
}

/** A POST of `body` to `url` with a conforming client's headers beside `headers`. */
const post = (url: string, body: object, headers: Record<string, string> = {}) =>
	fetch(url, {
		body: JSON.stringify(body),
		headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...headers },
		method: "POST",
	})

/** A legacy tools/call of `name` with `args`, under 2025-11-25. */
const call = (url: string, name: string, args: object, headers: Record<string, string> = {}) =>
	post(
		url,
		{ id: 1, jsonrpc: "2.0", method: "tools/call", params: { arguments: args, name } },
		{ "mcp-protocol-version": "2025-11-25", ...headers },
	)

describe("starting with --http, refused", SLOW, () => {
	it.each([
		[
			[],
			["--http"],
			"No token: set $DOCS_MCP_TOKEN, which every request sends as Authorization: Bearer, or pass --no-auth\n",
		],
		[[`DOCS_MCP_TOKEN=${TOKEN}`], ["--http", "--no-auth"], "--no-auth, yet $DOCS_MCP_TOKEN is set: unset one\n"],
		[
			[`DOCS_MCP_TOKEN=${TOKEN}`],
			["--http", "--host", "0.0.0.0"],
			"--host 0.0.0.0 is no loopback address: pass --expose to serve beyond this machine\n",
		],
		[
			[`DOCS_MCP_TOKEN=${TOKEN}`],
			["--http", "--host"],
			"--host  is no loopback address: pass --expose to serve beyond this machine\n",
		],
		[[], ["--http", "--no-auth", "--expose"], "--expose needs $DOCS_MCP_TOKEN\n"],
		[[`DOCS_MCP_TOKEN=${TOKEN}`], ["--http", "--port", "65536"], "Invalid --port: 0 to 65535\n"],
		[[`DOCS_MCP_TOKEN=${TOKEN}`], ["--http", "--port", "08"], "Invalid --port: 0 to 65535\n"],
		[[`DOCS_MCP_TOKEN=${TOKEN}`], ["--http", "--port"], "Invalid --port: 0 to 65535\n"],
		[[], ["--htp"], "Unknown argument: --htp\n"],
		[[`DOCS_MCP_TOKEN=${TOKEN}`], ["--http", "--http"], "Unknown argument: --http\n"],
		[[], ["--port", "1"], "--port, --host, --no-auth and --expose serve HTTP: pass --http\n"],
		[[], ["--no-auth"], "--port, --host, --no-auth and --expose serve HTTP: pass --http\n"],
		[
			[`DOCS_MCP_TOKEN=${TOKEN}`, "DOCS_MAX_BODY_BYTES=1e3"],
			["--http", "--port", "0"],
			"Invalid $DOCS_MAX_BODY_BYTES: a whole number of bytes\n",
		],
	])("refuses to start with %j %j, saying why", async (env, args, why) => {
		expect(await refusedWith(env, args)).toEqual([1, why])
	})
})

describe("starting with --http, served", SLOW, () => {
	it("refuses to start on a port already taken, naming it", async () => {
		const taken = createServer()
		await new Promise<void>((settle) => taken.listen(0, "127.0.0.1", settle))
		const { port } = taken.address() as AddressInfo
		const [status, stderr] = await refusedWith([`DOCS_MCP_TOKEN=${TOKEN}`], ["--http", "--port", String(port)])
		taken.close()
		expect([status, String(stderr).startsWith(`Cannot listen on 127.0.0.1:${port}: listen EADDRINUSE`)]).toEqual([
			1,
			true,
		])
	})

	it("says where it serves, on each loopback host, and serves there; SIGTERM exits 0", async () => {
		const ready = await Promise.all(
			["127.0.0.1", "localhost", "::1"].map(async (host) => {
				const env = ["DOCS_BASE_URL=http://127.0.0.1:9", `DOCS_MCP_TOKEN=${TOKEN}`]
				const server = await serving(command(env, ["--http", "--host", host, "--port", "0"]))
				const listed = await post(
					server.url,
					{ id: 1, jsonrpc: "2.0", method: "tools/list" },
					{ authorization: `Bearer ${TOKEN}` },
				)
				return [server.url.replace(/:\d+\/mcp$/, ":PORT/mcp"), listed.status, await server.stop()]
			}),
		)
		expect(ready).toEqual([
			["http://127.0.0.1:PORT/mcp", 200, 0],
			["http://localhost:PORT/mcp", 200, 0],
			["http://[::1]:PORT/mcp", 200, 0],
		])
	})

	it("serves with --no-auth and no token, no Authorization needed", async () => {
		await served([{ json: { id: "n1" }, status: 200 }], async (api) => {
			const server = await serving(command([`DOCS_BASE_URL=${api.url}`], ["--http", "--no-auth", "--port", "0"]))
			const answer = await call(server.url, "notes_get", {})
			const text = await answer.text()
			await server.stop()
			expect([answer.status, (JSON.parse(text) as { result: { isError?: true } }).result.isError]).toEqual([
				200,
				undefined,
			])
		})
	})
})

describe("the token, the API key and file paths over HTTP", SLOW, () => {
	it("never sends the token to the API, sends the API its own key, and scrubs the token from a result", async () => {
		const seen = await served([{ json: { echoed: `the token is ${TOKEN}` }, status: 200 }], async (api) => {
			const server = await serving(
				command(
					[`DOCS_BASE_URL=${api.url}`, "DOCS_API_KEY=api-key-1", `DOCS_MCP_TOKEN=${TOKEN}`],
					["--http", "--port", "0"],
				),
			)
			const answer = await call(server.url, "notes_get", {}, { authorization: `Bearer ${TOKEN}` })
			const text = await answer.text()
			await server.stop()
			return [
				text.includes(TOKEN),
				text.includes("the token is [redacted]"),
				api.hops.map((hop) => Object.values(hop.headers).some((value) => value.includes(TOKEN))),
				api.hops[0]?.headers.authorization,
			]
		})
		expect(seen).toEqual([false, true, [false], "Bearer api-key-1"])
	})

	it("refuses a file path as a tool error even with a file root holding it, and sends the API nothing", async () => {
		const root = scratchDir("http-root")
		mkdirSync(root, { recursive: true })
		writeFileSync(join(root, "a.txt"), "abc")
		const seen = await served([], async (api) => {
			const server = await serving(
				command(
					[`DOCS_BASE_URL=${api.url}`, `DOCS_FILE_ROOT=${root}`, `DOCS_MCP_TOKEN=${TOKEN}`],
					["--http", "--port", "0"],
				),
			)
			const answer = await call(
				server.url,
				"docs_upload",
				{ file: { path: "a.txt" } },
				{ authorization: `Bearer ${TOKEN}` },
			)
			const result = ((await answer.json()) as { result: { content: { text: string }[]; isError: boolean } }).result
			await server.stop()
			return [result.isError, JSON.parse(result.content[0]?.text ?? "{}"), api.hops.length]
		})
		expect(seen).toEqual([true, { message: "Invalid arguments: file is a path, which only the stdio server reads" }, 0])
	})
})

describe("$DOCS_MCP_ORIGINS and $DOCS_MAX_BODY_BYTES", SLOW, () => {
	it("serves a listed origin and its own, refuses another with 403; refuses a body past the cap with 413", async () => {
		const server = await serving(
			command(
				[
					"DOCS_BASE_URL=http://127.0.0.1:9",
					`DOCS_MCP_TOKEN=${TOKEN}`,
					"DOCS_MCP_ORIGINS= https://a.example ,https://b.example",
					"DOCS_MAX_BODY_BYTES=200",
				],
				["--http", "--port", "0"],
			),
		)
		const own = new URL(server.url).origin
		const list = { id: 1, jsonrpc: "2.0", method: "tools/list" }
		const auth = { authorization: `Bearer ${TOKEN}`, "mcp-protocol-version": "2025-11-25" }
		const statuses = await Promise.all(
			[own, "https://a.example", "https://b.example", "https://c.example"].map(
				async (origin) => (await post(server.url, list, { ...auth, origin })).status,
			),
		)
		const capped = await Promise.all(
			[200, 201].map(
				async (size) =>
					(
						await post(
							server.url,
							{ ...list, pad: " ".repeat(size - JSON.stringify({ ...list, pad: "" }).length) },
							auth,
						)
					).status,
			),
		)
		await server.stop()
		expect([statuses, capped]).toEqual([
			[200, 200, 200, 403],
			[200, 413],
		])
	})
})
