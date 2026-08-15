import { describe, expect, it } from "vitest"
import { z } from "zod"
import { generateOpenApi, generateRouteTreeFromApp } from "../../../src/codegen.ts"
import { createMiddleware, defineMiddleware, honey } from "../../../src/index.ts"
import { testClient } from "../../../src/testing.ts"

const INFO = { title: "Test", version: "1.0" }

const shard = createMiddleware(async (_ctx, next) => next({ shard: 1 }), { meta: { tenant: "project_id" } })
const audit = createMiddleware(async (_ctx, next) => next({}), { meta: { permissions: ["audit"] } })

function op(spec: Awaited<ReturnType<typeof generateOpenApi>>, path: string): Record<string, unknown> {
	return spec.paths[path]?.get as Record<string, unknown>
}

function policyApp() {
	const app = honey<{}>().meta<{ permissions?: string[]; tenant?: string }>()
	app.metaSpec({
		meta: { permissions: "x-permissions", tenant: { key: "x-tenant", map: (v) => ({ column: v }) } },
	})
	return app
}

describe("middleware-contributed meta", () => {
	it("a chain middleware contributes meta to every route below it", async () => {
		const app = policyApp()
		app
			.use(shard)
			.get("/articles")
			.handler((c) => c.res.json("ok", {}))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(op(spec, "/articles")["x-tenant"]).toEqual({ column: "project_id" })
	})

	it("a route-level .use() contributes to that route only", async () => {
		const app = policyApp()
		app
			.get("/audited")
			.use(audit)
			.handler((c) => c.res.json("ok", {}))
		app.get("/plain").handler((c) => c.res.json("ok", {}))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(op(spec, "/audited")["x-permissions"]).toEqual(["audit"])
		expect(op(spec, "/plain")).not.toHaveProperty("x-permissions")
	})

	it("route .meta() outranks a contributed value", async () => {
		const app = policyApp()
		app
			.use(shard)
			.get("/override")
			.meta({ tenant: "explicit" })
			.handler((c) => c.res.json("ok", {}))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(op(spec, "/override")["x-tenant"]).toEqual({ column: "explicit" })
	})

	it("chain .meta() outranks a contributed value", async () => {
		const app = policyApp()
		app
			.use(shard)
			.meta({ tenant: "from-chain" })
			.get("/chain")
			.handler((c) => c.res.json("ok", {}))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(op(spec, "/chain")["x-tenant"]).toEqual({ column: "from-chain" })
	})

	it("a later middleware overrides an earlier one", async () => {
		const first = createMiddleware(async (_c, n) => n({}), { meta: { tenant: "first" } })
		const second = createMiddleware(async (_c, n) => n({}), { meta: { tenant: "second" } })
		const app = policyApp()
		app
			.use(first)
			.use(second)
			.get("/a")
			.handler((c) => c.res.json("ok", {}))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(op(spec, "/a")["x-tenant"]).toEqual({ column: "second" })
	})

	it("a path-scoped middleware reaches routes registered before it", async () => {
		const app = policyApp()
		app.get("/late/thing").handler((c) => c.res.json("ok", {}))
		app.get("/other/thing").handler((c) => c.res.json("ok", {}))
		app.use("/late", shard)
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(op(spec, "/late/thing")["x-tenant"]).toEqual({ column: "project_id" })
		expect(op(spec, "/other/thing")).not.toHaveProperty("x-tenant")
	})

	it("back-filling a scoped middleware does not clobber explicit route meta", async () => {
		const app = policyApp()
		app
			.get("/late/thing")
			.meta({ tenant: "explicit" })
			.handler((c) => c.res.json("ok", {}))
		app.use("/late", shard)
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(op(spec, "/late/thing")["x-tenant"]).toEqual({ column: "explicit" })
	})

	it("a middleware with no meta contributes nothing", async () => {
		const plain = createMiddleware(async (_c, n) => n({}))
		const app = policyApp()
		app
			.use(plain)
			.get("/a")
			.handler((c) => c.res.json("ok", {}))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(Object.keys(op(spec, "/a"))).toEqual(["responses"])
	})

	it("defineMiddleware carries meta too", async () => {
		const mw = defineMiddleware({ fn: async (_c, n) => n({}), meta: { tenant: "defined" } })
		const app = policyApp()
		app
			.use(mw)
			.get("/a")
			.handler((c) => c.res.json("ok", {}))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(op(spec, "/a")["x-tenant"]).toEqual({ column: "defined" })
	})

	it("contributed meta is subject to the policy — an unmapped key fails the build", async () => {
		const sla = createMiddleware(async (_c, n) => n({}), { meta: { sla: "gold" } })
		const app = honey<{}>()
		app.metaSpec({ meta: {}, strict: "error" })
		app
			.use(sla)
			.get("/a")
			.handler((c) => c.res.json("ok", {}))
		await expect(generateOpenApi(app as never, { info: INFO })).rejects.toThrow(/MISSING_ENTRY.*"sla"/s)
	})

	it("contributed meta can be hidden like any other key", async () => {
		const app = honey<{}>()
		app.metaSpec({ meta: { tenant: false }, strict: "error" })
		app
			.use(shard)
			.get("/a")
			.handler((c) => c.res.json("ok", {}))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(JSON.stringify(op(spec, "/a"))).not.toMatch(/tenant|project_id/)
	})

	it('rejects "internal" — a middleware must not remove routes from generated artifacts', () => {
		expect(() => createMiddleware(async (_c, n) => n({}), { meta: { internal: true } })).toThrow(
			/cannot set "internal"/,
		)
		expect(() => defineMiddleware({ fn: async (_c, n) => n({}), meta: { internal: false } })).toThrow(
			/cannot set "internal"/,
		)
	})
})

describe("middleware meta and the static route tree", () => {
	it("is visible at runtime on ctx.meta", async () => {
		const app = honey<{}>()
		app
			.use(shard)
			.get("/a")
			.handler((c) => c.res.json("ok", { meta: c.meta }))
		const client = testClient(app, { env: {} })
		const res = await client.get("/a")
		expect(await res.json()).toEqual({ meta: { tenant: "project_id" } })
	})

	it("is baked into the generated route tree, not re-derived at request time", () => {
		const app = honey<{}>()
		app
			.use(shard)
			.get("/a")
			.handler((c) => c.res.json("ok", {}))
		const generated = generateRouteTreeFromApp(app as never)
		expect(generated).toContain('mt: {"tenant":"project_id"}')
		/* middleware itself is never serialized — the baked meta is the whole record */
		expect(generated).toContain("mw: []")
	})

	it("survives a route that also declares input/output schemas", async () => {
		const app = policyApp()
		app
			.use(shard)
			.get("/a")
			.input({ search: z.object({ q: z.string().optional() }) })
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((c) => c.res.json("ok", { id: "1" }))
		const spec = await generateOpenApi(app as never, { info: INFO })
		expect(op(spec, "/a")["x-tenant"]).toEqual({ column: "project_id" })
	})
})
