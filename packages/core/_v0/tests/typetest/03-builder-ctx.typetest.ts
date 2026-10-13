import * as z from "zod"
import { createMiddleware, honey } from "../../src/index.ts"
import type { InferCtx, InferEnv, InferRouteCtx } from "../../src/index.ts"
import type { Eq, Expect, Extends } from "./_assert.ts"

type Env = { DB: string }
type Db = { db: { query: (sql: string) => unknown[] } }
type Auth = { orgId: string; userId: string }

const withDb = createMiddleware(async (_ctx, next) => next({ db: { query: (_sql: string) => [] as unknown[] } }))
const withAuth = createMiddleware(async (_ctx, next) => next({ orgId: "o", userId: "u" }))
const withTrace = createMiddleware(async (_ctx, next) => next({ traceId: "t-1" }))

/* ── global middleware accumulation ── */

const base = honey<Env>().use(withDb).use(withAuth)
type _Ctx = Expect<Extends<InferCtx<typeof base>, Db & Auth>>
type _Env = Expect<Eq<InferEnv<typeof base>, Env>>

base.get("/orgs").handler((ctx) => {
	type _Db = Expect<Eq<typeof ctx.db.query, (sql: string) => unknown[]>>
	type _User = Expect<Eq<typeof ctx.userId, string>>
	type _EnvField = Expect<Eq<typeof ctx.env.DB, string>>
	return ctx.res.json("ok", { id: ctx.userId })
})

/* ── route-level .use() ── */

const routed = base
	.get("/traced")
	.use(withTrace)
	.handler((ctx) => {
		type _T = Expect<Eq<typeof ctx.traceId, string>>
		type _StillDb = Expect<Eq<typeof ctx.userId, string>>
		return ctx.res.text("ok", ctx.traceId)
	})

type _RoutedCtx = Expect<Extends<InferRouteCtx<typeof routed, "/traced", "get">, Db & Auth & { traceId: string }>>

/* ── scoped .use(path, mw) ── */

const adminMw = createMiddleware(async (_c, next) => next({ adminOnly: "yes" }))

const scoped = honey<Env>().use("/admin", adminMw)

scoped.get("/admin/x").handler((c) => {
	type _A = Expect<Eq<typeof c.adminOnly, string>>
	return c.res.text("ok", c.adminOnly)
})

scoped.get("/public").handler((c) => {
	// @ts-expect-error — adminOnly is not on /public
	const x = c.adminOnly
	void x
	return c.res.text("ok", "p")
})

scoped.get("/administration").handler((c) => {
	// @ts-expect-error — /admin does not match /administration
	const x = c.adminOnly
	void x
	return c.res.text("ok", "a")
})

/* ── builder one-shots disappear after use ── */

const fresh = honey().get("/test")
type _HasInput = Expect<"input" extends keyof typeof fresh ? true : false>
type _HasOutput = Expect<"output" extends keyof typeof fresh ? true : false>
type _HasMeta = Expect<"meta" extends keyof typeof fresh ? true : false>
type _HasErrors = Expect<"errors" extends keyof typeof fresh ? true : false>
type _HasHandler = Expect<"handler" extends keyof typeof fresh ? true : false>

const afterInput = fresh.input({ json: z.object({ n: z.number() }) })
type _InputGone = Expect<"input" extends keyof typeof afterInput ? false : true>
type _OutputStays = Expect<"output" extends keyof typeof afterInput ? true : false>

afterInput
	// @ts-expect-error — .input() is one-shot
	.input({ search: z.object({ q: z.string() }) })

/* ── declared output keeps json callable with the declared status ── */

honey()
	.post("/json")
	.output({ "application/json": { created: z.object({ id: z.string() }) } })
	.handler((ctx) => ctx.res.json("created", { id: "abc" }))
