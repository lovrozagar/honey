import type { WSAdapter } from "@lovrozagar/honey"
import type { RouteTree } from "@lovrozagar/honey/tree"
import { createMiddleware, honey } from "@lovrozagar/honey"
import "@lovrozagar/honey/openapi"
import "@lovrozagar/honey/proxy"
import * as z from "zod"
import { routeTree as generatedTree } from "./_gen/routes.gen.ts"
import { users } from "./users.ts"

/**
 * Reverse-proxy style: public prefix /app is stripped, trailing slashes are required,
 * docs are Swagger (kitchen/defaults use Scalar).
 *
 * Also the gateway fixture: like a production edge gateway it boots from a generated tree that
 * `codegen.mergeTree` builds from the downstream service (`users.ts`, merged in
 * `route-tree.ts`) plus the gateway's own routes, and forwards the downstream routes through
 * its root catch-all `proxy()`.
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

/*
 * The shape a publisher takes when it stamps one reserved key with a discriminated union —
 * this is comb's contract, written out rather than imported so the fixture stays standalone.
 * The entity descriptor rides the read schema, the query descriptor the list-query schema.
 */
const Article = z.object({ id: z.string(), title: z.string() }).meta({
	"x-comb": {
		generated: ["id", "created_at"],
		identity: "id",
		immutable: ["id"],
		kind: "entity",
		name: "article",
		softDelete: "deleted_at",
		/* the publisher sees foreign keys but cannot know which table is the tenant */
		tenantColumn: null,
		v: 1,
	},
})

/* the real list response: the descriptor sits under a named key inside a pagination envelope */
const ArticleList = z.object({
	articles: z.array(Article),
	count: z.number(),
	hasMore: z.boolean(),
	nextCursor: z.string().nullable(),
})

const ListQuery = z.object({ cursor: z.string().optional() }).meta({
	"x-comb": {
		defaultOrder: "created_at.desc",
		filterable: ["title"],
		grammar: "postgrest",
		kind: "query",
		maxLimit: 100,
		/* null = not knowable at this layer, which is not the same as "none" */
		searchable: null,
		selectable: ["id", "title"],
		sortable: ["title"],
		stableTiebreak: "id",
		v: 1,
	},
})

/** one line, every route below it — and it cannot disagree with what it enforces */
const shard = createMiddleware(async (_ctx, next) => next({ shard: "s1" }), { meta: { tenant: "project_id" } })

/**
 * `routeTree`: the tree to boot from — the generated `src/_gen/routes.gen.ts` by default, `null`
 * to build the trie at runtime (the gateway's own routes only answer identically that way).
 */
export type AppOptions = { routeTree?: RouteTree | null }

export function createApp(wsAdapter?: WSAdapter, options?: AppOptions) {
	const app = honey().stripPrefix("/app").trailingSlash("enforce").meta<GatewayMeta>()
	const tree = options?.routeTree === undefined ? generatedTree : options.routeTree
	if (tree !== null) app.routeTree(tree)
	if (wsAdapter) app.wsAdapter(wsAdapter)

	app.metaSpec({
		strict: "error",
		meta: {
			permissions: "x-permissions",
			tenant: { key: "x-tenant", map: (v) => ({ param: v }) },
			worker: false,
		},
		/* two entries, one reserved key, told apart by the union's discriminant */
		schema: {
			entityFacts: {
				expand: (e: {
					generated: string[]
					identity: string
					immutable: string[]
					name: string
					softDelete: string | null
					tenantColumn: string | null
				}) => ({
					"x-entity": e.name,
					"x-generated": e.generated,
					"x-identity": e.identity,
					"x-immutable": e.immutable,
					/* a null the publisher could not determine omits the key — it never
					   becomes a null tag, which a consumer would read as "definitively none" */
					"x-soft-delete": e.softDelete ?? undefined,
					"x-tenant-column": e.tenantColumn ?? undefined,
				}),
				from: ["output"],
				match: { kind: "entity" },
				read: "x-comb",
				search: "deep",
				version: { max: 1 },
			},
			queryFacts: {
				expand: (q: {
					filterable: string[]
					maxLimit: number
					searchable: string[] | null
					selectable: string[]
					sortable: string[]
				}) => ({
					"x-query": {
						filter: q.filterable,
						maxLimit: q.maxLimit,
						select: q.selectable,
						sort: q.sortable,
					},
					"x-searchable": q.searchable ?? undefined,
				}),
				from: ["input.search"],
				match: { kind: "query" },
				read: "x-comb",
				version: { max: 1 },
			},
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
		.handler((ctx) => ctx.res.json("ok", { articles: [], count: 0, hasMore: false, nextCursor: null }))

	app
		.use(shard)
		.get("/articles/meta/")
		.handler((ctx) => ctx.res.json("ok", { meta: ctx.meta }))

	/* own routes next to the catch-all, in a production gateway's shape: a param route and a
	   versioned docs route the downstream services never see */
	app
		.get("/nl/c/:delivery/:url/")
		.handler((ctx) => ctx.res.json("ok", { delivery: ctx.params.delivery, url: ctx.params.url }))
	app.get("/v1/openapi/spec/").handler((ctx) => ctx.res.json("ok", { spec: "gateway" }))

	/* every downstream route delegates here with its own pattern and meta */
	app.all("/*").proxy({
		destination: (_ctx, url, init) => users.fetch(new Request(new URL(url, "http://users.internal"), init), {}),
	})

	return app.openapi({ docs: "swagger", title: "Honey Gateway", version: "0.0.1" }).manifest()
}
