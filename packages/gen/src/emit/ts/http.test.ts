import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

type Json = Record<string, any>
type Ctx = Record<string, any>

const BASE = "https://api.test"
const OK = { 200: { content: { "application/json": { schema: {} } }, description: "" } }
const BODY = { content: { "application/json": { schema: {} } } }

/** An OpenAPI 3.1 document of `paths`; each operation answers JSON and declares its `{name}` path parameters. */
function doc(paths: Record<string, Record<string, Json>>): Json {
	const filled = Object.entries(paths).map(([path, ops]) => {
		const parameters = [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
			in: "path",
			name,
			required: true,
			schema: { type: "string" },
		}))
		return [
			path,
			Object.fromEntries(Object.entries(ops).map(([verb, op]) => [verb, { parameters, responses: OK, ...op }])),
		]
	})
	return { info: { title: "T", version: "1" }, openapi: "3.1.0", paths: Object.fromEntries(filled) }
}

const USERS = doc({
	"/users": { get: { operationId: "users.list" }, post: { operationId: "users.create", requestBody: BODY } },
	"/users/{id}": { delete: { operationId: "users.remove" } },
})

/** The emitted `TestSDK` for `document`, built with `config` against BASE. */
async function sdkFor(document: Json, config: Json): Promise<any> {
	const { TestSDK } = await emittedSdk(document)
	return new (TestSDK as new (config: Json) => unknown)({ baseURL: BASE, ...config })
}

/** An onResponse hook that replaces every response with JSON `body`. */
function replyWith(body: unknown): () => Response {
	return () => Response.json(body)
}

/** An onResponse hook that retries every 401. */
const retryOn401 = (ctx: Ctx) => (ctx.response.status === 401 ? ctx.retry() : undefined)

/** An answer that replies with `responses` in turn, then `{}`. */
function inTurn(...responses: Response[]): () => Response {
	return () => responses.shift() ?? Response.json({})
}

describe("onRequest hooks", () => {
	// v0: c5cec596ec
	it("runs once per call with the request's Headers, method, route path and url", async () => {
		const seen: Ctx[] = []
		const { fetch } = recordingFetch()
		const sdk = await sdkFor(USERS, { fetch, onRequest: [(ctx: Ctx) => void seen.push(ctx)] })
		await sdk.users.list()
		expect(seen.map((ctx) => [ctx.headers instanceof Headers, ctx.method, ctx.path, ctx.url])).toEqual([
			[true, "GET", "/users", `${BASE}/users`],
		])
	})

	// v0: af2ab58370
	it("runs every hook in array order", async () => {
		const order: number[] = []
		const { fetch } = recordingFetch()
		const onRequest = [1, 2, 3].map((n) => () => void order.push(n))
		await (await sdkFor(USERS, { fetch, onRequest })).users.list()
		expect(order).toEqual([1, 2, 3])
	})

	// v0: 24e3c97682
	it("sends the headers a hook sets", async () => {
		const { calls, fetch } = recordingFetch()
		const sdk = await sdkFor(USERS, { fetch, onRequest: [(ctx: Ctx) => ctx.headers.set("x-custom", "injected")] })
		await sdk.users.list()
		expect(calls[0]?.headers.get("x-custom")).toBe("injected")
	})

	// v0: e5430a42ec
	it("exposes the serialized JSON body as ctx.body", async () => {
		const bodies: unknown[] = []
		const { fetch } = recordingFetch()
		const sdk = await sdkFor(USERS, { fetch, onRequest: [(ctx: Ctx) => void bodies.push(ctx.body)] })
		await sdk.users.create({ json: { a: 1 } })
		expect(bodies).toEqual([JSON.stringify({ a: 1 })])
	})

	// v0: 93c6d60de6
	it("leaves ctx.body undefined for a bodiless GET", async () => {
		const bodies: unknown[] = []
		const { fetch } = recordingFetch()
		const sdk = await sdkFor(USERS, { fetch, onRequest: [(ctx: Ctx) => void bodies.push(ctx.body)] })
		await sdk.users.list()
		expect(bodies).toEqual([undefined])
	})

	// v0: 35f67e8d93
	it("sends the body a hook writes to ctx.body", async () => {
		const { calls, fetch } = recordingFetch()
		const onRequest = [
			(ctx: Ctx) => {
				ctx.body = JSON.stringify({ a: 2 })
			},
		]
		await (await sdkFor(USERS, { fetch, onRequest })).users.create({ json: { a: 1 } })
		expect(await calls[0]?.text()).toBe(JSON.stringify({ a: 2 }))
	})
})

