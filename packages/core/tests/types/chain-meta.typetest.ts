/**
 * Chain `.meta(values)` and what a route must still pass (bit 22 a): a key the chain set is optional on every
 * route under that handle, a key nothing set stays as declared, and an unknown key is still refused. Declaring the
 * meta type and setting defaults takes two calls — `meta<AppMeta>().meta({ … })` — because a call that gives the
 * type explicitly leaves TypeScript no inference site for the values; the one-call form is refused by an error that
 * names the two. Checked by typecheck.
 */
import { describe, expectTypeOf, it } from "vitest"
import type { InferMeta } from "../../src/routing/app-types.ts"
import type { ChainSupplied, MetaNeedsTwoCalls } from "../../src/routing/meta-types.ts"
import { honey } from "../../src/routing/app.ts"

type AppMeta = { tenant?: "organization" | "project"; worker: "extract" }

describe("a declared meta type, its defaults set by a second call", () => {
	const app = honey<{}>().meta<AppMeta>().meta({ worker: "extract" })

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
		const defaulted = honey<{}>().meta<AppMeta>().meta({ tenant: "project" })
		expectTypeOf<ChainSupplied<InferMeta<typeof defaulted>>>().toExtend<{ worker: "extract" }>()
		defaulted
			.get("/tables")
			// @ts-expect-error `worker` is required and no chain value supplies it
			.meta({ summary: "List tables" })
			.handler((ctx) => ctx.res.text("ok", "ok"))
	})

	it("stays required when the handle sets no default at all", () => {
		const declared = honey<{}>().meta<AppMeta>()
		expectTypeOf<ChainSupplied<InferMeta<typeof declared>>>().toExtend<{ worker: "extract" }>()
		declared
			.get("/tables")
			// @ts-expect-error `worker` is required and the handle sets no default
			.meta({ summary: "List tables" })
			.handler((ctx) => ctx.res.text("ok", "ok"))
	})
})

describe("declaring the type and defaulting in one call", () => {
	it("answers no handle, so the next call names the two that replace it", () => {
		const oneCall = honey<{}>().meta<AppMeta>({ worker: "extract" })
		expectTypeOf(oneCall).toEqualTypeOf<MetaNeedsTwoCalls>()
		// @ts-expect-error not a handle: app.meta<AppMeta>() declares, a second app.meta({ … }) defaults
		oneCall.get("/tables")
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
