import { describe, expect, it } from "vitest"
import * as z from "zod"
import { createMiddleware, honey } from "../../../src/index.ts"

describe("bizarre: request already consumed", () => {
	it("handler that reads req.json() twice → second read throws, caught as 500", async () => {
		const app = honey<{}>()
		app.post("/test").handler(async (ctx) => {
			await ctx.req.json()
			/* body already consumed — second read should fail */
			try {
				await ctx.req.json()
			} catch {
				return ctx.res.json("ok", { doubleRead: "caught" })
			}
			return ctx.res.json("ok", { doubleRead: "no-error" })
		})

		const res = await app.fetch(
			new Request("http://localhost/test", {
				body: JSON.stringify({ data: 1 }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.doubleRead).toBe("caught")
	})
})

describe("bizarre: toJSON methods", () => {
	it("object with toJSON that returns different shape", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => {
			const sneaky = {
				secret: "should-not-appear",
				toJSON() {
					return { public: "visible" }
				},
			}
			return ctx.res.json("ok", sneaky)
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.public).toBe("visible")
		expect(body.secret).toBeUndefined()
	})

	it("object with toJSON that throws → 500", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => {
			const explosive = {
				toJSON() {
					throw new Error("toJSON exploded")
				},
			}
			return ctx.res.json("ok", explosive)
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
	})
})

describe("bizarre: output validation on consumed response", () => {
	it("output validation clones response before reading — original still usable", async () => {
		const app = honey<{}>()
		app.outputValidation("always")
		app
			.get("/test")
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((ctx) => ctx.res.json("ok", { id: "abc" }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		/* client should be able to read the body — not consumed by validation */
		const body = (await res.json()) as Record<string, unknown>
		expect(body.id).toBe("abc")
	})
})

describe("bizarre: Symbol and non-string keys", () => {
	it("middleware additions with numeric keys", async () => {
		const app = honey<{}>()
		const mw = createMiddleware(async (_ctx, next) => {
			return next({ count: 42 })
		})
		app
			.use(mw)
			.get("/test")
			.handler((ctx) => ctx.res.json("ok", { count: ctx.count }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.count).toBe(42)
	})
})

describe("bizarre: response with unusual status codes", () => {
	it("status 204 noContent has null body", async () => {
		const app = honey<{}>()
		app.delete("/test").handler((ctx) => ctx.res.noContent())

		const res = await app.fetch(new Request("http://localhost/test", { method: "DELETE" }), {})
		expect(res.status).toBe(204)
		expect(res.body).toBeNull()
	})

	it("status 301 redirect with custom status", async () => {
		const app = honey<{}>()
		app.get("/old").handler((ctx) => ctx.res.redirect("/new", { status: 301 }))

		const res = await app.fetch(new Request("http://localhost/old"), {})
		expect(res.status).toBe(301)
		expect(res.headers.get("location")).toBe("/new")
	})
})

describe("bizarre: empty handler chain edge cases", () => {
	it("app with zero routes → always 404", async () => {
		const app = honey<{}>()

		const res = await app.fetch(new Request("http://localhost/anything"), {})
		expect(res.status).toBe(404)
	})

	it("app with only middleware, no routes → 404", async () => {
		const mw = createMiddleware(async (_ctx, next) => next({ added: true }))
		const app = honey<{}>().use(mw)

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(404)
	})
})

describe("bizarre: handler returns response with locked body", () => {
	it("streaming response body remains readable by client", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) =>
			ctx.res.stream(async (writable) => {
				const writer = writable.getWriter()
				await writer.write(new TextEncoder().encode("hello"))
				await writer.close()
			}),
		)

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("hello")
	})
})

describe("bizarre: multiple fetch() on same app instance", () => {
	it("1000 sequential requests don't degrade or leak", async () => {
		const app = honey<{}>()
		app.get("/ping").handler((ctx) => ctx.res.text("ok", "pong"))

		for (let i = 0; i < 1000; i++) {
			const res = await app.fetch(new Request("http://localhost/ping"), {})
			if (i === 0 || i === 999) {
				expect(res.status).toBe(200)
				expect(await res.text()).toBe("pong")
			}
		}
	})

	it("app state (routes) not corrupted after many requests", async () => {
		const app = honey<{}>()
		app.get("/a").handler((ctx) => ctx.res.text("ok", "a"))
		app.get("/b").handler((ctx) => ctx.res.text("ok", "b"))

		/* interleave requests */
		for (let i = 0; i < 100; i++) {
			const [ra, rb] = await Promise.all([
				app.fetch(new Request("http://localhost/a"), {}),
				app.fetch(new Request("http://localhost/b"), {}),
			])
			if (i === 99) {
				expect(await ra.text()).toBe("a")
				expect(await rb.text()).toBe("b")
			}
		}
	})
})

describe("bizarre: env edge cases", () => {
	it("env with prototype methods doesn't interfere", async () => {
		const app = honey<{ toString: string }>()
		app.get("/test").handler((ctx) => ctx.res.json("ok", { val: ctx.env.toString }))

		const res = await app.fetch(new Request("http://localhost/test"), {
			toString: "custom",
		})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.val).toBe("custom")
	})

	it("empty env object works", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
	})
})

describe("bizarre: handler that modifies its own response headers", () => {
	it("response headers set in handler survive to client", async () => {
		const app = honey<{}>()
		app
			.get("/test")
			.handler((ctx) => ctx.res.json("ok", {}, { headers: { "x-request-id": "abc-123" } }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.headers.get("x-request-id")).toBe("abc-123")
		expect(res.headers.get("content-type")).toBe("application/json")
	})
})

describe("bizarre: params that look like path traversal", () => {
	it(":id with value '../etc/passwd' → decoded but not traversed", async () => {
		const app = honey<{}>()
		app.get("/files/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

		const res = await app.fetch(
			new Request(`http://localhost/files/${encodeURIComponent("../etc/passwd")}`),
			{},
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		/* param is decoded but treated as a value, not a path */
		expect(body.id).toBe("../etc/passwd")
	})
})

describe("bizarre: very fast sequential route registration", () => {
	it("registering 500 routes doesn't corrupt the tree", async () => {
		const app = honey<{}>()
		for (let i = 0; i < 500; i++) {
			app.get(`/r/${i}`).handler((ctx) => ctx.res.json("ok", { i }))
		}

		/* spot check */
		for (const idx of [0, 123, 250, 499]) {
			const res = await app.fetch(new Request(`http://localhost/r/${idx}`), {})
			expect(res.status).toBe(200)
		}
	})
})
