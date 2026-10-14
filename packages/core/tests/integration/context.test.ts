/**
 * The handler's ctx: the request as sent, where it matched (path, pattern, params), the query and
 * headers, env, route meta, and background work handed to the execution context. Every value
 * belongs to its own request.
 */
import { describe, expect, it } from "vitest"
import { defineErrors } from "../../src/errors/errors.ts"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { honey } from "../../src/routing/app.ts"

type Fetchable = { fetch: (r: Request, env: never, executionCtx?: never) => Response | Promise<Response> }
type SendOptions = { env?: object; executionCtx?: object; init?: RequestInit }

async function send(app: Fetchable, target: string, { env = {}, executionCtx, init }: SendOptions = {}) {
	const res = await app.fetch(new Request(`http://localhost${target}`, init), env as never, executionCtx as never)
	return { body: (await res.json()) as unknown, status: res.status }
}

const ok = (body: unknown) => ({ body, status: 200 })

async function sha256(data: BufferSource): Promise<string> {
	return Buffer.from(await crypto.subtle.digest("SHA-256", data)).toString("hex")
}

const bytes = (length: number, at: (i: number) => number) => Uint8Array.from({ length }, (_, i) => at(i))

describe("ctx.req: the request as sent", () => {
	// v0: 2cb9b31b34
	// v0: 2c0da000c9
	// v0: 64fe70ad2e
	// v0: 57d46ed32b
	it.each([
		["5 MiB of every byte value", bytes(5 * 1024 * 1024, (i) => i % 256)],
		["all zeros", new Uint8Array(100_000)],
		["all 0xFF", new Uint8Array(50_000).fill(0xff)],
		["nulls throughout", bytes(10_000, (i) => (i % 3 === 0 ? 0 : i % 256))],
	])("a binary body (%s) reaches the handler byte for byte", async (_label, data) => {
		const app = honey<{}>()
		app.post("/bin").handler(async (ctx) => {
			const body = await ctx.req.arrayBuffer()
			return ctx.res.json("ok", { sha256: await sha256(body), size: body.byteLength })
		})
		const init = { body: data, headers: { "content-type": "application/octet-stream" }, method: "POST" }
		expect(await send(app, "/bin", { init })).toEqual(ok({ sha256: await sha256(data), size: data.byteLength }))
	})

	// v0: 3e4d6038b9
	// v0: 1b616ea954
	// v0: 8e994bd41c
	// v0: 2a6b90e677
	it.each([
		["astral-plane emoji", "POST", "🚀🌍🔥🎉🤡👽🌈💩"],
		["right-to-left text", "POST", "مرحبا بالعالم שלום עולם"],
		["zero-width characters", "POST", "​‌‍⁠"],
		["no body at all", "GET", ""],
	] as const)("a text body (%s) reaches the handler and comes back unchanged", async (_label, method, text) => {
		const app = honey<{}>()
		app.on([method], "/text").handler(async (ctx) => {
			const body = await ctx.req.text()
			return ctx.res.json("ok", { length: body.length, text: body })
		})
		const init = method === "GET" ? { method } : { body: text, method }
		expect(await send(app, "/text", { init })).toEqual(ok({ length: text.length, text }))
	})
})

