import { afterEach, describe, expect, it, vi } from "vitest"
import { createMiddleware } from "../middleware/middleware.ts"
import { honey } from "../routing/app.ts"
import type { OnErrorFn } from "../routing/settings.ts"
import { createLogger } from "../telemetry/logger.ts"
import { HoneyError } from "./error.ts"

/** A json logger at trace whose lines are parsed into `lines`. */
function recording() {
	const lines: Record<string, unknown>[] = []
	const logger = createLogger({
		format: "json",
		level: "trace",
		write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
	})
	return { lines, logger }
}

const get = (path: string, init?: RequestInit) => new Request(`https://app.example.com${path}`, init)

/** An app whose GET /boom throws `thrown`, logging to a recording logger. */
function throwing(thrown: unknown) {
	const { lines, logger } = recording()
	const app = honey<{}>().logger(logger)
	app.get("/boom/:id").handler(() => {
		throw thrown
	})
	return { app, lines }
}

afterEach(() => {
	vi.unstubAllEnvs()
})

describe("onError: every thrown error reaches it, no framework answer does", () => {
	// v0: 39262a8ac0
	// v0: 756f553ae9
	// v0: 86bd39b9e3
	it.each([
		["an unknown Error", new Error("db down")],
		["a named 4xx HoneyError", new HoneyError({ errorKey: "slug_taken", status: "conflict" })],
		["a thrown string", "plain"],
	])("%s reaches onError as thrown", async (_name, thrown) => {
		const seen: unknown[] = []
		const { app } = throwing(thrown)
		app.onError((error) => void seen.push(error))
		await app.fetch(get("/boom/1"), {})
		expect(seen).toEqual([thrown])
	})

	it.each([
		["no route (404)", get("/nowhere"), 404],
		["a method the path does not serve (405)", get("/only-post"), 405],
		["a trailing slash redirect (308)", get("/page/"), 308],
		["a plain GET to a WebSocket route (426)", get("/live"), 426],
		["a path the normalization refuses (400)", get("/a%2Fb"), 400],
	])("%s never calls onError", async (_name, request, status) => {
		const onError = vi.fn()
		const app = honey<{}>().onError(onError).trailingSlash("strip")
		app.post("/only-post").handler((ctx) => ctx.res.text("ok", "posted"))
		app.get("/page").handler((ctx) => ctx.res.text("ok", "page"))
		app.ws("/live").handler({})
		const res = await app.fetch(request, {})
		expect([res.status, onError.mock.calls]).toEqual([status, []])
	})
})

describe("onError: what it returns shapes the response", () => {
	// v0: f83c28920e
	// v0: 717a9b904b
	// v0: 6cd7fcc2f8
	// v0: ac2d8e0169
	// v0: 2ae8803f7f
	// v0: 0a9ebbf4a3
	// v0: e33409b851
	// v0: 2c4091a70b
	// v0: 74d71d8fb9
	it.each<[string, OnErrorFn<{}>, [number, string | undefined, string | null, boolean]]>([
		[
			"a HoneyError replaces the error, status and headers kept",
			() => new HoneyError({ errorKey: "slug_taken", headers: { "retry-after": "5" }, status: "conflict" }),
			[409, "slug_taken", "5", false],
		],
		[
			"a promise of one is awaited",
			async () => new HoneyError({ errorKey: "gone", status: "gone" }),
			[410, "gone", null, false],
		],
		["a Response answers as it is", () => new Response("custom", { status: 418 }), [418, undefined, null, false]],
		[
			"nothing falls through to the native 500, an unknown error's: with its digest",
			() => undefined,
			[500, "internal_server_error", null, true],
		],
		[
			"a HoneyError with an unknown status key is the internal 500, one onError chose: no digest",
			() => new HoneyError({ errorKey: "typed", status: "nope" as never }),
			[500, "internal_server_error", null, false],
		],
	])("%s", async (_name, onError, [status, errorKey, retryAfter, digested]) => {
		const { app } = throwing(new Error("db constraint"))
		app.onError(onError)
		const res = await app.fetch(get("/boom/1"), {})
		const body =
			res.headers.get("content-type") === "application/json"
				? ((await res.json()) as { digest?: string; error_key?: string })
				: {}
		expect([res.status, body.error_key, res.headers.get("retry-after"), "digest" in body]).toEqual([
			status,
			errorKey,
			retryAfter,
			digested,
		])
	})
})

