/**
 * Chain `.meta(values)` and what a route must still pass (bit 22 a): a key the chain set is optional on every
 * route under that handle, a key nothing set stays as declared, and an unknown key is still refused. Declaring the
 * meta type and setting defaults takes two calls — `metaType<AppMeta>().meta({ … })` — so the values keep their literal
 * types. Checked by typecheck.
 */
import { describe, expectTypeOf, it } from "vitest"
import type { InferMeta, InferRoutes } from "../../src/routing/app-types.ts"
import type { ChainSupplied } from "../../src/routing/meta-types.ts"
import { honey } from "../../src/routing/app.ts"

type AppMeta = { tenant?: "organization" | "project"; worker: "extract" }

describe("a declared meta type, its defaults set by a second call", () => {
	const app = honey<{}>().metaType<AppMeta>().meta({ worker: "extract" })

	it("lets a route omit the keys the chain set", () => {
		app
			.get("/tables")
			.meta({ summary: "List tables" })
			.handler((ctx) => {
				expectTypeOf(ctx.meta).toExtend<{ readonly worker: "extract" }>()
				return ctx.res.text("ok", "ok")
			})
	})

	it("carries the declared type into the route's ctx", () => {
		app
			.get("/tables")
			.meta({ summary: "List tables" })
			.handler((ctx) => {
				expectTypeOf(ctx.meta.worker).toEqualTypeOf<"extract">()
				return ctx.res.text("ok", "ok")
			})
	})

	it("narrows a key the route sets itself", () => {
		app
			.get("/tables")
			.meta({ tenant: "project" })
			.handler((ctx) => {
				expectTypeOf(ctx.meta.tenant).toEqualTypeOf<"project">()
				expectTypeOf(ctx.meta.worker).toEqualTypeOf<"extract">()
				return ctx.res.text("ok", "ok")
			})
	})

	it("still refuses a key nothing declares", () => {
		expectTypeOf<ChainSupplied<InferMeta<typeof app>>>().not.toHaveProperty("nope")
		app
			.get("/tables")
			// @ts-expect-error `nope` is in neither the declared meta nor the OpenAPI keys
			.meta({ nope: 1 })
			.handler((ctx) => ctx.res.text("ok", "ok"))
	})
})

describe("a key no chain value sets", () => {
	it("stays required on the route when another key was defaulted", () => {
		const defaulted = honey<{}>().metaType<AppMeta>().meta({ tenant: "project" })
		expectTypeOf<ChainSupplied<InferMeta<typeof defaulted>>>().toExtend<{ worker: "extract" }>()
		defaulted
			.get("/tables")
			// @ts-expect-error `worker` is required and no chain value supplies it
			.meta({ summary: "List tables" })
			.handler((ctx) => ctx.res.text("ok", "ok"))
	})

	it("stays required when the handle sets no default at all", () => {
		const declared = honey<{}>().metaType<AppMeta>()
		expectTypeOf<ChainSupplied<InferMeta<typeof declared>>>().toExtend<{ worker: "extract" }>()
		declared
			.get("/tables")
			// @ts-expect-error `worker` is required and the handle sets no default
			.meta({ summary: "List tables" })
			.handler((ctx) => ctx.res.text("ok", "ok"))
	})
})

describe("metaType<T>() declares, meta(values) sets", () => {
	type Wide = { tenant?: string; worker?: string }

	it("keeps a value's literal type without `as const`: `internal: true` stays true, so its routes leave the map", () => {
		const app = honey<{}>()
			.metaType<Wide>()
			.meta({ internal: true, worker: "extract" })
			.get("/hidden")
			.handler((ctx) => ctx.res.text("ok", "ok"))
		expectTypeOf<keyof InferRoutes<typeof app>>().toBeNever()
	})

	it("declares the type alone, the handle otherwise unchanged", () => {
		const app = honey<{}>()
		expectTypeOf<InferMeta<ReturnType<typeof app.metaType<AppMeta>>>>().toEqualTypeOf<AppMeta>()
		// @ts-expect-error meta() takes values only; the type goes through metaType<T>()
		app.meta()
	})
})

describe("a meta type inferred from the chain's values", () => {
	it("lets a route omit them and still refuses an unknown key", () => {
		const app = honey<{}>().meta({ tenant: "project" as const, worker: "extract" as const })
		app
			.get("/a")
			.meta({ summary: "A" })
			.handler((ctx) => {
				expectTypeOf(ctx.meta.summary).toEqualTypeOf<string>()
				return ctx.res.text("ok", "a")
			})
		app
			.get("/b")
			// @ts-expect-error `nope` is in neither the inferred meta nor the OpenAPI keys
			.meta({ nope: 1 })
			.handler((ctx) => ctx.res.text("ok", "b"))
	})
})
