import * as z from "zod"
import { defineErrors, honey } from "../../src/index.ts"
import type {
	InferBasePath,
	InferErrorFactory,
	InferMeta,
	InferRouteErrors,
	InferRouteInput,
	InferRouteMeta,
	InferRouteMethods,
	InferRoutePaths,
	InferRoutes,
} from "../../src/index.ts"
import type { Eq, Expect, Extends, IsNever } from "./_assert.ts"

const errs = defineErrors({
	email_taken: "conflict",
	not_allowed: "forbidden",
	not_found: "not_found",
})

/* ── factory + route errors ── */

const withFactory = honey().errorFactory(errs)
type _Factory = Expect<
	Extends<InferErrorFactory<typeof withFactory>, { email_taken: unknown; not_found: unknown }>
>

const erred = withFactory
	.defaultErrors("not_allowed")
	.get("/a")
	.handler((ctx) => ctx.res.text("ok", "ok"))
	.get("/b")
	.errors("email_taken")
	.handler((ctx) => ctx.res.text("ok", "ok"))
	.get("/c")
	.errors("email_taken", "not_found")
	.handler((ctx) => ctx.res.text("ok", "ok"))

type _ErrA = Expect<Eq<InferRouteErrors<typeof erred, "/a", "get">, "not_allowed">>
type _ErrB = Expect<Eq<InferRouteErrors<typeof erred, "/b", "get">, "email_taken" | "not_allowed">>
type _ErrC = Expect<
	Eq<InferRouteErrors<typeof erred, "/c", "get">, "email_taken" | "not_allowed" | "not_found">
>

const clean = honey().get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
type _NoErr = Expect<IsNever<InferRouteErrors<typeof clean, "/health", "get">>>
type _NoMeta = Expect<Eq<InferRouteMeta<typeof clean, "/health", "get">, {}>>

/* ── route meta ── */

const metaed = honey()
	.get("/doc")
	.meta({ summary: "Get doc", tags: ["docs"] })
	.handler((ctx) => ctx.res.text("ok", "ok"))

type _RouteMeta = Expect<Extends<InferRouteMeta<typeof metaed, "/doc", "get">, { summary: string }>>

/* internal routes stay out of $routes */
const hidden = honey()
	.get("/hidden")
	.meta({ internal: true })
	.handler((ctx) => ctx.res.text("ok", "ok"))
	.get("/visible")
	.handler((ctx) => ctx.res.text("ok", "ok"))

type _HiddenPaths = Expect<Eq<InferRoutePaths<typeof hidden>, "/visible">>
type _HiddenHas = Expect<"/hidden" extends InferRoutePaths<typeof hidden> ? false : true>

/* app-level meta() */
const appMeta = honey().meta<{ region: string }>()
type _AppMeta = Expect<Eq<InferMeta<typeof appMeta>, { region: string }>>

/* ── basePath ── */

const api = honey()
	.basePath("/api")
	.get("/users")
	.handler((ctx) => ctx.res.text("ok", "ok"))
	.post("/users")
	.input({ json: z.object({ name: z.string() }) })
	.handler((ctx) => ctx.res.json("created", { name: ctx.input.json.name }))

type _Base = Expect<Eq<InferBasePath<typeof api>, "/api">>
type _Prefixed = Expect<Eq<InferRoutePaths<typeof api>, "/api/users">>
type _PrefixedVerbs = Expect<Eq<InferRouteMethods<typeof api, "/api/users">, "get" | "post">>
type _PrefixedIn = Expect<
	Eq<InferRouteInput<typeof api, "/api/users", "post">, { json: { name: string } }>
>

const nested = honey().basePath("/v1").basePath("/api")
type _NestedBase = Expect<Eq<InferBasePath<typeof nested>, "/v1/api">>

/* ── .route() composition ── */

const v1 = honey()
	.basePath("/v1")
	.get("/items")
	.handler((ctx) => ctx.res.text("ok", "ok"))
const v2 = honey()
	.basePath("/v2")
	.get("/items")
	.handler((ctx) => ctx.res.text("ok", "ok"))
const composed = honey().route(v1).route(v2)

type _Composed = Expect<Eq<InferRoutePaths<typeof composed>, "/v1/items" | "/v2/items">>
type _ComposedRoutes = Expect<Eq<IsNever<InferRoutes<typeof composed>>, false>>