describe("config headers and fetch options", () => {
	// v0: 3644f5622e
	// v0: 4b04630294
	it("sends static config headers on every operation", async () => {
		const { calls, fetch } = recordingFetch()
		const sdk = await sdkFor(USERS, { fetch, headers: { authorization: "Bearer tok", "x-api-key": "abc" } })
		await sdk.users.list()
		await sdk.users.create({ json: {} })
		await sdk.users.remove({ params: { id: "1" } })
		expect(calls.map((call) => [call.headers.get("authorization"), call.headers.get("x-api-key")])).toEqual([
			["Bearer tok", "abc"],
			["Bearer tok", "abc"],
			["Bearer tok", "abc"],
		])
	})

	// v0: 3025883411
	it("calls a headers function with the call's method and route path, and sends what it returns", async () => {
		const contexts: unknown[] = []
		const headers = (ctx: Ctx) => {
			contexts.push(ctx)
			return { "x-method": ctx.method }
		}
		const { calls, fetch } = recordingFetch()
		await (await sdkFor(USERS, { fetch, headers })).users.list()
		expect([contexts, calls[0]?.headers.get("x-method")]).toEqual([[{ method: "GET", path: "/users" }], "GET"])
	})

	// v0: 3a4702b6b6
	it("passes config credentials and mode to fetch", async () => {
		const { calls, fetch } = recordingFetch()
		await (await sdkFor(USERS, { credentials: "include", fetch, mode: "same-origin" })).users.list()
		expect([calls[0]?.credentials, calls[0]?.mode]).toEqual(["include", "same-origin"])
	})
})

describe("onResponse hooks", () => {
	// v0: 408395cd24
	// v0: c062890fd6
	it("gets method, route path, url, isRetry false, the sent Request and the Response", async () => {
		const seen: unknown[] = []
		const { fetch } = recordingFetch(() => Response.json([], { status: 200 }))
		const record = (ctx: Ctx) => {
			const { isRetry, method, path, request, response, url } = ctx
			seen.push([isRetry, method, path, url, request instanceof Request && request.url, response.status])
			return undefined
		}
		await (await sdkFor(USERS, { fetch, onResponse: [record] })).users.list()
		expect(seen).toEqual([[false, "GET", "/users", `${BASE}/users`, `${BASE}/users`, 200]])
	})

	// v0: 400e740676
	it("runs every hook in order, each seeing the last replacement, and the last replacement wins", async () => {
		const seen: unknown[] = []
		const { fetch } = recordingFetch(() => Response.json({ original: true }))
		const second = async (ctx: Ctx) => {
			seen.push(await ctx.response.clone().json())
			return Response.json({ replaced: 2 })
		}
		const result = await (await sdkFor(USERS, { fetch, onResponse: [replyWith({ replaced: 1 }), second] })).users.list()
		expect([seen, result.data]).toEqual([[{ replaced: 1 }], { replaced: 2 }])
	})

	// v0: 4ba1fdfe9c
	it("keeps the original response when a hook returns undefined", async () => {
		const { fetch } = recordingFetch(() => Response.json({ original: true }))
		const result = await (await sdkFor(USERS, { fetch, onResponse: [() => undefined] })).users.list()
		expect(result.data).toEqual({ original: true })
	})

	// v0: ee80aece34
	it("parses the Response a hook returns instead of the received one", async () => {
		const { fetch } = recordingFetch(() => Response.json({ original: true }))
		const result = await (await sdkFor(USERS, { fetch, onResponse: [replyWith({ replaced: true })] })).users.list()
		expect(result.data).toEqual({ replaced: true })
	})
})

