/**
 * The handler's ctx: the request as sent, where it matched (path, pattern, params), the request
 * headers, and env, all belonging to their own request; and the framework keys next() cannot
 * replace. The query is in context-query.test.ts; meta and background work in context-extension.test.ts.
 */
import { describe, expect, it } from "vitest"
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
describe("ctx.headers", () => {
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

	// v0: 33ce257712
	it("fifty custom headers are all readable", async () => {
		const app = honey<{}>()
		app.get("/h").handler((ctx) => ctx.res.json("ok", { headers: { ...ctx.headers } }))
		const sent = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`x-h${i}`, `v${i}`]))
		const { headers } = (await send(app, "/h", { init: { headers: sent } })).body as { headers: Record<string, string> }
		expect(Object.fromEntries(Object.entries(headers).filter(([name]) => name.startsWith("x-h")))).toEqual(sent)
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

/** Every key the framework owns on ctx. */
const RESERVED = [
	"background",
	"cookies",
	"env",
	"error",
	"errors",
	"executionCtx",
	"headers",
	"meta",
	"params",
	"path",
	"req",
	"res",
	"routePattern",
	"search",
	"searchAll",
	"signal",
] as const

const kind = (v: unknown) =>
	v === null ? "null" : typeof v === "object" ? (v.constructor?.name ?? "Object") : typeof v

/** A route that reports every framework key's kind and the values a request decides. */
function reportCtx(app: ReturnType<typeof honey<{ DB: string }>>) {
	app.get("/items/:id").handler((ctx) => {
		const own = ctx as unknown as Record<string, unknown>
		const kinds = Object.fromEntries(RESERVED.map((key) => [key, kind(own[key])]))
		const { env, params, path, routePattern, search } = ctx
		return ctx.res.json("ok", { env, kinds, params, path, routePattern, search, url: ctx.req.url, userId: own.userId })
	})
}

describe("framework keys on ctx", () => {
	// v0: 6cdeb245fc
	// v0: ef201b14c6
	// v0: 5ff8a09ee1
	// v0: b2c973584c
	// v0: 5ccc558c7c
	// v0: 7c9e100a0f
	// v0: 29fd214dac
	// v0: a2a82f9c2a
	// v0: ae9413ff7d
	// v0: 7c3d73cf11
	// v0: 7b0b7ae2b7
	// v0: 2b0757df51
	// v0: b05747747d
	it("next() drops every framework key and applies the rest", async () => {
		const hijack = { ...Object.fromEntries(RESERVED.map((key) => [key, "hijacked"])), req: new Request("http://evil/") }
		const hijacked = honey<{ DB: string }>()
		reportCtx(hijacked.use(createMiddleware((_ctx, next) => next({ ...hijack, userId: "u-1" }))))
		const control = honey<{ DB: string }>()
		reportCtx(control.use(createMiddleware((_ctx, next) => next({ userId: "u-1" }))))
		const target = "/items/42?q=real"
		const answer = await send(hijacked, target, { env: { DB: "real-db" } })
		expect(answer).toEqual(await send(control, target, { env: { DB: "real-db" } }))
		expect(answer).toMatchObject({
			body: {
				env: { DB: "real-db" },
				params: { id: "42" },
				path: "/items/42",
				routePattern: "/items/:id",
				search: { q: "real" },
				url: "http://localhost/items/42?q=real",
				userId: "u-1",
			},
			status: 200,
		})
	})
})

describe("app.context(): values every request's ctx carries", () => {
	// v0: c9a9aaa2d7
	// v0: 4d6f2acbc4
	// v0: 474f6803c7
	// v0: befc00f081
	// v0: 180f818dfb
	// v0: 5f480b5d68
	// v0: 7eb6038fa2
	it("reach app middleware, route middleware and the handler, beside additions, env and params, under a basePath", async () => {
		const seen: unknown[] = []
		const app = honey<{ SECRET: string }>().context({ db: "sqlite", prefix: "org" })
		app
			.use(
				createMiddleware(async (ctx: { db: string }, next) => {
					seen.push(["app", ctx.db])
					return next({ added: "fromMw" })
				}),
			)
			.basePath("/v1")
			.get("/items/:id")
			.use(
				createMiddleware(async (ctx: { db: string }, next) => {
					seen.push(["route", ctx.db])
					return next({ checked: true })
				}),
			)
			.handler((ctx) =>
				ctx.res.json("ok", {
					added: ctx.added,
					checked: ctx.checked,
					db: ctx.db,
					id: ctx.params.id,
					prefix: ctx.prefix,
					secret: ctx.env.SECRET,
				}),
			)
		const answer = await send(app, "/v1/items/42", { env: { SECRET: "s3cr3t" } })
		expect([answer.body, seen]).toEqual([
			{ added: "fromMw", checked: true, db: "sqlite", id: "42", prefix: "org", secret: "s3cr3t" },
			[
				["app", "sqlite"],
				["route", "sqlite"],
			],
		])
	})

	// v0: 6359961642
	it("are the same references on every request, never copies", async () => {
		const shared = { count: 0 }
		const app = honey<{}>().context({ shared })
		app.get("/inc").handler((ctx) => {
			ctx.shared.count++
			return ctx.res.json("ok", { count: ctx.shared.count, same: ctx.shared === shared })
		})
		await send(app, "/inc")
		expect((await send(app, "/inc")).body).toEqual({ count: 2, same: true })
	})
})

describe("app.context(): mounts and the framework's keys", () => {
	// v0: 93f5d173a2
	it("a mounted sub's routes keep the sub's values, the parent's routes the parent's", async () => {
		const sub = honey<{}>().context({ shared: "sub", subVal: "from-sub" }).basePath("/sub")
		sub.get("/test").handler((ctx) => ctx.res.json("ok", { shared: ctx.shared, sub: ctx.subVal }))
		const parent = honey<{}>().context({ shared: "parent" })
		parent.get("/test").handler((ctx) => ctx.res.json("ok", { shared: ctx.shared }))
		parent.route(sub)
		expect([(await send(parent, "/test")).body, (await send(parent, "/sub/test")).body]).toEqual([
			{ shared: "parent" },
			{ shared: "sub", sub: "from-sub" },
		])
	})

	// v0: 329636cf2d
	// v0: 6ffd201bbd
	it.each([...RESERVED, "ip", "log", "tap"])("refuse %s, a key the framework owns, at registration", (key) => {
		expect(() => honey<{}>().context({ [key]: 1 })).toThrow(`context() cannot set reserved key "${key}"`)
	})
})
