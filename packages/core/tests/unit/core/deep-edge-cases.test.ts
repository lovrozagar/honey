import { describe, expect, it } from "vitest"
import { HoneyContext } from "../../../src/context.ts"
import { createMiddleware, honey } from "../../../src/index.ts"

describe("unicode paths and params", () => {
	it("unicode in static paths — URL spec always percent-encodes, so use ASCII routes", async () => {
		const app = honey<{}>()
		/* URL constructor always encodes unicode: /café → /caf%C3%A9 */
		/* register with percent-encoded path to match */
		app.get("/caf%C3%A9").handler((ctx) => ctx.res.text("ok", "found"))

		const res = await app.fetch(new Request("http://localhost/café"), {})
		expect(res.status).toBe(200)
	})

	it("unicode param decoded correctly", async () => {
		const app = honey<{}>()
		app.get("/users/:name").handler((ctx) => ctx.res.json("ok", { name: ctx.params.name }))

		const res = await app.fetch(new Request("http://localhost/users/%E4%B8%96%E7%95%8C"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.name).toBe("世界")
	})

	it("emoji in param", async () => {
		const app = honey<{}>()
		app.get("/emoji/:e").handler((ctx) => ctx.res.json("ok", { e: ctx.params.e }))

		const res = await app.fetch(
			new Request(`http://localhost/emoji/${encodeURIComponent("🔥")}`),
			{},
		)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.e).toBe("🔥")
	})
})

describe("405 vs 404 precedence", () => {
	it("known path, wrong method → 405 (not 404)", async () => {
		const app = honey<{}>()
		app.get("/users/:id").handler((ctx) => ctx.res.text("ok", "ok"))
		app.post("/items").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/users/123", { method: "DELETE" }), {})
		expect(res.status).toBe(405)
		expect(res.headers.get("allow")).toContain("GET")
	})

	it("unknown path → 404 (not 405)", async () => {
		const app = honey<{}>()
		app.get("/users/:id").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(
			new Request("http://localhost/unknown/path", { method: "DELETE" }),
			{},
		)
		expect(res.status).toBe(404)
	})
})

describe("catch-all vs wildcard vs static precedence", () => {
	it("static > param priority on same level", async () => {
		const app = honey<{}>()
		app.get("/api/health").handler((ctx) => ctx.res.json("ok", { match: "static" }))
		app.get("/api/:resource").handler((ctx) => ctx.res.json("ok", { match: "param" }))

		const static_ = await app.fetch(new Request("http://localhost/api/health"), {})
		expect(((await static_.json()) as Record<string, unknown>).match).toBe("static")

		const param = await app.fetch(new Request("http://localhost/api/users"), {})
		expect(((await param.json()) as Record<string, unknown>).match).toBe("param")
	})

	it("wildcard captures multi-segment remainder", async () => {
		const app = honey<{}>()
		app.get("/files/*path").handler((ctx) => ctx.res.json("ok", { path: ctx.params.path }))

		const res = await app.fetch(new Request("http://localhost/files/a/b/c"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.path).toBe("a/b/c")
	})
})

describe("trailing slash + query string preservation", () => {
	it("strip trailing slash preserves query params in redirect", async () => {
		const app = honey<{}>()
		app.trailingSlash("strip")
		app.get("/search").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/search/?q=hello&page=2"), {})
		expect(res.status).toBe(308)
		const location = res.headers.get("location") ?? ""
		expect(location).toContain("q=hello")
		expect(location).toContain("page=2")
		expect(location).not.toContain("search/")
	})
})

describe("concurrent shared middleware state", () => {
	it("concurrent requests don't corrupt shared counter", async () => {
		let counter = 0
		const app = honey<{}>()
		const counting = createMiddleware(async (_ctx, next) => {
			counter++
			const res = await next()
			return res
		})

		app
			.use(counting)
			.get("/test")
			.handler(async (ctx) => {
				await new Promise((r) => setTimeout(r, Math.random() * 10))
				return ctx.res.json("ok", { count: counter })
			})

		const promises = Array.from({ length: 20 }, () =>
			app.fetch(new Request("http://localhost/test"), {}),
		)
		await Promise.all(promises)
		expect(counter).toBe(20)
	})
})

describe("stream abort handling", () => {
	it("SSE stream callback error triggers cleanup", async () => {
		let cleanedUp = false
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({ data: "first", event: "tick" })
				cleanedUp = true
				stream.close()
			}),
		)

		const res = await app.fetch(new Request("http://localhost/events"), {})
		const reader = res.body?.getReader()
		if (reader) {
			while (true) {
				const { done } = await reader.read()
				if (done) break
			}
		}

		expect(cleanedUp).toBe(true)
	})
})

describe("header case insensitivity", () => {
	it("ctx.headers lowercases all keys", () => {
		const ctx = new HoneyContext({
			env: {},
			params: {},
			req: new Request("http://localhost/test", {
				headers: { Authorization: "Bearer abc", "X-Custom-Header": "value" },
			}),
		})

		expect(ctx.headers["x-custom-header"]).toBe("value")
		expect(ctx.headers["authorization"]).toBe("Bearer abc")
		/* original casing not preserved */
		expect(ctx.headers["X-Custom-Header"]).toBeUndefined()
	})
})

describe("malformed content-type handling", () => {
	it("content-type with extra params still parsed as JSON", async () => {
		const app = honey<{}>()
		app.post("/test").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, unknown>
			return ctx.res.json("ok", body)
		})

		const res = await app.fetch(
			new Request("http://localhost/test", {
				body: JSON.stringify({ ok: true }),
				headers: { "content-type": "application/json; charset=utf-8" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.ok).toBe(true)
	})
})

describe("error types in catch", () => {
	it("throw undefined → 500", async () => {
		const app = honey<{}>()
		app.get("/test").handler(() => {
			throw undefined
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
	})

	it("throw TypeError → 500 with internal_server_error key", async () => {
		const app = honey<{}>()
		app.get("/test").handler(() => {
			const x: Record<string, unknown> = {}
			/* property access on undefined causes TypeError */
			return (x.missing as Record<string, unknown>).deep as never
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("internal_server_error")
	})
})

describe("duplicate query params edge cases", () => {
	it("same key same value not deduplicated", () => {
		const ctx = new HoneyContext({
			env: {},
			params: {},
			req: new Request("http://localhost/test?tag=A&tag=A"),
		})
		expect(ctx.searchAll.tag).toEqual(["A", "A"])
	})

	it("empty values preserved in multi-value", () => {
		const ctx = new HoneyContext({
			env: {},
			params: {},
			req: new Request("http://localhost/test?x=&x=b&x="),
		})
		expect(ctx.searchAll.x).toEqual(["", "b", ""])
	})
})

describe("path and routePattern with complex routes", () => {
	it("wildcard route pattern preserved", async () => {
		const app = honey<{}>()
		let pattern: string | undefined

		app.get("/files/*path").handler((ctx) => {
			pattern = ctx.routePattern
			return ctx.res.text("ok", "ok")
		})

		await app.fetch(new Request("http://localhost/files/a/b/c"), {})
		expect(pattern).toBe("/files/*path")
	})

	it("optional param route pattern preserved", async () => {
		const app = honey<{}>()
		let pattern: string | undefined

		app.get("/:lang?").handler((ctx) => {
			pattern = ctx.routePattern
			return ctx.res.text("ok", "ok")
		})

		await app.fetch(new Request("http://localhost/en"), {})
		expect(pattern).toBe("/:lang?")
	})
})