describe("ctx.path, ctx.routePattern and ctx.params", () => {
	// v0: 7419f98248
	// v0: ccd34081e7
	// v0: b441d104e3
	// v0: 2e2f81028c
	// v0: 046f3f6b14
	// v0: e4887f8a9a
	// v0: 1119079a6a
	// v0: c3c5f182af
	// v0: 059275d8dd
	// v0: 8151808266
	it.each([
		{ params: { id: "42", postId: "7" }, pattern: "/users/:id/posts/:postId", target: "/users/42/posts/7" },
		{ params: { path: "a/b/c" }, pattern: "/files/*path", target: "/files/a/b/c" },
		{ params: { lang: "en" }, pattern: "/:lang?", target: "/en" },
		{ params: {}, pattern: "/:lang?", target: "/" },
		{ base: "/api", params: { m: "m2", o: "o1" }, pattern: "/orgs/:o/members/:m", target: "/api/orgs/o1/members/m2" },
		{ params: {}, path: "/health", pattern: "/health", target: "//health" },
		{ params: {}, path: "/page", pattern: "/page", target: "/page#section" },
	])("$target on $pattern: the path as matched, the full pattern, the captured params", async (row) => {
		const app = honey<{}>()
		app
			.basePath(row.base ?? "")
			.get(row.pattern)
			.handler((ctx) => ctx.res.json("ok", { params: { ...ctx.params }, path: ctx.path, pattern: ctx.routePattern }))
		const path = row.path ?? row.target
		const pattern = `${row.base ?? ""}${row.pattern}`
		expect(await send(app, row.target)).toEqual(ok({ params: row.params, path, pattern }))
	})
})

/** A route reporting the query as ctx.search and ctx.searchAll see it. */
function queryApp() {
	const app = honey<{}>()
	app.get("/q").handler((ctx) => ctx.res.json("ok", { search: { ...ctx.search }, searchAll: { ...ctx.searchAll } }))
	return app
}

describe("ctx.search and ctx.searchAll", () => {
	// v0: cfceceb40b
	// v0: c9d290f508
	// v0: 4c42cc1508
	// v0: 4b97585409
	// v0: 7356e68fee
	// v0: e6e7e3d7f5
	// v0: 95dc922798
	// v0: c693e5af94
	// v0: 6f15033b68
	// v0: f3103b361e
	// v0: a0bccff57c
	// v0: 5ecaf2c0ab
	// v0: e814eb78e0
	it.each([
		["", {}, {}],
		["?name=foo", { name: "foo" }, { name: ["foo"] }],
		["?tags=a&tags=b&tags=c", { tags: "a" }, { tags: ["a", "b", "c"] }],
		["?a=1&b=2&b=3&c=4", { a: "1", b: "2", c: "4" }, { a: ["1"], b: ["2", "3"], c: ["4"] }],
	])("query %j: search holds each key's first value, searchAll every value", async (query, search, searchAll) => {
		expect(await send(queryApp(), `/q${query}`)).toEqual(ok({ search, searchAll }))
	})

	// v0: 78e98994c3
	// v0: 4f155bcec2
	// v0: cecf528269
	it("search and headers are built once, and stay readable after the answer is made", async () => {
		let after: unknown
		const app = honey<{}>()
		app.get("/q").handler((ctx) => {
			const res = ctx.res.json("ok", { headers: ctx.headers === ctx.headers, search: ctx.search === ctx.search })
			after = { ...ctx.search }
			return res
		})
		expect(await send(app, "/q?a=1")).toEqual(ok({ headers: true, search: true }))
		expect(after).toEqual({ a: "1" })
	})
})

const PROTO_KEYS = ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"]

describe("ctx.headers, and records without a prototype", () => {
	// v0: 450b1f20f3
	// v0: e505b572b9
	it("ctx.headers is every request header, keyed in lower case", async () => {
		const app = honey<{}>()
		app.get("/h").handler((ctx) => ctx.res.json("ok", { headers: { ...ctx.headers }, mixed: ctx.headers["X-Custom"] }))
		const init = { headers: { Authorization: "Bearer tok", "X-Custom": "hello" } }
		expect(await send(app, "/h", { init })).toEqual(
			ok({ headers: { authorization: "Bearer tok", "x-custom": "hello" } }),
		)
	})

	// v0: 6ed9c47660
	// v0: 9eb2f48506
	it("search, searchAll and headers treat prototype names as plain keys", async () => {
		const app = honey<{}>()
		app.get("/q").handler((ctx) =>
			ctx.res.json("ok", {
				all: PROTO_KEYS.map((k) => ctx.searchAll[k] ?? null),
				first: PROTO_KEYS.map((k) => ctx.search[k] ?? null),
				header: PROTO_KEYS.map((k) => ctx.headers[k] ?? null),
				missing: ctx.search.nope ?? null,
			}),
		)
		const query = PROTO_KEYS.map((k) => `${k}=v-${k}&${k}=w`).join("&")
		expect(await send(app, `/q?${query}`)).toEqual(
			ok({
				all: PROTO_KEYS.map((k) => [`v-${k}`, "w"]),
				first: PROTO_KEYS.map((k) => `v-${k}`),
				header: PROTO_KEYS.map(() => null),
				missing: null,
			}),
		)
	})
})

