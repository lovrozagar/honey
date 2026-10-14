/**
 * Scoped middleware, use(path, mw), as typed: which routes see a scope's additions, scopes beside
 * chain middleware, requirements and registration order, the chain's own types left untouched by
 * a scope, mounted subs, and the positional generics older code spells out. Checked by typecheck.
 */
import { describe, expectTypeOf, it } from "vitest"
import type { HoneyContext } from "../../src/context/context.ts"
import { defineErrors } from "../../src/errors/errors.ts"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { type Honey, honey } from "../../src/routing/app.ts"
import type {
	InferBasePath,
	InferCtx,
	InferEnv,
	InferErrorFactory,
	InferMeta,
	InferRoutes,
} from "../../src/routing/app-types.ts"

const adminMw = createMiddleware((_ctx, next) => next({ adminOnly: "yes" }))
const billingMw = createMiddleware((_ctx, next) => next({ billing: 42 }))
const globalMw = createMiddleware((_ctx, next) => next({ globalField: "global" }))
const dbMw = createMiddleware((_ctx, next) => next({ db: { query: (): unknown[] => [] } }))

describe("which routes see a scope's additions", () => {
	// v0: 220e22f5db
	// v0: 59825a6a62
	// v0: 1e022ce9b3
	// v0: 6f6e5f1fa0
	// v0: 2378fb5d62
	it("a route the scope covers sees them, its exact prefix included; a route outside it does not", () => {
		const app = honey<{}>().use("/admin", adminMw)
		for (const covered of ["/admin", "/admin/x"] as const)
			app.get(covered).handler((ctx) => {
				expectTypeOf(ctx.adminOnly).toEqualTypeOf<string>()
				return ctx.res.text("ok", "covered")
			})
		app.get("/administration").handler((ctx) => {
			expectTypeOf(ctx).not.toHaveProperty("adminOnly")
			return ctx.res.text("ok", "segment boundary")
		})
		app.get("/public").handler((ctx) => {
			expectTypeOf(ctx).not.toHaveProperty("adminOnly")
			return ctx.res.text("ok", "outside")
		})
		honey<{}>()
			.use("/", adminMw)
			.get("/any")
			.handler((ctx) => {
				expectTypeOf(ctx.adminOnly).toEqualTypeOf<string>()
				return ctx.res.text("ok", "root scope covers all")
			})
	})
	// v0: 9f44961611
	// v0: c3a74f4b4c
	it("overlapping scopes compose on the deep route, and only the covering ones type a shallow route", () => {
		const app = honey<{}>().use("/admin", adminMw).use("/admin/billing", billingMw)
		app.get("/admin/billing/x").handler((ctx) => {
			expectTypeOf(ctx.adminOnly).toEqualTypeOf<string>()
			expectTypeOf(ctx.billing).toEqualTypeOf<number>()
			return ctx.res.text("ok", "deep")
		})
		app.get("/admin/users").handler((ctx) => {
			expectTypeOf(ctx.adminOnly).toEqualTypeOf<string>()
			expectTypeOf(ctx).not.toHaveProperty("billing")
			return ctx.res.text("ok", "shallow")
		})
	})

	// v0: f31e874f4a
	it("under a basePath, a scope covers the joined path", () => {
		const api = honey<{}>().basePath("/api").use("/admin", adminMw)
		api.get("/admin/x").handler((ctx) => {
			expectTypeOf(ctx.adminOnly).toEqualTypeOf<string>()
			return ctx.res.text("ok", "x")
		})
		api.get("/public").handler((ctx) => {
			expectTypeOf(ctx).not.toHaveProperty("adminOnly")
			return ctx.res.text("ok", "p")
		})
	})
})

describe("a scope path known only as a string", () => {
	// v0: 43f7136fef
	it("a scope path typed only as string covers no route's type: nothing can be proven covered", () => {
		const path: string = "/admin"
		const app = honey<{}>().use(path, adminMw)
		app.get("/admin/x").handler((ctx) => {
			expectTypeOf(ctx).not.toHaveProperty("adminOnly")
			return ctx.res.text("ok", "unproven")
		})
		app.get("/unrelated").handler((ctx) => {
			expectTypeOf(ctx).not.toHaveProperty("adminOnly")
			return ctx.res.text("ok", "outside")
		})
	})
})

