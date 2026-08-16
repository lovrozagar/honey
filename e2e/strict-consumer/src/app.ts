/**
 * A consumer with every strictness flag we could plausibly meet in the wild.
 *
 * The point is not what this app does — it is that type-checking it must produce zero
 * diagnostics originating inside @lovrozagar/honey. A package that ships raw TypeScript
 * inherits the consumer's flags, and `skipLibCheck` does not cover `.ts`, so there is no
 * way for a consumer to opt out of our lint posture.
 */
import { createMiddleware, defineErrors, honey } from "@lovrozagar/honey"
import type { InferCtx } from "@lovrozagar/honey"
import { cors } from "@lovrozagar/honey/cors"
import { logger } from "@lovrozagar/honey/logger"
import { requestId } from "@lovrozagar/honey/request-id"
import "@lovrozagar/honey/openapi"
import * as z from "zod"

const errors = defineErrors({ not_found: "not_found", unauthorized: "unauthorized" })

const withUser = createMiddleware(async (_ctx, next) => next({ user: { id: "u-1" } }), {
	meta: { tenant: "org_id" },
})

type AppMeta = { permissions?: string[]; tenant?: string }

const app = honey<{ SECRET: string }>().errorFactory(errors).meta<AppMeta>()

app.metaSpec({
	meta: { permissions: "x-permissions", tenant: "x-tenant" },
	schema: {
		entityFacts: {
			expand: (e: { name: string }) => ({ "x-entity": e.name }),
			from: ["output"],
			match: { kind: "entity" },
			read: "x-comb",
			search: "deep",
			version: { max: 1 },
		},
	},
	strict: "error",
})

const base = app.use(requestId()).use(logger()).use(cors()).use(withUser)

type Ctx = InferCtx<typeof base>

base
	.get("/users/:id")
	.meta({ permissions: ["users.read"], summary: "Get a user" })
	.input({ search: z.object({ expand: z.string().optional() }) })
	.output({ "application/json": { ok: z.object({ id: z.string() }) } })
	.errors("not_found")
	.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

base.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

export type { Ctx }
export { app }