describe("each request has its own ctx", () => {
	// v0: 71c3765f03
	// v0: 06475db60a
	// v0: 8e7138fed3
	// v0: bb001daba7
	it("concurrent requests each see the env they were given, whatever its keys", async () => {
		const app = honey<Record<string, string>>()
		app.get("/env").handler(async (ctx) => {
			await new Promise((resolve) => setTimeout(resolve, Math.random() * 10))
			return ctx.res.json("ok", { env: { ...ctx.env } })
		})
		const envs: Array<Record<string, string>> = [{ TENANT: "alpha" }, { TENANT: "beta", toString: "custom" }, {}]
		const answers = await Promise.all(envs.map((env) => send(app, "/env", { env })))
		expect(answers).toEqual(envs.map((env) => ok({ env })))
	})

	// v0: 086c7815fe
	// v0: d823447e06
	// v0: 1a25667625
	// v0: 90d5fa2c11
	it("parallel requests each see their own params; a handler's change to them stays in its request", async () => {
		const app = honey<{}>()
		app.get("/users/:id").handler(async (ctx) => {
			const seen = ctx.params.id
			if (ctx.search.mutate === "1") ctx.params.id = "hacked"
			await new Promise((resolve) => setTimeout(resolve, Math.random() * 10))
			return ctx.res.json("ok", { now: ctx.params.id, seen })
		})
		const ids = Array.from({ length: 100 }, (_, i) => String(i))
		const answers = await Promise.all(ids.map((id) => send(app, `/users/${id}?mutate=${Number(id) % 2}`)))
		expect(answers).toEqual(ids.map((id) => ok({ now: Number(id) % 2 ? "hacked" : id, seen: id })))
	})
})

type AppMeta = { auth?: "public" | "required"; rateLimit?: "default" | "strict" }

describe("ctx.meta", () => {
	// v0: 208fab9eae
	// v0: 388012fbac
	// v0: 9dfc3446fd
	it("is the route's meta, frozen, also on a route with an error factory, middleware and declared errors", async () => {
		const app = honey<{}>()
			.meta<AppMeta>()
			.errorFactory(defineErrors({ not_allowed: "forbidden" }))
			.use(createMiddleware((_ctx, next) => next({ userId: "u-1" })))
		app
			.get("/orgs")
			.meta({ auth: "required", rateLimit: "strict" })
			.errors("not_allowed")
			.handler((ctx) => ctx.res.json("ok", { frozen: Object.isFrozen(ctx.meta), meta: ctx.meta, userId: ctx.userId }))
		app.get("/plain").handler((ctx) => ctx.res.json("ok", { frozen: Object.isFrozen(ctx.meta), meta: ctx.meta }))
		expect(await send(app, "/orgs")).toEqual(
			ok({ frozen: true, meta: { auth: "required", rateLimit: "strict" }, userId: "u-1" }),
		)
		expect(await send(app, "/plain")).toEqual(ok({ frozen: true, meta: {} }))
	})

	// v0: fbf7ced595
	// v0: 99359e229d
	// v0: c90a72efd3
	// v0: 5ab1605dec
	it("an internal route, marked on itself or on its chain, still answers and sees internal: true", async () => {
		const app = honey<{}>().meta<AppMeta>()
		app
			.get("/api/users")
			.meta({ auth: "public" })
			.handler((ctx) => ctx.res.json("ok", { meta: ctx.meta }))
		app
			.get("/health")
			.meta({ internal: true })
			.handler((ctx) => ctx.res.json("ok", { meta: ctx.meta }))
		const internal = app.meta({ internal: true })
		internal.get("/metrics").handler((ctx) => ctx.res.json("ok", { meta: ctx.meta }))
		internal
			.get("/debug")
			.meta({ auth: "required" })
			.handler((ctx) => ctx.res.json("ok", { meta: ctx.meta }))
		expect(await send(app, "/api/users")).toEqual(ok({ meta: { auth: "public" } }))
		expect(await send(app, "/health")).toEqual(ok({ meta: { internal: true } }))
		expect(await send(app, "/metrics")).toEqual(ok({ meta: { internal: true } }))
		expect(await send(app, "/debug")).toEqual(ok({ meta: { auth: "required", internal: true } }))
	})
})

