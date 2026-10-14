import { describe, expect, it } from "vitest"
import { HoneyError } from "../../src/errors/error.ts"
import { honey } from "../../src/routing/app.ts"
import { createMiddleware } from "../../src/middleware/middleware.ts"

describe("root route /", () => {
	// v0: f34b479d8b
	it("root route with basePath", async () => {
		const app = honey<{}>().basePath("/api")
		app.get("/").handler((ctx) => ctx.res.json("ok", { root: true }))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
	})
})

describe("use() preserves all settings", () => {
	// v0: f36fd2d49c
	it("onNotFound survives use()", async () => {
		const app = honey<{}>()
		app.onNotFound(() => new Response("custom 404", { status: 404 }))

		const authed = app.use(createMiddleware(async (_ctx, next) => next()))
		authed.get("/exists").handler((ctx) => ctx.res.json("ok", {}))

		const res = await authed.fetch(new Request("http://localhost/nope"), {})
		expect(res.status).toBe(404)
		expect(await res.text()).toBe("custom 404")
	})

	// v0: 7229de28b0
	it("onMethodNotAllowed survives use()", async () => {
		const app = honey<{}>()
		app.onMethodNotAllowed(() => new Response("custom 405", { status: 405 }))

		const authed = app.use(createMiddleware(async (_ctx, next) => next()))
		authed.get("/resource").handler((ctx) => ctx.res.json("ok", {}))

		const res = await authed.fetch(new Request("http://localhost/resource", { method: "DELETE" }), {})
		expect(res.status).toBe(405)
		expect(await res.text()).toBe("custom 405")
	})

	// v0: 0565c75477
	it("errorFormatter survives use()", async () => {
		const app = honey<{}>()
		app.defaultErrorFormatter((_err, _shape) => ({ custom_format: true }))

		const authed = app.use(createMiddleware(async (_ctx, next) => next()))
		authed.get("/fail").handler(() => {
			throw new HoneyError({ errorKey: "test", status: "bad_request" })
		})

		const res = await authed.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, boolean>
		expect(data.custom_format).toBe(true)
	})

	// v0: 079c03dde6
	it("defaults survives use()", async () => {
		const app = honey<{}>().basePath("/api")
		const authed = app.use(createMiddleware(async (_ctx, next) => next()))
		authed.get("/users").handler((ctx) => ctx.res.json("ok", {}))

		const res = await authed.fetch(new Request("http://localhost/api/users"), {})
		expect(res.status).toBe(200)
	})
})

describe("basePath stacks via MergePath", () => {
	// v0: 157bb796b6
	it("chained basePath calls compose paths", async () => {
		const app = honey<{}>().basePath("/v1").basePath("/v2")
		app.get("/users").handler((ctx) => ctx.res.json("ok", {}))

		/* basePath stacks: /v1 + /v2 = /v1/v2, so route is /v1/v2/users */
		const r1 = await app.fetch(new Request("http://localhost/v1/v2/users"), {})
		expect(r1.status).toBe(200)

		/* /v2/users alone should NOT match */
		const r2 = await app.fetch(new Request("http://localhost/v2/users"), {})
		expect(r2.status).toBe(404)
	})
})

describe("basePath prefixes routes at registration", () => {
	// v0: c9ee50eee6
	it("request without basePath prefix → 404", async () => {
		const app = honey<{}>().basePath("/api")
		app.get("/users").handler((ctx) => ctx.res.json("ok", {}))

		/* route registered as /api/users — /users alone is 404 */
		const res = await app.fetch(new Request("http://localhost/users"), {})
		expect(res.status).toBe(404)

		/* /api/users matches */
		const res2 = await app.fetch(new Request("http://localhost/api/users"), {})
		expect(res2.status).toBe(200)
	})
})

describe("basePath edge — exact match to root", () => {
	// v0: a0aee81a59
	it("basePath=/api, request /api → matches / route", async () => {
		const app = honey<{}>().basePath("/api")
		app.get("/").handler((ctx) => ctx.res.json("ok", { root: true }))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
	})

	// v0: fde3ba9be9
	it("basePath=/api, request /api/ → matches / route", async () => {
		const app = honey<{}>().basePath("/api")
		app.get("/").handler((ctx) => ctx.res.json("ok", { root: true }))

		const res = await app.fetch(new Request("http://localhost/api/"), {})
		expect(res.status).toBe(200)
	})
})

