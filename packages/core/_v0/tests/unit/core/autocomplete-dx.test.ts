import { describe, expect, expectTypeOf, it } from "vitest"
import { honey } from "../../../src/index.ts"

describe("3A: _ internals hidden from public type", () => {
	it("_tree not on public Honey type", () => {
		const app = honey<{}>()
		type App = typeof app
		type HasTree = "_tree" extends keyof App ? true : false
		expectTypeOf<HasTree>().toEqualTypeOf<false>()
	})

	it("_factory not on public Honey type", () => {
		const app = honey<{}>()
		type App = typeof app
		type Has = "_factory" extends keyof App ? true : false
		expectTypeOf<Has>().toEqualTypeOf<false>()
	})

	it("_boundaryKey not on public Honey type", () => {
		const app = honey<{}>()
		type App = typeof app
		type Has = "_boundaryKey" extends keyof App ? true : false
		expectTypeOf<Has>().toEqualTypeOf<false>()
	})

	it("_registerStatic not on public Honey type", () => {
		const app = honey<{}>()
		type App = typeof app
		type Has = "_registerStatic" extends keyof App ? true : false
		expectTypeOf<Has>().toEqualTypeOf<false>()
	})

	it("_markWsRoutes not on public Honey type", () => {
		const app = honey<{}>()
		type App = typeof app
		type Has = "_markWsRoutes" extends keyof App ? true : false
		expectTypeOf<Has>().toEqualTypeOf<false>()
	})

	it("public API methods still accessible", () => {
		const app = honey<{}>()
		type App = typeof app
		type HasGet = "get" extends keyof App ? true : false
		type HasPost = "post" extends keyof App ? true : false
		type HasUse = "use" extends keyof App ? true : false
		type HasMeta = "meta" extends keyof App ? true : false
		type HasContext = "context" extends keyof App ? true : false
		type HasFetch = "fetch" extends keyof App ? true : false
		type HasRoute = "route" extends keyof App ? true : false
		type HasBasePath = "basePath" extends keyof App ? true : false

		expectTypeOf<HasGet>().toEqualTypeOf<true>()
		expectTypeOf<HasPost>().toEqualTypeOf<true>()
		expectTypeOf<HasUse>().toEqualTypeOf<true>()
		expectTypeOf<HasMeta>().toEqualTypeOf<true>()
		expectTypeOf<HasContext>().toEqualTypeOf<true>()
		expectTypeOf<HasFetch>().toEqualTypeOf<true>()
		expectTypeOf<HasRoute>().toEqualTypeOf<true>()
		expectTypeOf<HasBasePath>().toEqualTypeOf<true>()
	})

	it("runtime still works — internals accessible via framework casts", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.json("ok", { ok: true }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
	})
})