/** An execution context whose waitUntil, like workerd's, throws unless called on its owner. */
function strictExecutionCtx() {
	const handed: Promise<unknown>[] = []
	const executionCtx = {
		waitUntil(this: unknown, promise: Promise<unknown>): void {
			if (this !== executionCtx) throw new TypeError("Illegal invocation")
			handed.push(promise)
		},
	}
	return { executionCtx, handed }
}

describe("ctx.background and ctx.executionCtx", () => {
	// v0: dd41ef2833
	// v0: d41b1bcb2d
	// v0: f5a5019dfa
	// v0: 85830ec8d5
	// v0: c6954e7a8d
	it.each([
		["a handler that answers", "/ok", 200],
		["a handler that throws", "/boom", 500],
		["chain middleware on an unknown path", "/nope", 404],
	])("work started by %s goes to waitUntil, called on its owner", async (_label, target, status) => {
		const app = honey<{}>().use(
			createMiddleware((ctx, next) => {
				ctx.background(Promise.resolve(`mw ${target}`))
				return next()
			}),
		)
		app.get("/ok").handler((ctx) => ctx.res.json("ok", {}))
		app.get("/boom").handler(() => {
			throw new Error("boom")
		})
		const { executionCtx, handed } = strictExecutionCtx()
		expect((await send(app, target, { executionCtx })).status).toBe(status)
		expect(await Promise.all(handed)).toEqual([`mw ${target}`])
	})

	// v0: d62bde9180
	// v0: 0f66931f2b
	// v0: 4cdb0f86ab
	// v0: 2b0365b6c3
	it("ctx.executionCtx is the object fetch was given, and undefined without one", async () => {
		const seen: unknown[] = []
		const app = honey<{}>()
		app.get("/t").handler((ctx) => {
			seen.push(ctx.executionCtx)
			return ctx.res.json("ok", {})
		})
		const { executionCtx } = strictExecutionCtx()
		await send(app, "/t", { executionCtx })
		await send(app, "/t")
		expect(seen).toEqual([executionCtx, undefined])
		expect(seen[0]).toBe(executionCtx)
	})

	// v0: ac413420f7
	// v0: d4bf8a717c
	it("without an execution context, background work still runs, and its failure leaves the answer alone", async () => {
		const ran: string[] = []
		const app = honey<{}>()
		app.get("/bg").handler((ctx) => {
			ctx.background(new Promise((resolve) => setTimeout(resolve, 10)).then(() => ran.push("later")))
			ctx.background(Promise.reject(new Error("bg fail")))
			return ctx.res.json("ok", { answered: true })
		})
		expect(await send(app, "/bg")).toEqual(ok({ answered: true }))
		await new Promise((resolve) => setTimeout(resolve, 30))
		expect(ran).toEqual(["later"])
	})
})
