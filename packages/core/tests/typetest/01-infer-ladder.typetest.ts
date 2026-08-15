import * as z from "zod"
import { honey } from "../../src/index.ts"
import type {
	InferBasePath,
	InferCtx,
	InferEnv,
	InferErrorFactory,
	InferMeta,
	InferMethods,
	InferRouteCtx,
	InferRouteErrors,
	InferRouteInput,
	InferRouteMethods,
	InferRouteOutput,
	InferRoutePaths,
	InferRoutes,
} from "../../src/index.ts"
import type { Eq, Expect, Extends, IsNever, IsUnknown } from "./_assert.ts"

type Env = { SECRET: string }

/* ── 1. bare instance ── */

const bare = honey<Env>()

type _BareRoutes = Expect<Eq<InferRoutes<typeof bare>, {}>>
type _BarePaths = Expect<IsNever<InferRoutePaths<typeof bare>>>
type _BareMethods = Expect<IsNever<InferMethods<typeof bare>>>
type _BareEnv = Expect<Eq<InferEnv<typeof bare>, Env>>
type _BareBase = Expect<Eq<InferBasePath<typeof bare>, "/">>
type _BareMeta = Expect<IsNever<InferMeta<typeof bare>>>
type _BareFactory = Expect<IsNever<InferErrorFactory<typeof bare>>>
type _BareCtx = Expect<Extends<InferCtx<typeof bare>, { req: Request; env: Env }>>

/* ── 2. one GET, no input/output ── */

const one = bare.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

type _OneRoutes = Expect<Eq<IsNever<InferRoutes<typeof one>>, false>>
type _OnePaths = Expect<Eq<InferRoutePaths<typeof one>, "/health">>
type _OneMethods = Expect<Eq<InferMethods<typeof one>, "get">>
type _OneVerbs = Expect<Eq<InferRouteMethods<typeof one, "/health">, "get">>
type _OneInput = Expect<Eq<InferRouteInput<typeof one, "/health", "get">, {}>>
type _OneOutput = Expect<Eq<InferRouteOutput<typeof one, "/health", "get">, {}>>
type _OneErrors = Expect<IsNever<InferRouteErrors<typeof one, "/health", "get">>>
type _OneUnknown = Expect<Eq<IsUnknown<InferRouteInput<typeof one, "/health", "get">>, false>>
type _OneEnv = Expect<Eq<InferEnv<typeof one>, Env>>

one.get("/health").handler((ctx) => {
	// @ts-expect-error — no .input(), ctx.input is not added
	const _missing = ctx.input
	void _missing
	return ctx.res.text("ok", "ok")
})

/* ── 3. input + output on a single route ── */

const search = honey<Env>()
	.get("/search")
	.input({ search: z.object({ limit: z.string(), q: z.string() }) })
	.output({ "application/json": { ok: z.object({ q: z.string() }) } })
	.handler((ctx) => ctx.res.json("ok", { q: ctx.input.search.q }))

type _SearchIn = Expect<
	Eq<InferRouteInput<typeof search, "/search", "get">, { search: { limit: string; q: string } }>
>
type _SearchOut = Expect<
	Extends<InferRouteOutput<typeof search, "/search", "get">, { "application/json": { ok: unknown } }>
>
type _SearchCtx = Expect<
	Extends<InferRouteCtx<typeof search, "/search", "get">, { input: { search: { q: string } } }>
>
type _SearchNotUnknown = Expect<
	Eq<IsUnknown<InferRouteInput<typeof search, "/search", "get">>, false>
>

/* ── 4. GET + POST on the same path (no .meta()) ── */

const hello = honey<Env>()
	.get("/hello")
	.input({ search: z.object({ q: z.string() }) })
	.output({ "application/json": { ok: z.object({ q: z.string() }) } })
	.handler((c) => c.res.json("ok", { q: c.input.search.q }))
	.post("/hello")
	.input({ json: z.object({ q: z.string() }) })
	.output({ "application/json": { ok: z.object({ q: z.string() }) } })
	.handler((c) => c.res.json("ok", { q: c.input.json.q }))

type _HelloPaths = Expect<Eq<InferRoutePaths<typeof hello>, "/hello">>
type _HelloMethods = Expect<Eq<InferMethods<typeof hello>, "get" | "post">>
type _HelloVerbs = Expect<Eq<InferRouteMethods<typeof hello, "/hello">, "get" | "post">>
type _HelloGetIn = Expect<
	Eq<InferRouteInput<typeof hello, "/hello", "get">, { search: { q: string } }>
>
type _HelloPostIn = Expect<
	Eq<InferRouteInput<typeof hello, "/hello", "post">, { json: { q: string } }>
>
type _HelloGetCtx = Expect<
	Extends<InferRouteCtx<typeof hello, "/hello", "get">, { input: { search: { q: string } } }>
>
type _HelloPostCtx = Expect<
	Extends<InferRouteCtx<typeof hello, "/hello", "post">, { input: { json: { q: string } } }>
>

/* @ts-expect-error — POST is not registered on /search */
type _NoPost = InferRouteInput<typeof search, "/search", "post">
/* @ts-expect-error — path is not registered */
type _NoPath = InferRouteInput<typeof hello, "/nope", "get">

/* ── 5. many distinct paths still resolve ── */

const many = honey<Env>()
	.get("/r1")
	.handler((c) => c.res.text("ok", "1"))
	.get("/r2")
	.handler((c) => c.res.text("ok", "2"))
	.get("/r3")
	.handler((c) => c.res.text("ok", "3"))
	.post("/r4")
	.input({ json: z.object({ x: z.string() }) })
	.handler((c) => c.res.json("created", { x: c.input.json.x }))
	.delete("/r5")
	.handler((c) => c.res.text("ok", "5"))

type _ManyPaths = Expect<
	Eq<InferRoutePaths<typeof many>, "/r1" | "/r2" | "/r3" | "/r4" | "/r5">
>
type _ManyMethods = Expect<Eq<InferMethods<typeof many>, "delete" | "get" | "post">>
type _ManyR4 = Expect<Eq<InferRouteInput<typeof many, "/r4", "post">, { json: { x: string } }>>
type _ManyR1 = Expect<Eq<InferRouteInput<typeof many, "/r1", "get">, {}>>
