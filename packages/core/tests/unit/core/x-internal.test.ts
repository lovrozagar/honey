import { describe, expect, expectTypeOf, it } from "vitest"
import * as z from "zod"
import { generateOpenApi, generateTypes } from "../../../src/codegen.ts"
import { createMiddleware, honey } from "../../../src/index.ts"
import type { InferRoutes } from "../../../src/types.ts"

type AppMeta = { security?: string; tags?: string }

describe("x-internal routes — runtime", () => {
	it("internal route still responds to HTTP requests", async () => {
		const app = honey<{}>()
			.meta<AppMeta>()

		app
			.get("/health")
			.meta({ internal: true })
			.handler((ctx) => ctx.res.json("ok", { status: "healthy" }))

		const res = await app.fetch(new Request("http://localhost/health"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.status).toBe("healthy")
	})

	it("ctx.meta['x-internal'] is true in handler", async () => {
		const app = honey<{}>().meta<AppMeta>()

		app
			.get("/health")
			.meta({ internal: true })
			.handler((ctx) =>
				ctx.res.json("ok", { internal: ctx.meta.internal }),
			)

		const res = await app.fetch(new Request("http://localhost/health"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.internal).toBe(true)
	})

	it("chain-level x-internal applies to all downstream routes", async () => {
		const internal = honey<{}>()
			.meta<AppMeta>()
			.meta({ internal: true })

		internal
			.get("/metrics")
			.handler((ctx) =>
				ctx.res.json("ok", { internal: ctx.meta.internal }),
			)
		internal
			.get("/debug")
			.handler((ctx) =>
				ctx.res.json("ok", { internal: ctx.meta.internal }),
			)

		const r1 = await internal.fetch(
			new Request("http://localhost/metrics"),
			{},
		)
		expect((await r1.json() as Record<string, unknown>).internal).toBe(true)

		const r2 = await internal.fetch(
			new Request("http://localhost/debug"),
			{},
		)
		expect((await r2.json() as Record<string, unknown>).internal).toBe(true)
	})

	it("public and internal routes coexist on same app", async () => {
		const app = honey<{}>().meta<AppMeta>()

		app
			.get("/api/users")
			.meta({ operationId: "user.list", tags: "Users" })
			.handler((ctx) => ctx.res.json("ok", { users: [] }))

		app
			.get("/health")
			.meta({ internal: true })
			.handler((ctx) => ctx.res.json("ok", { ok: true }))

		const r1 = await app.fetch(
			new Request("http://localhost/api/users"),
			{},
		)
		expect(r1.status).toBe(200)

		const r2 = await app.fetch(
			new Request("http://localhost/health"),
			{},
		)
		expect(r2.status).toBe(200)
	})
})

describe("x-internal routes — type exclusion", () => {
	it("InferRoutes excludes x-internal routes", () => {
		/* must capture .handler() return to track route types */
		const step1 = honey<{}>()
			.meta<AppMeta>()
			.get("/api/users")
			.meta({ operationId: "user.list" })
			.output({
				"application/json": {
					ok: z.object({ users: z.array(z.string()) }),
				},
			})
			.handler((ctx) => ctx.res.json("ok", { users: [] }))

		const step2 = step1
			.get("/health")
			.meta({ internal: true })
			.handler((ctx) => ctx.res.json("ok", { ok: true }))

		type Routes = InferRoutes<typeof step2>

		/* public route present */
		type HasUsers = Routes extends { "/api/users": unknown } ? true : false
		expectTypeOf<HasUsers>().toEqualTypeOf<true>()

		/* internal route absent */
		type HasHealth = Routes extends { "/health": unknown } ? true : false
		expectTypeOf<HasHealth>().toEqualTypeOf<false>()
	})

	it("chain-level x-internal excludes all downstream from InferRoutes", () => {
		const base = honey<{}>()
			.meta<AppMeta>()
			.get("/api/users")
			.meta({ operationId: "user.list" })
			.handler((ctx) => ctx.res.json("ok", {}))

		const internal = base.meta({ internal: true })

		const step2 = internal
			.get("/metrics")
			.handler((ctx) => ctx.res.json("ok", {}))

		const step3 = step2
			.get("/debug")
			.handler((ctx) => ctx.res.json("ok", {}))

		type Routes = InferRoutes<typeof step3>

		type HasUsers = Routes extends { "/api/users": unknown } ? true : false
		expectTypeOf<HasUsers>().toEqualTypeOf<true>()

		type HasMetrics = Routes extends { "/metrics": unknown } ? true : false
		expectTypeOf<HasMetrics>().toEqualTypeOf<false>()

		type HasDebug = Routes extends { "/debug": unknown } ? true : false
		expectTypeOf<HasDebug>().toEqualTypeOf<false>()
	})

	it("x-internal with middleware — still excluded from types", () => {
		const mw = createMiddleware(async (_ctx, next) => next({ added: true }))

		const step1 = honey<{}>()
			.meta<AppMeta>()
			.use(mw)
			.get("/public")
			.handler((ctx) => ctx.res.json("ok", {}))

		const step2 = step1
			.get("/x-internal")
			.meta({ internal: true })
			.handler((ctx) => ctx.res.json("ok", {}))

		type Routes = InferRoutes<typeof step2>

		type HasPublic = Routes extends { "/public": unknown } ? true : false
		expectTypeOf<HasPublic>().toEqualTypeOf<true>()

		type HasInternal = Routes extends { "/x-internal": unknown } ? true : false
		expectTypeOf<HasInternal>().toEqualTypeOf<false>()
	})
})

describe("x-internal routes — codegen inclusion", () => {
	it("generateOpenApi INCLUDES meta.internal routes (path-D semantics)", async () => {
		const app = honey<{}>().meta<AppMeta>()

		app
			.get("/api/users")
			.meta({ operationId: "user.list", tags: "Users" })
			.handler((ctx) => ctx.res.json("ok", {}))

		app
			.get("/health")
			.meta({ internal: true })
			.handler((ctx) => ctx.res.json("ok", {}))

		const spec = await generateOpenApi(app, {
			info: { title: "Test", version: "1.0.0" },
		})

		const paths = spec.paths as Record<string, unknown>
		expect(paths["/api/users"]).toBeTruthy()
		expect(paths["/health"]).toBeTruthy()
	})

	it("chain-level meta.internal also INCLUDED in OpenAPI", async () => {
		const app = honey<{}>().meta<AppMeta>()

		app
			.get("/api/users")
			.meta({ operationId: "user.list" })
			.handler((ctx) => ctx.res.json("ok", {}))

		const internal = app.meta({ internal: true })
		internal
			.get("/metrics")
			.meta({ operationId: "metrics.get" })
			.handler((ctx) => ctx.res.json("ok", {}))

		const spec = await generateOpenApi(app, {
			info: { title: "Test", version: "1.0.0" },
		})

		const paths = spec.paths as Record<string, unknown>
		expect(paths["/api/users"]).toBeTruthy()
		expect(paths["/metrics"]).toBeTruthy()
	})

	it("generateTypes INCLUDES x-internal routes (services need RouteCtx)", () => {
		const app = honey<{}>().meta<AppMeta>()

		app
			.get("/api/users")
			.meta({ operationId: "user.list" })
			.handler((ctx) => ctx.res.json("ok", {}))

		app
			.get("/health")
			.meta({ internal: true })
			.handler((ctx) => ctx.res.json("ok", {}))

		const code = generateTypes(app, { inlineEnvType: "{}" })

		expect(code).toContain('"/api/users"')
		expect(code).toContain('"/health"')
	})

	it("generateTypes INCLUDES chain-level x-internal routes", () => {
		const app = honey<{}>().meta<AppMeta>()

		app
			.get("/api/users")
			.handler((ctx) => ctx.res.json("ok", {}))

		const internal = app.meta({ internal: true })
		internal.get("/metrics").handler((ctx) => ctx.res.json("ok", {}))

		const code = generateTypes(app, { inlineEnvType: "{}" })

		expect(code).toContain('"/api/users"')
		expect(code).toContain('"/metrics"')
	})
})
