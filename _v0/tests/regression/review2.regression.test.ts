/**
 * Regression guards for the second `/code-review high 3ab88ce..HEAD` pass, findings S1–S8
 * (docs/regression-matrix/review.md). Each test reproduces the reported scenario; S3 and S4 (the
 * Go and Python emitters) live in regression/ws9-12/polyglot.regression.test.ts.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createClient } from "../../src/client/index.ts"
import { generateSDK } from "../../src/codegen.ts"
import { generatePythonSDK, PY_BODY_GLOBALS } from "../../src/codegen-python.ts"
import * as codegen from "../../src/codegen.ts"
import * as genWrite from "../../src/gen-write.ts"
import { generateAndWrite, honey as honeyVitePlugin, resolveHoneyConfig } from "../../src/plugin.ts"

vi.mock("../../src/codegen.ts", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../../src/codegen.ts")>()
	return { ...orig, generateOpenApi: vi.fn(orig.generateOpenApi) }
})
vi.mock("../../src/gen-write.ts", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../../src/gen-write.ts")>()
	return { ...orig, writeGenJsonFile: vi.fn(orig.writeGenJsonFile) }
})

const SRC = resolve(import.meta.dirname, "../../src")
const ROOT = resolve(import.meta.dirname, "../../.tmp-regress-review2")

/* ── S1: credentials never follow a cross-origin redirect ─────────────────────────────── */

type Seen = { headers: Record<string, string>; url: string }

/** A fake fetch for two origins: `api.test` redirects every request to `evil.test`, which records. */
function twoOrigins() {
	const atEvil: Seen[] = []
	const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = String(input)
		if (url.startsWith("https://api.test/")) {
			return Promise.resolve(new Response(null, { headers: { location: "https://evil.test/landing" }, status: 302 }))
		}
		atEvil.push({ headers: Object.fromEntries(new Headers(init?.headers).entries()), url })
		return Promise.resolve(new Response("{}", { headers: { "content-type": "application/json" } }))
	}
	return { atEvil, fetch: fetch as typeof globalThis.fetch }
}

/** Header names a cross-origin hop must never carry: every one set from config, per call or by a hook. */
const PRIVATE = ["x-api-key", "x-call", "x-hook", "x-static"]

