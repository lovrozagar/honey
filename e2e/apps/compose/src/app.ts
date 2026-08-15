import type { WSAdapter } from "@lovrozagar/honey"
import { createMiddleware, defineErrors, honey } from "@lovrozagar/honey"
import "@lovrozagar/honey/openapi"
import * as z from "zod"

type Env = { JWT_SECRET: string; REDIS_URL: string }

const errors = defineErrors({
	expired_token: "unauthorized",
	forbidden: "forbidden",
	invalid_token: "unauthorized",
	not_found: "not_found",
	rate_limited: "too_many_requests",
})

const withCache = createMiddleware(async (_ctx, next) =>
	next({
		cache: { get: (_k: string): string | null => null, set: (_k: string, _v: string) => {} },
	}),
)

const withSession = createMiddleware(async (_ctx, next) =>
	next({ session: { orgId: "org-1", permissions: ["read", "write"] as string[], userId: "u-1" } }),
)

/** Shared base + .route() groups. User /docs keeps Scalar off /docs. */
export function createApp(wsAdapter?: WSAdapter) {
	const base = honey<Env>()
		.errorFactory(errors)
		.defaultErrors("invalid_token", "expired_token")
		.use(withCache)
		.use(withSession)
	if (wsAdapter) base.wsAdapter(wsAdapter)

	const publicRoutes = base
		.get("/health")
		.handler((ctx) => ctx.res.json("ok", { cached: ctx.cache.get("health"), status: "up" }))
		.get("/docs")
		.handler((ctx) => ctx.res.text("ok", "API documentation"))
		.get("/feed")
		.input({ search: z.object({ page: z.number().default(1) }) })
		.handler((ctx) => ctx.res.json("ok", { items: [], page: ctx.input.search.page }))

	const accountRoutes = base
		.get("/account")
		.errors("forbidden")
		.handler((ctx) => ctx.res.json("ok", { orgId: ctx.session.orgId, userId: ctx.session.userId }))
		.post("/account/settings")
		.input({ json: z.object({ notifications: z.boolean(), theme: z.enum(["dark", "light"]) }) })
		.errors("forbidden")
		.handler((ctx) => ctx.res.json("ok", ctx.input.json))

	const resourceRoutes = base
		.get("/resources/:resourceId")
		.errors("not_found", "forbidden")
		.handler((ctx) => {
			if (!ctx.session.permissions.includes("read")) throw ctx.errors.forbidden()
			return ctx.res.json("ok", { id: ctx.params.resourceId })
		})
		.delete("/resources/:resourceId")
		.errors("not_found", "forbidden")
		.handler((ctx) => {
			if (!ctx.session.permissions.includes("write")) throw ctx.errors.forbidden()
			return ctx.res.noContent()
		})
		.post("/resources")
		.input({ json: z.object({ name: z.string(), type: z.enum(["doc", "image", "video"]) }) })
		.errors("forbidden", "rate_limited")
		.handler((ctx) => {
			ctx.cache.set(`resource:${ctx.input.json.name}`, "pending")
			return ctx.res.json("created", { name: ctx.input.json.name, type: ctx.input.json.type })
		})

	const app = publicRoutes.route(accountRoutes).route(resourceRoutes)
	app.openapi({ docs: "scalar", title: "Honey Compose", version: "0.0.1" })
	app.manifest()
	return app
}
