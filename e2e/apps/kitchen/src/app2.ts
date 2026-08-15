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
} from "@lovrozagar/honey"
import * as z from "zod"
import { base } from "./context"
import { Service } from "./service"

const app = base
	.get("/hello")
	.input({ search: z.object({ q: z.string() }) })
	.output({ "application/json": { ok: z.object({ q: z.string() }) } })
	.handler((c) => c.res.json("ok", { q: Service.list(c) }))
	.post("/hello")
	.input({ json: z.object({ q: z.string() }) })
	.output({ "application/json": { ok: z.object({ q: z.string() }) } })
	.handler((c) => c.res.json("ok", { q: c.input.json.q }))

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

/* InferCtx — accumulated middleware context */
type Ctx = InferCtx<typeof app>
type _Ctx = Expect<Ctx extends { db: { query: (sql: string) => unknown[] } } ? true : false>

/* InferEnv — env bindings */
type E = InferEnv<typeof app>
type _E = Expect<Eq<E, Record<string, unknown>>>

/* InferMethods — all HTTP methods used */
type M = InferMethods<typeof app>
type _M = Expect<Eq<M, "get" | "post">>

/* InferRoutes — full route map */
type Routes = InferRoutes<typeof app>
type _Routes = Expect<Eq<Routes, never> extends true ? false : true>

/* InferRoutePaths — registered path literals */
type Paths = InferRoutePaths<typeof app>
type _Paths = Expect<Eq<Paths, "/hello">>

/* InferRouteMethods — methods for a path */
type Methods = InferRouteMethods<typeof app, "/hello">
type _Methods = Expect<Eq<Methods, "get" | "post">>

/* InferRouteCtx — handler context for path+method */
type HelloCtx = InferRouteCtx<typeof app, "/hello", "get">
type _HelloCtx = Expect<
	HelloCtx extends { db: { query: (sql: string) => unknown[] }; input: { search: { q: string } } }
		? true
		: false
>

/* InferRouteInput — input schema for path+method */
type HelloInput = InferRouteInput<typeof app, "/hello", "get">
type HelloPostInput = InferRouteInput<typeof app, "/hello", "post">
type _HelloInput = Expect<Eq<HelloInput, { search: { q: string } }>>
type _HelloPostInput = Expect<Eq<HelloPostInput, { json: { q: string } }>>

/* InferRouteOutput — output schema for path+method */
type HelloOutput = InferRouteOutput<typeof app, "/hello", "get">
type _HelloOutput = Expect<HelloOutput extends { "application/json": { ok: unknown } } ? true : false>

export { app }
export type { Ctx, E, HelloCtx, HelloInput, HelloOutput, M, Methods, Paths, Routes }