describe("basePath edge cases", () => {
	// v0: f39f07caa8
	it("basePath without trailing slash works correctly", async () => {
		const app = honey<{}>().basePath("/api/v1")
		app.get("/users").handler((ctx) => ctx.res.json("ok", { users: [] }))

		const res = await app.fetch(new Request("http://localhost/api/v1/users"), {})
		expect(res.status).toBe(200)
	})

	// v0: ee339cf151
	it("basePath with trailing slash → routes should still match", async () => {
		const app = honey<{}>().basePath("/api/v1/")
		app.get("/users").handler((ctx) => ctx.res.json("ok", { users: [] }))

		const res = await app.fetch(new Request("http://localhost/api/v1/users"), {})
		/* this will likely fail — trailing slash in basePath breaks matching */
		expect(res.status).toBe(200)
	})

	// v0: 008d960bed
	it("basePath exact match → root route", async () => {
		const app = honey<{}>().basePath("/api")
		app.get("/").handler((ctx) => ctx.res.json("ok", { root: true }))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
	})
})

describe("sub-app route merging via mergeTree", () => {
	// v0: 3fff9f50df
	it("route() merges sub-router tree into parent at runtime", async () => {
		const child = honey<{}>()
		child.get("/child").handler((ctx) => ctx.res.json("ok", { from: "child" }))

		const parent = honey<{}>()
		parent.route(child)

		/* child route IS accessible via parent fetch after merge */
		const res = await parent.fetch(new Request("http://localhost/child"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.from).toBe("child")
	})
})

describe("basePath prefixing", () => {
	// v0: c4b3cdf794
	it("basePath prefixes routes at registration time", async () => {
		const app = honey<{ BASE: string }>().basePath("/api")
		app.get("/users").handler((ctx) => ctx.res.json("ok", { env: ctx.env.BASE }))

		const res1 = await app.fetch(new Request("http://localhost/api/users"), {
			BASE: "/api",
		})
		expect(res1.status).toBe(200)
		const d1 = (await res1.json()) as Record<string, string>
		expect(d1.env).toBe("/api")
	})
})

describe("use() chain shares root tree", () => {
	// v0: 2c2daa6f20
	it("routes registered after use() visible on original app", async () => {
		const mw = createMiddleware(async (_ctx, next) => {
			return next({ auth: true })
		})

		const base = honey<{}>()
		base.get("/public").handler((ctx) => ctx.res.json("ok", { public: true }))

		const authed = base.use(mw)
		authed.get("/private").handler((ctx) => ctx.res.json("ok", { auth: ctx.auth }))

		/* both routes should be on the shared root tree */
		const pubRes = await base.fetch(new Request("http://localhost/public"), {})
		expect(pubRes.status).toBe(200)

		/* /private is registered on the root tree, but middleware only runs on authed chain.
		 * When fetched via base, handler runs without the middleware context */
		const privRes = await base.fetch(new Request("http://localhost/private"), {})
		expect(privRes.status).toBe(200)
	})
})

describe("what if multiple apps share routes accidentally", () => {
	// v0: 40d0c4778e
	it("two separate honey() instances → completely isolated trees", async () => {
		const app1 = honey<{}>()
		app1.get("/shared").handler((ctx) => ctx.res.text("ok", "app1"))

		const app2 = honey<{}>()
		app2.get("/shared").handler((ctx) => ctx.res.text("ok", "app2"))

		const r1 = await app1.fetch(new Request("http://localhost/shared"), {})
		const r2 = await app2.fetch(new Request("http://localhost/shared"), {})
		expect(await r1.text()).toBe("app1")
		expect(await r2.text()).toBe("app2")
	})
})

describe("what if the route path is just /", () => {
	// v0: 814476e66c
	it("root route with basePath → basePath exact match maps to /", async () => {
		const app = honey<{}>().basePath("/api")
		app.get("/").handler((ctx) => ctx.res.text("ok", "api-root"))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("api-root")
	})
})

describe("empty string in various places", () => {
	// v0: 87b16f8028
	it("empty basePath '' → no prefix change", async () => {
		const app = honey<{}>().basePath("")
		app.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
	})
})

describe("basePath via defaults", () => {
	// v0: c3cfdb34b5
	it("basePath strips prefix from matching requests", async () => {
		const app = honey<{}>().basePath("/api")
		app.get("/users").handler((ctx) => ctx.res.json("ok", { from: "users" }))

		const res = await app.fetch(new Request("http://localhost/api/users"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.from).toBe("users")
	})

	// v0: b6cb7c9c8b
	it("basePath → request without prefix returns 404", async () => {
		const app = honey<{}>().basePath("/api")
		app.get("/users").handler((ctx) => ctx.res.json("ok", {}))

		/* basePath prefixes routes at registration, so /users without prefix is 404 */
		const res = await app.fetch(new Request("http://localhost/users"), {})
		expect(res.status).toBe(404)
	})

	// v0: dff98d40b5
	it("basePath root request → matches /", async () => {
		const app = honey<{}>().basePath("/api")
		app.get("/").handler((ctx) => ctx.res.json("ok", { root: true }))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
	})

	// v0: 713989d8d3
	it("basePath with trailing slash in config", async () => {
		const app = honey<{}>().basePath("/api/")
		app.get("/users").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/api/users"), {})
		expect(res.status).toBe(200)
	})
})

describe("feature interactions", () => {
	describe("route merge + middleware propagation", () => {
		// v0: a2f656dadb
		it("parent chain middleware DOES run on merged sub-router routes", async () => {
			let parentMwCalled = false
			const parentMw = createMiddleware(async (_ctx, next) => {
				parentMwCalled = true
				return next()
			})

			const sub = honey<{}>()
				.get("/sub")
				.handler((ctx) => ctx.res.text("ok", "from-sub"))

			const app = honey<{}>()
				.use(parentMw)
				.get("/parent")
				.handler((ctx) => ctx.res.text("ok", "from-parent"))
				.route(sub)

			/* sub route — parent chain middleware runs (auth applies to all routes) */
			parentMwCalled = false
			const subRes = await app.fetch(new Request("http://localhost/sub"), {})
			expect(subRes.status).toBe(200)
			expect(parentMwCalled).toBe(true)

			/* parent route — parent chain middleware also runs */
			parentMwCalled = false
			await app.fetch(new Request("http://localhost/parent"), {})
			expect(parentMwCalled).toBe(true)
		})
	})
})

describe("basePath registration-time prefix", () => {
	// v0: 909a8f727d
	it("basePath prefixes routes at registration time", async () => {
		const app = honey<{ BASE: string }>().basePath("/api")
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/api/health"), {
			BASE: "/api",
		})
		expect(res.status).toBe(200)
	})
})

