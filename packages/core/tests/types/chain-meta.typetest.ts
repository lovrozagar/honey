/**
 * Chain `.meta(values)` and what a route must still pass (bit 22 a): a key the chain set is optional on every
 * route under that handle, a key nothing set stays as declared, and an unknown key is still refused. Declaring the
 * meta type and setting defaults takes two calls — `meta<AppMeta>().meta({ … })` — because a call that gives the
 * type explicitly leaves TypeScript no inference site for the values; the one-call form is refused by an error that
 * names the two. Checked by typecheck.
 */
import { describe, expectTypeOf, it } from "vitest"
import type { InferMeta } from "../../src/routing/app-types.ts"
import type { ChainSupplied } from "../../src/routing/meta-types.ts"
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

describe("declaring the type and setting defaults in one call", () => {
	/* 0.7.3's shape, and the one the README teaches. One call cannot know WHICH keys it set — TypeScript fills a
	   second type parameter from its default rather than inferring it when the first is given explicitly — so it
	   records every key as set: a route may omit any of them, and the two-call form stays the precise one. */
	const app = honey<{}>().meta<AppMeta>({ worker: "extract" })

	it("lets a route omit any declared key", () => {
		app
			.get("/tables")
			.meta({ summary: "List tables" })
			.handler((ctx) => {
				expectTypeOf(ctx.meta.worker).toEqualTypeOf<"extract">()
				return ctx.res.text("ok", "ok")
			})
	})

	it("refuses a key nothing declares", () => {
		expectTypeOf<ChainSupplied<InferMeta<typeof app>>>().not.toHaveProperty("nope")
		app
			.get("/tables")
			// @ts-expect-error `nope` is in neither AppMeta nor the OpenAPI keys
			.meta({ nope: 1 })
			.handler((ctx) => ctx.res.text("ok", "ok"))
	})

	it("refuses a declared key's wrong value, and an OpenAPI key's", () => {
		expectTypeOf<ChainSupplied<InferMeta<typeof app>>>().toExtend<{ tenant?: "organization" | "project" }>()
		app
			.get("/tables")
			// @ts-expect-error `tenant` is "organization" | "project"
			.meta({ tenant: "nope" })
			.handler((ctx) => ctx.res.text("ok", "ok"))
		app
			.get("/orgs")
			// @ts-expect-error `summary` is a string
			.meta({ summary: 1 })
			.handler((ctx) => ctx.res.text("ok", "ok"))
	})

	it("keeps the handle a handle: the routes it registers are its own", () => {
		expectTypeOf(app.get("/one").handler((ctx) => ctx.res.text("ok", "ok"))).not.toBeNever()
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