describe("scopes beside chain middleware", () => {
	// v0: fa8a155692
	// v0: e265fd184b
	// v0: 6ef67d8f0c
	it("chain additions type every route, scoped ones only the covered routes", () => {
		const app = honey<{}>().use(globalMw).use("/admin", adminMw)
		expectTypeOf<InferCtx<typeof app>>().toMatchTypeOf<{ globalField: string }>()
		app.get("/admin/x").handler((ctx) => {
			expectTypeOf(ctx.globalField).toEqualTypeOf<string>()
			expectTypeOf(ctx.adminOnly).toEqualTypeOf<string>()
			return ctx.res.text("ok", "x")
		})
		app.get("/public").handler((ctx) => {
			expectTypeOf(ctx.globalField).toEqualTypeOf<string>()
			expectTypeOf(ctx).not.toHaveProperty("adminOnly")
			return ctx.res.text("ok", "p")
		})
	})

	// v0: 79fd0c5de3
	// v0: 55aa6abb32
	it("use(mw) and use(path, mw) resolve their overloads in any combination", () => {
		expectTypeOf(honey<{}>().use(globalMw)).toHaveProperty("get")
		expectTypeOf(honey<{}>().use("/x", adminMw)).toHaveProperty("get")
		expectTypeOf(honey<{}>().use("/x" as const, adminMw)).toHaveProperty("get")
		expectTypeOf(honey<{}>().use(globalMw).use("/admin", adminMw)).toHaveProperty("get")
	})

	// v0: c2127ed92f
	it("a deep route's ctx is the whole composition: the request ctx, chain additions and every covering scope", () => {
		honey<{}>()
			.use(dbMw)
			.use("/admin", adminMw)
			.use("/admin/billing", billingMw)
			.get("/admin/billing/invoices")
			.handler((ctx) => {
				expectTypeOf(ctx).toMatchTypeOf<
					HoneyContext<{}> & { adminOnly: string; billing: number; db: { query: () => unknown[] } }
				>()
				return ctx.res.text("ok", "x")
			})
	})
})

describe("requirements and registration order", () => {
	// v0: bb446fe17c
	it("a scoped middleware's requirements are checked where use(path, mw) is called", () => {
		const needsDb = createMiddleware((ctx: { db: { query: () => unknown[] } }, next) => {
			void ctx.db
			return next({ userId: "u-1" })
		})
		// @ts-expect-error the chain does not provide db
		honey<{}>().use("/admin", needsDb)
		honey<{}>()
			.use(dbMw)
			.use("/admin", needsDb)
			.get("/admin/x")
			.handler((ctx) => {
				expectTypeOf(ctx.userId).toEqualTypeOf<string>()
				return ctx.res.text("ok", "x")
			})
	})

	// v0: 5585fcebc8
	it("a route registered before use(path, mw) is not typed with that scope", () => {
		const before = honey<{}>()
			.get("/admin/x")
			.handler((ctx) => {
				expectTypeOf(ctx).not.toHaveProperty("adminOnly")
				return ctx.res.text("ok", "x")
			})
		before
			.use("/admin", adminMw)
			.get("/admin/y")
			.handler((ctx) => {
				expectTypeOf(ctx.adminOnly).toEqualTypeOf<string>()
				return ctx.res.text("ok", "y")
			})
	})
})

describe("a scope leaves the chain's own types alone", () => {
	// v0: 3625f5b63b
	// v0: d073246b66
	// v0: 528d66bfcb
	// v0: d593097878
	it("InferCtx, $ctx and every other Infer* are the same with or without the scope", () => {
		const errors = defineErrors({ err: "internal_server_error" })
		const plain = honey<{}>().errorFactory(errors).defaultErrors("err").basePath("/api").meta({ version: 1 })
		const scoped = plain.use("/admin", adminMw)
		expectTypeOf<InferCtx<typeof scoped>>().not.toMatchTypeOf<{ adminOnly: string }>()
		expectTypeOf<(typeof scoped)["$ctx"]>().not.toMatchTypeOf<{ adminOnly: string }>()
		expectTypeOf<InferCtx<typeof scoped>>().toEqualTypeOf<InferCtx<typeof plain>>()
		expectTypeOf<InferEnv<typeof scoped>>().toEqualTypeOf<InferEnv<typeof plain>>()
		expectTypeOf<InferMeta<typeof scoped>>().toEqualTypeOf<InferMeta<typeof plain>>()
		expectTypeOf<InferBasePath<typeof scoped>>().toEqualTypeOf<"/api">()
		expectTypeOf<InferErrorFactory<typeof scoped>>().toEqualTypeOf<typeof errors>()
		const served = scoped.get("/x").handler((ctx) => ctx.res.text("ok", "x"))
		expectTypeOf<InferRoutes<typeof served>>().toHaveProperty("/api/x")
	})
})

describe("mounted subs and positional generics", () => {
	// v0: 53d944bd37
	// v0: 141e489af6
	it("a sub's scopes type its own routes, not the parent's routes after the mount", () => {
		const sub = honey<{}>()
			.use("/x", adminMw)
			.get("/x/a")
			.handler((ctx) => {
				expectTypeOf(ctx.adminOnly).toEqualTypeOf<string>()
				return ctx.res.text("ok", "a")
			})
		honey<{}>()
			.route(sub)
			.get("/x/b")
			.handler((ctx) => {
				expectTypeOf(ctx).not.toHaveProperty("adminOnly")
				return ctx.res.text("ok", "b")
			})
	})

	// v0: d2adb9ab18
	// v0: 51db08872d
	// v0: 84c9f852a1
	it("Honey<> spelled with 8 positional generics is the 9-generic type, and honey() is Honey<Env>", () => {
		type Eight = Honey<{}, HoneyContext<{}>, {}, never, never, never, "/", {}>
		type Nine = Honey<{}, HoneyContext<{}>, {}, never, never, never, "/", {}, []>
		expectTypeOf<Eight>().toEqualTypeOf<Nine>()
		expectTypeOf(honey<{}>()).toEqualTypeOf<Honey<{}>>()
	})
})