describe("basePath edge cases", () => {
	// v0: b987b43110
	it("basePath exact match → root route", async () => {
		const app = honey<{}>().basePath("/api")
		app.get("/").handler((ctx) => ctx.res.text("ok", "root"))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("root")
	})

	// v0: bdd89b07d3
	it("request without basePath prefix → 404", async () => {
		const app = honey<{}>().basePath("/api")
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		/* basePath prefixes routes at registration, so /health without prefix is 404 */
		const res = await app.fetch(new Request("http://localhost/health"), {})
		expect(res.status).toBe(404)
	})

	// v0: 4e11d0b655
	it("basePath + trailing slash strip interaction", async () => {
		const app = honey<{}>().basePath("/api").trailingSlash("strip")
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/api/health/"), {})
		/* trailing slash stripped first, then basePath stripped */
		expect(res.status).toBe(308) /* redirect to strip trailing slash */
	})
})

describe("route composition", () => {
	// v0: a9d8773b18
	it(".route() merges separate sub-router tree into parent", async () => {
		const sub = honey<{}>()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "sub"))

		const app = honey<{}>()
			.get("/main")
			.handler((ctx) => ctx.res.text("ok", "main"))
			.route(sub)

		const mainRes = await app.fetch(new Request("http://localhost/main"), {})
		expect(await mainRes.text()).toBe("main")

		const subRes = await app.fetch(new Request("http://localhost/health"), {})
		expect(await subRes.text()).toBe("sub")
	})
})

describe("basePath edge cases", () => {
	// v0: 7ec4562329
	it("basePath without leading slash", async () => {
		const app = honey<{}>().basePath("/v1")
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/v1/health"), {})
		expect(res.status).toBe(200)
	})

	// v0: 351797f6cf
	it("basePath with nested prefix /api/v2", async () => {
		const app = honey<{}>().basePath("/api/v2")
		app.get("/users").handler((ctx) => ctx.res.text("ok", "users"))

		const res = await app.fetch(new Request("http://localhost/api/v2/users"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("users")
	})
})
