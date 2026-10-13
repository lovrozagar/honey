import { describe, expectTypeOf, it } from "vitest"
import * as z from "zod"
import type {
	InferCtx,
	InferEnv,
	InferMethods,
	InferRouteCtx,
	InferRouteInput,
	InferRouteMethods,
	InferRouteOutput,
	InferRoutePaths,
	InferRoutes,
	MiddlewareFn,
} from "../../../src/index.ts"
import { honey } from "../../../src/index.ts"

type TestEnv = { SECRET: string }
type DbCtx = { db: { query: (sql: string) => unknown[] } }
const withDb: MiddlewareFn<{}, DbCtx> = async (_ctx, next) => next({ db: { query: () => [] } })

const base = honey<TestEnv>().use(withDb)

const app = base
	.get("/hello")
	.input({ search: z.object({ q: z.string() }) })
	.output({ "application/json": { ok: z.object({ q: z.string() }) } })
	.handler((c) => c.res.json("ok", { q: c.input.search.q }))
	.post("/hello")
	.input({ json: z.object({ q: z.string() }) })
	.output({ "application/json": { ok: z.object({ q: z.string() }) } })
	.handler((c) => c.res.json("ok", { q: c.input.json.q }))

describe("deep Infer* on get+post /hello without .meta()", () => {
	it("InferRoutes is the route map, not never", () => {
		type Routes = InferRoutes<typeof app>
		expectTypeOf<Routes>().not.toBeNever()
		expectTypeOf<Routes>().toHaveProperty("/hello")
	})

	it("InferCtx keeps middleware context", () => {
		expectTypeOf<InferCtx<typeof app>>().toMatchTypeOf<{
			db: { query: (sql: string) => unknown[] }
		}>()
	})

	it("InferEnv is the env generic", () => {
		expectTypeOf<InferEnv<typeof app>>().toEqualTypeOf<TestEnv>()
	})

	it("InferMethods is get | post", () => {
		expectTypeOf<InferMethods<typeof app>>().toEqualTypeOf<"get" | "post">()
	})

	it("InferRoutePaths is /hello", () => {
		expectTypeOf<InferRoutePaths<typeof app>>().toEqualTypeOf<"/hello">()
	})

	it("InferRouteMethods lists both methods", () => {
		expectTypeOf<InferRouteMethods<typeof app, "/hello">>().toEqualTypeOf<"get" | "post">()
	})

	it("InferRouteInput GET is search, not unknown", () => {
		type Input = InferRouteInput<typeof app, "/hello", "get">
		expectTypeOf<Input>().not.toBeNever()
		expectTypeOf<Input>().not.toBeUnknown()
		expectTypeOf<Input>().toEqualTypeOf<{ search: { q: string } }>()
	})

	it("InferRouteInput POST is json", () => {
		type Input = InferRouteInput<typeof app, "/hello", "post">
		expectTypeOf<Input>().toEqualTypeOf<{ json: { q: string } }>()
	})

	it("InferRouteOutput GET has application/json.ok", () => {
		type Output = InferRouteOutput<typeof app, "/hello", "get">
		expectTypeOf<Output>().toHaveProperty("application/json")
		expectTypeOf<Output["application/json"]>().toHaveProperty("ok")
	})

	it("InferRouteCtx GET has db + search input", () => {
		type Ctx = InferRouteCtx<typeof app, "/hello", "get">
		expectTypeOf<Ctx>().toMatchTypeOf<{
			db: { query: (sql: string) => unknown[] }
			input: { search: { q: string } }
		}>()
	})

	it("InferRouteCtx POST has db + json input", () => {
		type Ctx = InferRouteCtx<typeof app, "/hello", "post">
		expectTypeOf<Ctx>().toMatchTypeOf<{
			db: { query: (sql: string) => unknown[] }
			input: { json: { q: string } }
		}>()
	})
})
