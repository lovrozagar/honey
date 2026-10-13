import { honey } from "../../src/index.ts"
import type { HoneyError, InferCtx, InferRoutePaths } from "../../src/index.ts"
import type { Eq, Expect } from "./_assert.ts"

/* ── route(sub) under a basePath: the sub's paths move under it ── */

const sub = honey()
	.get("/users")
	.handler((ctx) => ctx.res.json("ok", { ok: true }))

const admin = honey()
	.basePath("/admin")
	.get("/x")
	.handler((ctx) => ctx.res.text("ok", "x"))

const mounted = honey().basePath("/v1").route(sub).route(admin)
type _Mounted = Expect<Eq<InferRoutePaths<typeof mounted>, "/v1/users" | "/v1/admin/x">>

/* route(prefix, sub) is basePath(prefix).route(sub) */
const prefixed = honey().route("/v2", sub)
type _Prefixed = Expect<Eq<InferRoutePaths<typeof prefixed>, "/v2/users">>

/* no basePath: paths stay as the sub registered them */
const plain = honey().route(sub)
type _Plain = Expect<Eq<InferRoutePaths<typeof plain>, "/users">>

/* ── ctx.error ── */

type _Error = Expect<Eq<InferCtx<ReturnType<typeof honey>>["error"], HoneyError | undefined>>
