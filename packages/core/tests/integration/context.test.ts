/**
 * The handler's ctx: the request as sent, where it matched (path, pattern, params), the request
 * headers, and env, all belonging to their own request. The query is in context-query.test.ts;
 * route meta and background work in context-extension.test.ts.
 */
import { describe, expect, it } from "vitest"
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
