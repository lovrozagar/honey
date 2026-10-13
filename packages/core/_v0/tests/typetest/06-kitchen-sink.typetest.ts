import * as z from "zod"
import { createMiddleware, defineErrors, honey } from "../../src/index.ts"
import type {
	InferCtx,
	InferEnv,
	InferErrorFactory,
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
type Db = { db: { query: (sql: string) => unknown[] } }

const withDb = createMiddleware(async (_ctx, next) => next({ db: { query: (_sql: string) => [] as unknown[] } }))
const withRequestId = createMiddleware(async (_ctx, next) => next({ requestId: "r-1" }))
const adminOnly = createMiddleware(async (_ctx, next) => next({ role: "admin" as const }))

const errors = defineErrors({
	not_found: "not_found",
	slug_taken: "conflict",
	unauthorized: "unauthorized",
})

const base = honey<Env>().errorFactory(errors).use(withDb).use(withRequestId)

const publicApi = base
	.basePath("/api")
	.get("/health")
	.handler((c) => c.res.text("ok", "ok"))
	.get("/hello")
	.input({ search: z.object({ q: z.string() }) })
	.output({ "application/json": { ok: z.object({ q: z.string() }) } })
	.handler((c) => c.res.json("ok", { q: c.input.search.q }))
	.post("/hello")
	.input({ json: z.object({ q: z.string() }) })
	.output({ "application/json": { ok: z.object({ q: z.string() }) } })
	.handler((c) => c.res.json("ok", { q: c.input.json.q }))
	.get("/orgs/:orgId")
	.errors("not_found")
	.output({ "application/json": { ok: z.object({ id: z.string() }) } })
	.handler((c) => c.res.json("ok", { id: c.params.orgId }))
	.post("/orgs")
	.input({ json: z.object({ slug: z.string() }) })
	.errors("slug_taken")
	.output({ "application/json": { created: z.object({ slug: z.string() }) } })
	.handler((c) => c.res.json("created", { slug: c.input.json.slug }))

const adminApi = base
	.basePath("/admin")
	.use(adminOnly)
	.get("/stats")
	.handler((c) => {
		type _Role = Expect<Eq<typeof c.role, "admin">>
		type _Db = Expect<Eq<typeof c.requestId, string>>
		return c.res.json("ok", { ok: true })
	})

const app = honey<Env>().route(publicApi).route(adminApi)

type Paths = InferRoutePaths<typeof app>
type _Paths = Expect<Eq<Paths, "/admin/stats" | "/api/health" | "/api/hello" | "/api/orgs" | "/api/orgs/:orgId">>
type _Methods = Expect<Eq<InferMethods<typeof app>, "get" | "post">>
type _HelloVerbs = Expect<Eq<InferRouteMethods<typeof app, "/api/hello">, "get" | "post">>

type _GetHello = Expect<Eq<InferRouteInput<typeof app, "/api/hello", "get">, { search: { q: string } }>>
type _PostHello = Expect<Eq<InferRouteInput<typeof app, "/api/hello", "post">, { json: { q: string } }>>
type _NotUnknown = Expect<Eq<IsUnknown<InferRouteInput<typeof app, "/api/hello", "get">>, false>>
type _NotNever = Expect<Eq<IsNever<InferRoutes<typeof app>>, false>>

type _OrgIn = Expect<Eq<InferRouteInput<typeof app, "/api/orgs", "post">, { json: { slug: string } }>>
type _OrgGetErr = Expect<Eq<InferRouteErrors<typeof app, "/api/orgs/:orgId", "get">, "not_found">>
type _OrgPostErr = Expect<Eq<InferRouteErrors<typeof app, "/api/orgs", "post">, "slug_taken">>

type _HelloOut = Expect<
	Extends<InferRouteOutput<typeof app, "/api/hello", "get">, { "application/json": { ok: unknown } }>
>
type _OrgCtx = Expect<
	Extends<
		InferRouteCtx<typeof app, "/api/orgs/:orgId", "get">,
		Db & { requestId: string; readonly params: { orgId: string } }
	>
>
type _HelloCtx = Expect<
	Extends<InferRouteCtx<typeof app, "/api/hello", "get">, Db & { input: { search: { q: string } }; requestId: string }>
>

type _Env = Expect<Eq<InferEnv<typeof app>, Env>>
type _BaseCtx = Expect<Extends<InferCtx<typeof base>, Db & { requestId: string }>>
type _PublicCtx = Expect<Extends<InferCtx<typeof publicApi>, Db & { requestId: string }>>
type _Factory = Expect<Extends<InferErrorFactory<typeof app>, { not_found: unknown }>>

/* @ts-expect-error — admin path is not /api */
type _Wrong = InferRouteInput<typeof app, "/admin/hello", "get">
/* @ts-expect-error — no PUT on /api/hello */
type _NoPut = InferRouteInput<typeof app, "/api/hello", "put">
