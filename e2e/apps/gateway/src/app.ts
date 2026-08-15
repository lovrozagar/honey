import type { WSAdapter } from "@lovrozagar/honey"
import { createMiddleware, honey } from "@lovrozagar/honey"
import "@lovrozagar/honey/openapi"
import * as z from "zod"

/**
 * Reverse-proxy style: public prefix /app is stripped, trailing slashes are required,
 * docs are Swagger (kitchen/defaults use Scalar).
 *
 * Also the metaSpec fixture: a route meta type with a hidden key, a middleware that
 * contributes tenancy, a schema-stamped entity descriptor, and two documents emitted
 * from one policy (see vite.config.ts).
 */

type GatewayMeta = {
	/** published as x-permissions */
	permissions?: string[]
	/** contributed by the shard middleware, published as x-tenant */
	tenant?: string
	/** internal routing — must never reach either document */
	worker?: "edge" | "origin"
}

/* the ORM would stamp this; here it is stamped by hand */
const Article = z.object({ id: z.string(), title: z.string() }).meta({
	entity: { generated: ["id"], immutable: ["id"], softDelete: "deletedAt", table: "article" },
})

const ArticleList = z.object({
	articles: z.array(Article),
	count: z.number(),
	nextCursor: z.string().nullable(),
})

const ListQuery = z.object({ cursor: z.string().optional() }).meta({
	query: { filter: ["title"], pagination: { defaultLimit: 20, maxLimit: 100 }, sort: ["title"] },
})

/** one line, every route below it — and it cannot disagree with what it enforces */
const shard = createMiddleware(async (_ctx, next) => next({ shard: "s1" }), { meta: { tenant: "project_id" } })

export function createApp(wsAdapter?: WSAdapter) {
	const app = honey().stripPrefix("/app").trailingSlash("enforce").meta<GatewayMeta>()
	if (wsAdapter) app.wsAdapter(wsAdapter)

	app.metaSpec({
		strict: "error",
		meta: {
			permissions: "x-permissions",
			tenant: { key: "x-tenant", map: (v) => ({ param: v }) },
			worker: false,
		},
		schema: {
			entity: {
				from: ["output"],
				search: "deep",
				expand: (e: { generated?: string[]; immutable?: string[]; softDelete?: string; table: string }) => ({
					"x-entity": e.table,
					"x-generated": e.generated,
					"x-immutable": e.immutable,
					"x-soft-delete": e.softDelete ? { field: e.softDelete } : undefined,
				}),
			},
			query: { from: ["input.search"], key: "x-query" },
		},
		profiles: {
			/* default-deny: anything added later stays out until it is opted in */
			public: { include: ["x-entity", "x-query"] },
		},
	})

	app.get("/ping/").handler((ctx) => ctx.res.text("ok", "pong"))

	app
		.use(shard)
		.get("/articles/")
		.meta({ permissions: ["articles.read"], summary: "List articles", worker: "origin" })
		.input({ search: ListQuery })
		.output({ "application/json": { ok: ArticleList } })
		.handler((ctx) => ctx.res.json("ok", { articles: [], count: 0, nextCursor: null }))

	app
		.use(shard)
		.get("/articles/meta/")
		.handler((ctx) => ctx.res.json("ok", { meta: ctx.meta }))

	return app.openapi({ docs: "swagger", title: "Honey Gateway", version: "0.0.1" }).manifest()
}
