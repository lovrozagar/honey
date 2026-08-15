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
} from "@ecomet/honey"
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

/* InferCtx — accumulated middleware context */
type Ctx = InferCtx<typeof app>

/* InferEnv — env bindings */
type E = InferEnv<typeof app>

/* InferMethods — all HTTP methods used */
type M = InferMethods<typeof app>

/* InferRoutes — full route map */
type Routes = InferRoutes<typeof app>

/* InferRoutePaths — registered path literals */
type Paths = InferRoutePaths<typeof app>

/* InferRouteMethods — methods for a path */
type Methods = InferRouteMethods<typeof app, "/hello">

/* InferRouteCtx — handler context for path+method */
type HelloCtx = InferRouteCtx<typeof app, "/hello", "get">

/* InferRouteInput — input schema for path+method */
type HelloInput = InferRouteInput<typeof app, "/hello", "get">

/* InferRouteOutput — output schema for path+method */
type HelloOutput = InferRouteOutput<typeof app, "/hello", "get">

export { app }
export type { Ctx, E, HelloCtx, HelloInput, HelloOutput, M, Methods, Paths, Routes }