describe("ctx.retry()", () => {
	// v0: 02338dcfd7
	it("sends the request again and resolves to the retried Response, whose hook pass has isRetry true", async () => {
		const passes: unknown[] = []
		const { calls, fetch } = recordingFetch(inTurn(Response.json({}, { status: 401 }), Response.json({ id: "u1" })))
		const hook = async (ctx: Ctx) => {
			passes.push(ctx.isRetry)
			if (ctx.isRetry || ctx.response.status !== 401) return undefined
			const again: Response = await ctx.retry()
			passes.push([again instanceof Response, again.status])
			return again
		}
		const result = await (await sdkFor(USERS, { fetch, onResponse: [hook] })).users.list()
		expect([calls.length, passes, result.data]).toEqual([2, [false, true, [true, 200]], { id: "u1" }])
	})

	// v0: 2610f1105a
	it("returning ctx.retry() on a 401 makes one more fetch and resolves the second answer's data", async () => {
		const { calls, fetch } = recordingFetch(
			inTurn(Response.json({ message: "unauthorized" }, { status: 401 }), Response.json({ id: "u1" })),
		)
		const sdk = await sdkFor(USERS, { fetch, onResponse: [retryOn401], throwOnError: true })
		expect(await sdk.users.list()).toEqual({ id: "u1" })
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([`GET ${BASE}/users`, `GET ${BASE}/users`])
	})

	// v0: c510199f35
	it("retries at most once per call: a hook that retries every 401 ends with the second 401", async () => {
		const { calls, fetch } = recordingFetch(() => Response.json({ message: "nope" }, { status: 401 }))
		const result = await (await sdkFor(USERS, { fetch, onResponse: [retryOn401] })).users.list()
		expect([calls.length, result.status, Boolean(result.error)]).toEqual([2, 401, true])
	})
})

describe("calls", () => {
	// v0: e93d27fa9b
	it("makes one fetch per parallel call and gives each call its own answer", async () => {
		let count = 0
		const { calls, fetch } = recordingFetch(() => Response.json({ call: ++count }))
		const sdk = await sdkFor(USERS, { fetch })
		const results = await Promise.all([sdk.users.list(), sdk.users.list(), sdk.users.list()])
		expect([calls.length, results.map((result: Json) => result.data.call).sort()]).toEqual([3, [1, 2, 3]])
	})

	// v0: 808646da81
	it("rejects with the fetch failure even in safe mode", async () => {
		const { fetch } = recordingFetch(() => Promise.reject(new Error("network failure")))
		const sdk = await sdkFor(USERS, { fetch })
		await expect(sdk.users.list()).rejects.toThrow("network failure")
	})
})

/** tsc's diagnostics on `consumer.ts`, typechecked beside the emitted `files`. */
function consumerErrors(files: Readonly<Record<string, string>>, consumer: string): string[] {
	const root = join(process.env.HOME ?? homedir(), ".cache/honey-tmp/gen-ts-types")
	mkdirSync(root, { recursive: true })
	const dir = mkdtempSync(join(root, "sdk-"))
	const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin/tsc")
	const compilerOptions = {
		allowImportingTsExtensions: true,
		lib: ["esnext", "dom"],
		module: "esnext",
		moduleResolution: "bundler",
		noEmit: true,
		skipLibCheck: true,
		strict: true,
		target: "esnext",
		types: [],
	}
	for (const [name, text] of Object.entries({ ...files, "consumer.ts": consumer })) writeFileSync(join(dir, name), text)
	writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions, include: ["*.ts"] }))
	try {
		execFileSync(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: dir, encoding: "utf8" })
		return []
	} catch (error) {
		/* a failed run without one diagnostic is tsc not running at all, never a clean check */
		const lines = String((error as { stdout?: string }).stdout ?? "").split("\n")
		if (!lines.some((line) => / error TS\d+:/.test(line))) throw error
		return lines.filter((line) => line.startsWith("consumer.ts"))
	} finally {
		rmSync(dir, { force: true, recursive: true })
	}
}

describe("hook context types", () => {
	// v0: a038c119fe
	it("types the onRequest ctx.body as an optional, writable BodyInit", async () => {
		const { files } = await emittedSdk(USERS)
		const consumer = [
			'import { TestSDK } from "./test-sdk.index.gen.ts"',
			"new TestSDK({",
			'\tbaseURL: "https://api.test",',
			"\tonRequest: [",
			"\t\t(ctx) => {",
			"\t\t\tconst sent: BodyInit | undefined = ctx.body",
			'\t\t\tctx.body = sent ?? "{}"',
			"\t\t},",
			"\t\t(ctx) => {",
			"\t\t\t// @ts-expect-error a request body is never a number",
			"\t\t\tctx.body = 1",
			"\t\t},",
			"\t],",
			"})",
			"",
		].join("\n")
		expect(consumerErrors(files, consumer)).toEqual([])
	}, 60_000)
})
