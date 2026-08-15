import { createMiddleware, defineErrors, honey } from "honey"
import * as z from "zod"
import { OrgService } from "./services"

type Env = { SECRET: string }

type AppMeta = {
	auth?: "public" | "required"
	rateLimit?: "default" | "strict"
}

const errors = defineErrors({
	internal_server_error: "internal_server_error",
	not_found: "not_found",
	org_limit_reached: "forbidden",
	org_slug_taken: "conflict",
	validation_failed: "bad_request",
})

const withAuth = createMiddleware(async (_ctx, next) => next({ userId: "u-1" }))

function withDatabase(url: string) {
	return createMiddleware(async (_ctx, next) =>
		next({ db: { query: (_sql: string, _params?: unknown[]): unknown[] => [], url } }),
	)
}

const base = honey<Env>()
	.errorFactory(errors)
	.defaultErrors("internal_server_error", "validation_failed")
	.meta<AppMeta>()
	.use(withDatabase("postgres://localhost:5432/demo"))
	.use(withAuth)

/* separate route */
const orgById = base
	.get("/orgs/:orgId")
	.meta({
		auth: "required",
		openApi: { summary: "Get organization by ID", tags: ["Organization"] },
	})
	.errors("not_found")
	.handler((c) => {
		return c.res.json("ok", OrgService.getById(c))
	})

/* mixed: inline chain + .route() */
export const app = base
	.get("/orgs")
	.meta({
		auth: "required",
		openApi: { operationId: "listOrgs", summary: "List organizations", tags: ["Organization"] },
		rateLimit: "strict",
	})
	.input({ search: z.object({ limit: z.number(), offset: z.number() }) })
	.output({
		"application/json": {
			ok: z.object({ items: z.string().array(), total: z.number() }),
		},
	})
	.handler((c) => {
		const result = OrgService.list(c)
		return c.res.json("ok", { items: result, total: result.length })
	})
	.post("/orgs")
	.meta({
		auth: "required",
		openApi: { summary: "Create organization", tags: ["Organization"] },
	})
	.input({ json: z.object({ name: z.string(), slug: z.string() }) })
	.errors("org_slug_taken", "org_limit_reached")
	.handler((c) => {
		const org = OrgService.create(c)
		return c.res.json("created", org)
	})