describe("onError: its helpers and its place in the chain", () => {
	// v0: 6a103313e8
	it("jsonFromError renders a HoneyError the framework's way", async () => {
		const { app } = throwing(new Error("x"))
		app.onError((_error, ctx) => ctx.jsonFromError(new HoneyError({ errorKey: "teapot", status: "im_a_teapot" })))
		const res = await app.fetch(get("/boom/1"), {})
		expect([res.status, ((await res.json()) as { error_key: string }).error_key]).toEqual([418, "teapot"])
	})

	// v0: 1aa1650b1a
	it("onError's response flows back through the middleware above the throw", async () => {
		const { lines, logger } = recording()
		void lines
		const app = honey<{}>().logger(logger)
		const stamp = createMiddleware(async (_ctx, next) => {
			const res = await next()
			res.headers.set("x-stamped", "yes")
			return res
		})
		app
			.use(stamp)
			.get("/boom")
			.handler(() => {
				throw new Error("x")
			})
		app.onError(() => new Response("mapped", { status: 503 }))
		const res = await app.fetch(get("/boom"), {})
		expect([res.status, res.headers.get("x-stamped")]).toEqual([503, "yes"])
	})
})

describe("onError: one that fails falls back, and is logged once", () => {
	// v0: 3887230e2b
	// v0: 5ff4d444fb
	// v0: a7d646a01e
	it.each([
		[
			"throws",
			() => {
				throw new Error("onError broke")
			},
		],
		["rejects", async () => Promise.reject(new Error("onError broke"))],
	])("an onError that %s: the native 500, and one line naming it", async (_name, onError) => {
		const { app, lines } = throwing(new Error("db down"))
		app.onError(onError)
		const res = await app.fetch(get("/boom/1"), {})
		const failures = lines.filter((line) => line.msg === "onError failed").map((line) => line.err)
		expect([res.status, failures]).toEqual([500, [expect.objectContaining({ message: "onError broke" })]])
	})
})

describe("the digest: an unknown error's 500 and its operator line", () => {
	// v0: 55e46daa5e
	// v0: 35c503a101
	// v0: 2be7314336
	// v0: 9fda7d126b
	// v0: a673d850da
	it.each([
		["an Error", new Error("db down"), { message: "db down", name: "Error", stack: expect.any(String) }],
		["a string", "plain", { message: "plain" }],
		["a number", 42, { message: "42" }],
		["null", null, { message: "null" }],
	])(
		"%s: the client gets a generic 500 and a digest, the operator the same digest with the detail",
		async (_name, thrown, err) => {
			const { app, lines } = throwing(thrown)
			const res = await app.fetch(get("/boom/7?token=secret"), {})
			const body = (await res.json()) as Record<string, unknown>
			const [line] = lines.filter((entry) => entry.msg === "unhandled error")
			expect([res.status, body.error_key, body.message, body.digest, JSON.stringify(body).includes("stack")]).toEqual([
				500,
				"internal_server_error",
				"internal_server_error",
				expect.stringMatching(/^[0-9a-f]{16}$/),
				false,
			])
			expect(line).toMatchObject({
				digest: body.digest,
				err,
				level: 50,
				method: "GET",
				path: "/boom/7",
				routeId: "GET /boom/:id",
			})
		},
	)

	it("each occurrence gets its own digest", async () => {
		const { app } = throwing(new Error("x"))
		const digests = await Promise.all(
			[1, 2].map(async () => ((await (await app.fetch(get("/boom/1"), {})).json()) as { digest: string }).digest),
		)
		expect(new Set(digests).size).toBe(2)
	})

	it.each([
		["a named 4xx", new HoneyError({ errorKey: "slug_taken", status: "conflict" })],
		["a named 5xx", new HoneyError({ errorKey: "upstream_down", status: "bad_gateway" })],
	])("%s carries no digest and writes no operator line", async (_name, thrown) => {
		const { app, lines } = throwing(thrown)
		const body = (await (await app.fetch(get("/boom/1"), {})).json()) as Record<string, unknown>
		expect([body.digest, lines]).toEqual([undefined, []])
	})

	it("an error onError handled writes no operator line", async () => {
		const { app, lines } = throwing(new Error("db constraint"))
		app.onError(() => new HoneyError({ errorKey: "slug_taken", status: "conflict" }))
		await app.fetch(get("/boom/1"), {})
		expect(lines).toEqual([])
	})
})

describe("the default logger: unconfigured errors are not swallowed (H17)", () => {
	// v0: 342ac7baf3 — v1 inverts it: an app with no logger set writes its errors through the default logger
	it("with no logger set, a production app writes the operator line to stdout", async () => {
		vi.stubEnv("NODE_ENV", "production")
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
		const app = honey<{}>()
		app.get("/boom").handler(() => {
			throw new Error("db down")
		})
		const res = await app.fetch(get("/boom"), {})
		const lines = write.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
		write.mockRestore()
		expect([
			res.status,
			lines.map((line) => [line.level, line.msg, (line.err as { message: string }).message]),
		]).toEqual([500, [[50, "unhandled error", "db down"]]])
	})

	it("logger(false) writes nothing", async () => {
		vi.stubEnv("NODE_ENV", "production")
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
		const app = honey<{}>().logger(false)
		app.get("/boom").handler(() => {
			throw new Error("db down")
		})
		await app.fetch(get("/boom"), {})
		const calls = write.mock.calls.length
		write.mockRestore()
		expect(calls).toBe(0)
	})
})