async function loadGenerated(): Promise<new (config: Record<string, unknown>) => Record<string, unknown>> {
	const spec = {
		info: { title: "T", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/items": {
				get: {
					operationId: "items.list",
					responses: { "200": { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } },
				},
			},
		},
	}
	const { files } = generateSDK(spec as never, { name: "S1SDK", stem: "sdk" })
	const body = files.client.replace(/^import type \{[^\n]+\n/, "").replace(/^import \{[^\n]+\n/, "")
	const { transform } = await import("esbuild")
	const { code } = await transform(`${files.map}\n${body}`, { format: "esm", loader: "ts", target: "esnext" })
	const mod = (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as {
		S1SDK: new (config: Record<string, unknown>) => Record<string, unknown>
	}
	return mod.S1SDK
}

describe("S1: a cross-origin redirect carries no configured, per-call or hook header", () => {
	// regression: S1
	it("createClient (function-form config.headers, per-call headers, onRequest)", async () => {
		const { atEvil, fetch } = twoOrigins()
		const client = createClient({
			baseURL: "https://api.test",
			fetch,
			headers: () => ({ "x-api-key": "secret" }),
			onRequest: [(ctx: { headers: Headers }) => void ctx.headers.set("x-hook", "h")],
			redirect: "follow",
		} as never) as unknown as { get(path: string, opts?: Record<string, unknown>): Promise<unknown> }
		await client.get("/items", { headers: { "x-call": "c" } })
		expect(atEvil).toHaveLength(1)
		for (const name of PRIVATE) expect(atEvil[0]?.headers[name], name).toBeUndefined()
	})

	// regression: S1
	it("the generated TypeScript SDK (function-form config.headers, per-call headers, onRequest)", async () => {
		const { atEvil, fetch } = twoOrigins()
		const Ctor = await loadGenerated()
		const sdk = new Ctor({
			baseUrl: "https://api.test",
			baseURL: "https://api.test",
			fetch,
			headers: () => ({ "x-api-key": "secret" }),
			onRequest: [(ctx: { headers: Headers }) => void ctx.headers.set("x-hook", "h")],
			redirect: "follow",
		}) as { items: { list(input?: unknown, opts?: Record<string, unknown>): Promise<unknown> } }
		await sdk.items.list(undefined, { headers: { "x-call": "c" } })
		expect(atEvil).toHaveLength(1)
		for (const name of PRIVATE) expect(atEvil[0]?.headers[name], name).toBeUndefined()
	})
})

/* ── plugin findings ──────────────────────────────────────────────────────────────────── */

type HotUpdate = (ctx: { file: string; modules: unknown[]; server: unknown; timestamp?: number }) => Promise<unknown>
type Plugin = {
	buildStart(): Promise<void>
	configResolved(c: { root: string }): void
	hotUpdate: HotUpdate
}

describe("plugin", () => {
	let dir: string

	beforeEach(() => {
		dir = join(ROOT, String(Math.random()).slice(2))
		mkdirSync(join(dir, "src"), { recursive: true })
		vi.mocked(codegen.generateOpenApi).mockClear()
		vi.mocked(genWrite.writeGenJsonFile).mockClear()
	})

	afterEach(() => {
		rmSync(dir, { force: true, recursive: true })
		vi.restoreAllMocks()
	})

	/** An app whose module records each evaluation, so a test can count generations. */
	function writeApp(lines: string[] = []): void {
		const loads = join(dir, "loads.txt")
		writeFileSync(
			join(dir, "src/app.ts"),
			[
				`import { appendFileSync } from "node:fs"`,
				`import { honey } from ${JSON.stringify(join(SRC, "index.ts"))}`,
				`appendFileSync(${JSON.stringify(loads)}, "x")`,
				"export const app = honey()",
				`app.get("/users").meta({ operationId: "users.list" }).handler((c) => c.res.text("ok", "ok"))`,
				...lines,
				"",
			].join("\n"),
			"utf-8",
		)
	}
	const loads = () => (existsSync(join(dir, "loads.txt")) ? readFileSync(join(dir, "loads.txt"), "utf-8").length : 0)

	// regression: S2
	it('S2: codegen.invalidate "off" also covers the SDK and Go CLI passes', async () => {
		writeApp([
			`app.post("/users").meta({ operationId: "users.create", invalidate: ["GET /userz"] } as never).handler((c) => c.res.text("ok", "ok"))`,
		])
		const config = resolveHoneyConfig({
			app: "src/app.ts",
			codegen: {
				cli: { binaryName: "demo", modulePath: "example.com/demo", out: "cli" },
				invalidate: "off",
				sdk: { ports: { typescript: { outDir: "sdk" } } },
			},
		} as never)
		await expect(generateAndWrite(config, dir)).resolves.toBeUndefined()
	}, 60_000)

	// regression: S2
	it("S2: the missing-invalidate warning prints once with openApi + sdk + cli", async () => {
		writeApp([`app.post("/users").meta({ operationId: "users.create" }).handler((c) => c.res.text("ok", "ok"))`])
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const config = resolveHoneyConfig({
			app: "src/app.ts",
			codegen: {
				cli: { binaryName: "demo", modulePath: "example.com/demo", out: "cli" },
				openApi: { path: "openapi.json", title: "T", version: "1" },
				sdk: { ports: { typescript: { outDir: "sdk" } } },
			},
		} as never)
		await generateAndWrite(config, dir)
		const reports = warn.mock.calls.filter((c) => /invalidate/i.test(c.map(String).join(" ")))
		expect(reports).toHaveLength(1)
	}, 60_000)

	// regression: S5
	it("S5: a temp file from an atomic write never schedules a generation", async () => {
		writeApp()
		const plugin = honeyVitePlugin({
			app: "src/app.ts",
			codegen: { tree: "src/routes.gen.ts" },
			watch: ["src/**"],
		})[0] as unknown as Plugin
		plugin.configResolved({ root: dir })
		const server = { moduleGraph: { getModuleById: () => undefined } }
		await plugin.hotUpdate({ file: join(dir, "src/routes.gen.ts.ab12cd.tmp"), modules: [], server })
		expect(loads()).toBe(0)
	}, 60_000)

	// regression: S6
	it("S6: an openApi path ending in .yml holds YAML and no sibling appears", async () => {
		writeApp()
		const config = resolveHoneyConfig({
			app: "src/app.ts",
			codegen: { openApi: { path: "openapi.yml", title: "T", version: "1" } },
		} as never)
		await generateAndWrite(config, dir)
		const text = readFileSync(join(dir, "openapi.yml"), "utf-8")
		expect(text.trimStart().startsWith("{")).toBe(false)
		expect(text).toMatch(/^openapi: /m)
		expect(existsSync(join(dir, "openapi.yaml"))).toBe(false)
	}, 60_000)

	// regression: S6
	it("S6: an openApi path ending in .yaml is written once, as YAML", async () => {
		writeApp()
		const config = resolveHoneyConfig({
			app: "src/app.ts",
			codegen: { openApi: { path: "openapi.yaml", title: "T", version: "1" } },
		} as never)
		await generateAndWrite(config, dir)
		expect(readFileSync(join(dir, "openapi.yaml"), "utf-8")).toMatch(/^openapi: /m)
		/* JSON first, then YAML over it: a reader in between sees JSON */
		const jsonWrites = vi.mocked(genWrite.writeGenJsonFile).mock.calls.map((c) => c[0])
		expect(jsonWrites.filter((p) => p.endsWith("openapi.yaml"))).toEqual([])
	}, 60_000)

	// regression: S7
	it("S7: buildStart in two environments runs one generation", async () => {
		writeApp()
		const plugin = honeyVitePlugin({ app: "src/app.ts", codegen: { tree: true } })[0] as unknown as Plugin
		plugin.configResolved({ root: dir })
		await plugin.buildStart()
		const one = loads()
		rmSync(join(dir, "loads.txt"), { force: true })
		const plugin2 = honeyVitePlugin({ app: "src/app.ts", codegen: { tree: true } })[0] as unknown as Plugin
		plugin2.configResolved({ root: dir })
		await Promise.all([plugin2.buildStart(), plugin2.buildStart()])
		expect(loads()).toBe(one)
	}, 60_000)

	// regression: S8
	it("S8: openApi + sdk + cli build the unfiltered document once", async () => {
		writeApp()
		const config = resolveHoneyConfig({
			app: "src/app.ts",
			codegen: {
				cli: { binaryName: "demo", modulePath: "example.com/demo", out: "cli" },
				openApi: { path: "openapi.json", title: "T", version: "1" },
				sdk: { ports: { typescript: { outDir: "sdk" } } },
			},
		} as never)
		await generateAndWrite(config, dir)
		/* one per openApi entry plus one shared by the SDK and the CLI */
		expect(vi.mocked(codegen.generateOpenApi)).toHaveBeenCalledTimes(2)
	}, 60_000)
})

/* ── S3 guard: the reserved names follow the emitter ──────────────────────────────────── */

describe("S3: Python parameter locals never shadow a name a method body evaluates", () => {
	const ok = { "200": { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }
	const sseOk = { "200": { content: { "text/event-stream": { schema: { type: "string" } } }, description: "ok" } }
	const pathP = (name: string) => ({ in: "path", name, required: true, schema: { type: "string" } })
	const spec = {
		info: { title: "T", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/a/{id}": {
				put: {
					operationId: "a.put",
					parameters: [pathP("id"), { in: "query", name: "q", schema: { type: "string" } }],
					requestBody: { content: { "application/json": { schema: { type: "object" } } } },
					responses: ok,
					"x-idempotency-key": true,
				},
			},
			"/f": {
				post: {
					operationId: "f.up",
					requestBody: {
						content: {
							"multipart/form-data": {
								schema: {
									properties: { file: { format: "binary", type: "string" }, name: { type: "string" } },
									type: "object",
								},
							},
						},
					},
					responses: ok,
				},
			},
			"/rt/{room}": { get: { operationId: "r.conn", parameters: [pathP("room")], responses: ok, "x-realtime": true } },
			"/s": {
				post: {
					operationId: "s.stream",
					requestBody: { content: { "application/json": { schema: { type: "object" } } } },
					responses: sseOk,
				},
			},
			"/u": {
				post: {
					operationId: "u.form",
					requestBody: {
						content: {
							"application/x-www-form-urlencoded": {
								schema: { properties: { a: { type: "string" } }, type: "object" },
							},
						},
					},
					responses: ok,
				},
			},
			"/ws": { get: { operationId: "w.conn", responses: ok, "x-websocket": true } },
		},
	}
	const KEYWORDS = new Set(
		"and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield None True False".split(
			" ",
		),
	)

	/** Names each method body calls, indexes or reads an attribute of, minus `self` and that method's params. */
	function bodyGlobals(client: string): Set<string> {
		const found = new Set<string>()
		let params = new Set<string>()
		for (const raw of client.split("\n")) {
			const line = raw.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
			if (/^\s+(?:async )?def \w+\(/.test(line)) {
				params = new Set([...line.matchAll(/(\w+)\s*:/g)].map((m) => m[1] ?? ""))
				continue
			}
			if (!/^ {8}/.test(raw)) continue
			/* a local variable annotation is never evaluated */
			const evaluated = line.replace(/^(\s+\w+): [^=]+=/, "$1 =")
			for (const m of evaluated.matchAll(/(?<![\w.])([A-Za-z]\w*)\s*[(.[]/g)) {
				const name = m[1] ?? ""
				if (!KEYWORDS.has(name) && name !== "self" && !params.has(name)) found.add(name)
			}
		}
		return found
	}

	// regression: S3
	it("every global the emitted bodies evaluate is reserved", () => {
		const { files } = generatePythonSDK(spec as never)
		const client = String(Object.entries(files).find(([k]) => k.endsWith("client.py"))?.[1])
		const globals = bodyGlobals(client)
		expect(globals.size).toBeGreaterThan(3)
		expect([...globals].filter((n) => !PY_BODY_GLOBALS.includes(n))).toEqual([])
	})
})
