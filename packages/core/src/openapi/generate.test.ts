import { JSONSchema, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as v from "valibot"
import * as z from "zod"
import { defineErrors } from "../errors/errors.ts"
import { readableStream } from "../input/input.ts"
import { createMiddleware } from "../middleware/middleware.ts"
import { honey } from "../routing/app.ts"
import { gatewayTree } from "../routing/gateway-tree.ts"
import { createNode, insertRoute, type RouteEntry, type RouteTree } from "../routing/tree.ts"
import { mergeTree } from "../routing/tree-merge.ts"
import { SILENT, type Logger } from "../telemetry/logger.ts"
import { generateOpenApi } from "./generate.ts"

const INFO = { title: "T", version: "1" }

/** A logger that keeps each warning's message. */
function recording(): { logger: Logger; warnings: string[] } {
	const warnings: string[] = []
	const warn = (first: unknown, second?: unknown) =>
		void warnings.push(String(typeof first === "string" ? first : second))
	return { logger: { ...SILENT, warn }, warnings }
}

type Operation = Record<string, unknown>
const op = (doc: ReturnType<typeof generateOpenApi>, path: string, method = "get") =>
	(doc.paths[path]?.[method] ?? {}) as Operation

/** A schema of `schema` with every component reference followed. */
function resolved(doc: ReturnType<typeof generateOpenApi>, schema: unknown): Record<string, unknown> {
	const ref = (schema as { $ref?: string }).$ref
	return ref === undefined
		? (schema as Record<string, unknown>)
		: (doc.components?.schemas?.[ref.split("/").pop() as string] ?? {})
}

describe("generateOpenApi: synchronous, and the metaSpec it is built with", () => {
	// v0: 3b5bb5fab8
	it("writes the built-in policy's keys in its order when no metaSpec is declared, and leaves an internal route out", () => {
		const app = honey<{}>()
		app.get("/users").handler((c) => c.res.json("ok", []))
		app
			.post("/users")
			.meta({
				deprecated: true,
				description: "d",
				invalidate: ["GET /users"],
				mcp: true,
				operationId: "users.create",
				security: "jwt",
				summary: "s",
				tags: "Users",
			})
			.handler((c) => c.res.json("ok", {}))
		app
			.get("/secret")
			.meta({ internal: true })
			.handler((c) => c.res.text("ok", "ok"))
		const doc = generateOpenApi(app, { info: INFO, securitySchemes: { jwt: { scheme: "bearer", type: "http" } } })
		expect([Object.keys(op(doc, "/users", "post")), doc.paths["/secret"]]).toEqual([
			[
				"summary",
				"description",
				"tags",
				"deprecated",
				"operationId",
				"security",
				"x-invalidate",
				"x-mcp",
				"x-honey-route",
				"responses",
			],
			undefined,
		])
	})

	// v0: 57c863da1c
	it("builds the document of the profile it is asked for", () => {
		const app = honey<{}>().meta<{ tenant?: string }>()
		app.metaSpec({ meta: { tenant: "x-tenant" }, profiles: { public: { exclude: ["x-tenant"] } } })
		app
			.get("/a")
			.meta({ tenant: "orgId" })
			.handler((c) => c.res.text("ok", "ok"))
		expect([
			op(generateOpenApi(app, { info: INFO }), "/a")["x-tenant"],
			op(generateOpenApi(app, { info: INFO, profile: "public" }), "/a")["x-tenant"],
		]).toEqual(["orgId", undefined])
	})
})

describe("generateOpenApi: one diagnostics channel", () => {
	// v0: b1941b54e2
	it("throws every policy error at once, one aggregate", () => {
		const app = honey<{}>().meta<{ rateLimit?: string; worker?: string }>()
		app.metaSpec({ meta: {} } as never)
		app
			.get("/a")
			.meta({ rateLimit: "ai", worker: "w" })
			.handler((c) => c.res.text("ok", "ok"))
		expect(() => generateOpenApi(app, { info: INFO })).toThrow(/2 policy error.*MISSING_ENTRY/s)
	})

	// v0: 3e900e5370
	it("hands each warning to the logger, never the console, and still generates", () => {
		const app = honey<{}>().meta<{ rateLimit?: string }>()
		app.metaSpec({ meta: { permissions: "x-permissions" }, strict: "warn" } as never)
		app
			.get("/a")
			.meta({ permissions: ["read"], rateLimit: "ai" } as never)
			.handler((c) => c.res.text("ok", "ok"))
		const { logger, warnings } = recording()
		const doc = generateOpenApi(app, { info: INFO, logger })
		expect([op(doc, "/a")["x-permissions"], warnings]).toEqual([
			["read"],
			[expect.stringMatching(/MISSING_ENTRY.*rateLimit/s)],
		])
	})

	it("fails on a schema that cannot be converted at all under onSchemaError throw, and documents {} with a warning under warn", () => {
		const broken = {
			"~standard": {
				jsonSchema: {
					input: () => {
						throw new Error("nope")
					},
				},
				validate: (value: unknown) => ({ value }),
				vendor: "x",
				version: 1 as const,
			},
		}
		const app = honey<{}>()
		app
			.post("/a")
			.input({ json: broken })
			.handler((c) => c.res.text("ok", "ok"))
		const { logger, warnings } = recording()
		expect(() => generateOpenApi(app, { info: INFO })).toThrow(/SCHEMA_FAILED.*POST \/a/s)
		const doc = generateOpenApi(app, { info: INFO, logger, onSchemaError: "warn" })
		const body = (op(doc, "/a", "post").requestBody as { content: Record<string, { schema: unknown }> }).content
		expect([resolved(doc, body["application/json"]?.schema), warnings]).toEqual([
			{},
			[expect.stringMatching(/SCHEMA_FAILED.*nope/s)],
		])
	})
})

describe("generateOpenApi: which routes it documents", () => {
	// v0: cacd59d5da
	// v0: fab8f185bc
	// v0: 357170d642
	it("documents every route without filterRoutes, drops the ones it rejects, and always hands it an object for meta", () => {
		const app = honey<{}>().meta<{ auth?: false | string }>()
		app
			.get("/public")
			.meta({ auth: false })
			.handler((c) => c.res.text("ok", "ok"))
		app
			.get("/dashboard")
			.meta({ auth: "jwt" })
			.handler((c) => c.res.text("ok", "ok"))
		app.get("/plain").handler((c) => c.res.text("ok", "ok"))
		const seen: unknown[] = []
		const filtered = generateOpenApi(app, {
			filterRoutes: (route) => {
				seen.push(route.meta)
				return (route.meta as { auth?: unknown }).auth !== "jwt"
			},
			info: INFO,
		})
		expect([Object.keys(generateOpenApi(app, { info: INFO }).paths), Object.keys(filtered.paths), seen]).toEqual([
			["/public", "/dashboard", "/plain"],
			["/public", "/plain"],
			[{ auth: false }, { auth: "jwt" }, {}],
		])
	})

	// v0: 7ed08f4048
	// v0: bf4113228d
	it("reads each route's resolved meta, middleware's included, the same standalone and mounted behind a gateway", () => {
		const shard = createMiddleware(async (_c, next) => next({}), { meta: { tenant: "project_id" } })
		const worker = () => {
			const w = honey<{}>().meta<{ tenant?: string }>()
			w.metaSpec({ meta: { tenant: { key: "x-tenant", map: (value) => ({ column: value }) } } })
			w.use(shard)
				.get("/orgs/:orgId/users")
				.meta({ summary: "List" })
				.handler((c) => c.res.json("ok", {}))
			return w
		}
		const standalone = generateOpenApi(worker(), { info: INFO })
		const gateway = honey<{}>()
		gateway.route(worker())
		const mounted = generateOpenApi(gateway, { info: INFO })
		expect([
			op(standalone, "/orgs/{orgId}/users")["x-tenant"],
			JSON.stringify(op(mounted, "/orgs/{orgId}/users")),
		]).toEqual([{ column: "project_id" }, JSON.stringify(op(standalone, "/orgs/{orgId}/users"))])
	})
})

describe("generateOpenApi: schemas, from every vendor and the converters it is given", () => {
	// v0: 6b98b9158b
	it("converts each slot through its own vendor: zod in, valibot out", () => {
		const app = honey<{}>()
		app
			.post("/items")
			.input({ json: z.object({ name: z.string() }) })
			.output({ "application/json": { ok: v.object({ id: v.string(), name: v.string() }) } })
			.handler((c) => c.res.json("ok", { id: "1", name: "n" }))
		const doc = generateOpenApi(app, { info: INFO })
		const post = op(doc, "/items", "post") as {
			requestBody: { content: Record<string, { schema: unknown }> }
			responses: Record<string, { content: Record<string, { schema: unknown }> }>
		}
		expect([
			resolved(doc, post.requestBody.content["application/json"]?.schema).type,
			resolved(doc, post.responses["200"]?.content["application/json"]?.schema).properties,
		]).toEqual(["object", { id: { type: "string" }, name: { type: "string" } }])
	})

	// v0: b3ec257e17
	it("hands Effect schemas to the converter the caller passes, lifting its $defs into components", () => {
		const app = honey<{}>()
		app
			.post("/items")
			.input({ json: Schema.standardSchemaV1(Schema.Struct({ at: Schema.Date, name: Schema.String })) })
			.handler((c) => c.res.text("ok", "ok"))
		const doc = generateOpenApi(app, { converters: { effect: JSONSchema.make }, info: INFO })
		const body = resolved(
			doc,
			(op(doc, "/items", "post").requestBody as { content: Record<string, { schema: unknown }> }).content[
				"application/json"
			]?.schema,
		)
		expect([body.properties, doc.components?.schemas?.Date]).toEqual([
			{ at: { $ref: "#/components/schemas/Date" }, name: { type: "string" } },
			{ description: "a string to be decoded into a Date", type: "string" },
		])
	})
})

describe("generateOpenApi: schema-derived meta reads the route's own schemas", () => {
	const User = z.object({ id: z.string() }).meta({ entity: { name: "user" } })

	// v0: 873fa23717
	// v0: cc7dfec1a1
	it("reads the lowest 2xx JSON output first, then input.search, through the converted schemas", () => {
		const app = honey<{}>()
		app.metaSpec({
			schema: { entity: { expand: (e: { name: string }) => ({ "x-entity": e.name, "x-generated": ["id"] }) } },
		})
		const Search = z.object({ q: z.string().optional() }).meta({ entity: { name: "search" } })
		app
			.get("/both")
			.input({ search: Search })
			.output({ "application/json": { created: z.object({}).meta({ entity: { name: "late" } }), ok: User } })
			.handler((c) => c.res.json("ok", { id: "1" }))
		app
			.get("/search-only")
			.input({ search: Search })
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((c) => c.res.json("ok", { id: "1" }))
		const doc = generateOpenApi(app, { info: INFO })
		expect([
			op(doc, "/both")["x-entity"],
			op(doc, "/both")["x-generated"],
			op(doc, "/search-only")["x-entity"],
		]).toEqual(["user", ["id"], "search"])
	})
})

/** A mutation and the read of its path, with no invalidate declared. */
function tables() {
	const a = honey<{}>()
	a.post("/tables").handler((c) => c.res.text("ok", "ok"))
	a.get("/tables").handler((c) => c.res.text("ok", "ok"))
	return a
}

/** A response schema stamped with an entity descriptor named `name`. */
const stamped = (name: string) => z.object({ id: z.string() }).meta({ "x-comb": { kind: "entity", name, v: 1 } })

describe("generateOpenApi: the invalidate check over the emitted operations", () => {
	// v0: b8477643fe
	// v0: 0bcbc6086f
	// v0: 5ebbe7eb78
	it("warns through the logger by default, fails under error, says nothing under off, and refuses a selector naming no route", () => {
		const { logger, warnings } = recording()
		generateOpenApi(tables(), { info: INFO, logger })
		generateOpenApi(tables(), { info: INFO, invalidate: "off", logger })
		expect(warnings).toEqual([expect.stringMatching(/POST\s+\/tables → GET \/tables/)])
		expect(() => generateOpenApi(tables(), { info: INFO, invalidate: "error" })).toThrow(
			/honey:invalidate.*1 mutation/s,
		)
		const typo = honey<{}>()
		typo
			.post("/users")
			.meta({ invalidate: ["GET /userz"] } as never)
			.handler((c) => c.res.text("ok", "ok"))
		expect(() => generateOpenApi(typo, { info: INFO })).toThrow(/INVALID_SELECTOR.*GET \/userz/s)
		expect(() => generateOpenApi(typo, { info: INFO, invalidate: "off" })).not.toThrow()
	})

	// v0: 6339079314
	it("reads entities off the emitted operations when given an entity key", () => {
		const a = honey<{}>()
		a.metaSpec({
			schema: {
				entityFacts: {
					expand: (e: { name: string }) => ({ "x-entity": e.name }),
					match: { kind: "entity" },
					read: "x-comb",
					search: "deep",
				},
			},
		})
		a.post("/admin/provision-table")
			.output({ "application/json": { ok: stamped("table") } })
			.handler((c) => c.res.json("ok", { id: "1" }))
		a.get("/v2/tables")
			.output({ "application/json": { ok: stamped("table") } })
			.handler((c) => c.res.json("ok", { id: "1" }))
		const { logger, warnings } = recording()
		generateOpenApi(a, { info: INFO, invalidate: { entityKey: "x-entity" }, logger })
		expect(warnings).toEqual([expect.stringMatching(/POST \/admin\/provision-table → GET \/v2\/tables/)])
	})
})

/** A generated-style tree: topology and route data, no live records and no schemas. */
function treeOf(routes: readonly (readonly [string, string, RouteEntry?])[]): RouteTree {
	const root = createNode()
	const entries: Record<string, RouteEntry> = {}
	for (const [method, path, entry] of routes) entries[insertRoute(root, method as "GET", path)] = entry ?? {}
	return { meta: {}, root, routes: entries, v: 2 }
}

/** A gateway's own routes beside a root /:slug and the catch-all its downstream routes delegate to. */
function gatewayOwn(tree?: RouteTree) {
	const app = honey<{}>()
	if (tree !== undefined) app.routeTree(tree)
	app.get("/health").handler((c) => c.res.text("ok", "up"))
	app.get("/:slug").handler((c) => c.res.text("ok", "slug"))
	app.all("/*").handler((c) => c.res.text("ok", "proxy"))
	return app
}

describe("generateOpenApi: documents of loaded trees and gateways", () => {
	// v0: e2a4cc95c9
	// v0: 438b804def
	// v0: 0b05bc22a6
	it("documents a loaded tree's leaves by their metadata, while the live app keeps bodies, answers and parameters", () => {
		const live = honey<{}>()
		live
			.post("/v1/projects/:project_id/suggest-schema")
			.input({ json: z.object({ url: z.string() }), search: z.object({ limit: z.number().optional() }) })
			.output({ "application/json": { ok: z.object({ schema: z.string() }) } })
			.handler((c) => c.res.json("ok", { schema: "s" }))
		const intern = honey<{}>().routeTree(
			treeOf([["POST", "/v1/projects/:project_id/suggest-schema", { mt: { summary: "Suggest" } }]]),
		)
		const fromLive = op(generateOpenApi(live, { info: INFO }), "/v1/projects/{project_id}/suggest-schema", "post")
		const fromTree = op(generateOpenApi(intern, { info: INFO }), "/v1/projects/{project_id}/suggest-schema", "post")
		expect([
			Object.keys(fromLive),
			Object.keys(fromTree),
			(fromLive.parameters as { name: string }[]).map((p) => p.name),
		]).toEqual([
			["x-honey-route", "requestBody", "parameters", "responses"],
			["summary", "x-honey-route", "parameters", "responses"],
			["project_id", "limit"],
		])
	})

	// v0: dc053efc6e
	it("documents a gateway's own routes beside its downstream ones", () => {
		const users = honey<{}>()
		users.get("/users/list").handler((c) => c.res.text("ok", "remote"))
		users.get("/users/:id").handler((c) => c.res.text("ok", "remote"))
		const app = gatewayOwn(gatewayTree(gatewayOwn(), mergeTree([users.toRouteTree(), { worker: "users" }])))
		expect(Object.keys(generateOpenApi(app, { info: INFO }).paths)).toEqual(
			expect.arrayContaining(["/health", "/users/list", "/users/{id}", "/{slug}"]),
		)
	})
})

/** A Standard schema of `vendor` that accepts anything, publishing `jsonSchema` when given one. */
const standard = (vendor: string, jsonSchema?: Record<string, () => unknown>) => ({
	"~standard": { jsonSchema, validate: (value: unknown) => ({ value }), vendor, version: 1 as const },
})

describe("generateOpenApi: schemas no converter can describe", () => {
	it("documents a vendor no converter knows unconstrained with a warning, and reports a thrown non-Error by its text", () => {
		const app = honey<{}>()
		app
			.post("/a")
			.input({ json: standard("mystery") })
			.handler((c) => c.res.text("ok", "ok"))
		app
			.post("/b")
			.input({
				json: standard("x", {
					input: () => {
						throw "plain"
					},
				}),
			})
			.handler((c) => c.res.text("ok", "ok"))
		const { logger, warnings } = recording()
		generateOpenApi(app, { info: INFO, logger, onSchemaError: "warn" })
		expect(warnings).toEqual([
			expect.stringMatching(/SCHEMA_DEGRADED.*POST \/a.*no JSON Schema converter for vendor "mystery"/s),
			expect.stringMatching(/SCHEMA_FAILED.*POST \/b.*could not be converted: plain/s),
		])
	})
})

/** An object schema stamped with an entity named `name`. */
const named = (name: string) => z.object({ id: z.string() }).meta({ entity: { name } })

describe("generateOpenApi: schema-derived meta over every shape a route takes", () => {
	it("reads a WS route's search, skips a binary body, unwraps a stream, and reads no output from an error, a bare body or none", () => {
		const app = honey<{}>()
		app.metaSpec({ schema: { entity: { expand: (e: { name: string }) => ({ "x-entity": e.name }) } } })
		app
			.ws("/live")
			.input({ search: named("live") })
			.handler({ onMessage() {} })
		app
			.post("/upload")
			.input({ binary: "image/png" })
			.handler((c) => c.res.text("ok", "ok"))
		app
			.post("/stream")
			.input({ json: readableStream(named("stream")) })
			.handler((c) => c.res.text("ok", "ok"))
		app
			.get("/missing")
			.output({ "application/json": { not_found: named("missing") } })
			.handler((c) => c.res.json("not_found", { id: "1" }))
		app
			.get("/bare")
			.output({ "application/json": { ok: true } })
			.handler((c) => c.res.json("ok", {}))
		const doc = generateOpenApi(app, { info: INFO })
		expect(
			[["/live"], ["/upload", "post"], ["/stream", "post"], ["/missing"], ["/bare"]].map(
				([path, method]) => op(doc, path as string, method)["x-entity"],
			),
		).toEqual(["live", undefined, "stream", undefined, undefined])
	})
})

describe("generateOpenApi: the declared errors for codegen (x-honey-errors, x-honey-error)", () => {
	it("lists every declared key with its status and own schema, and marks only the responses errors produce", () => {
		const errors = defineErrors({
			taken: "conflict",
			too_big: { schema: z.object({ limit: z.number() }), status: "unprocessable_entity" },
		})
		const app = honey<{}>().errorFactory(errors)
		app
			.post("/items")
			.errors("taken", "too_big")
			.output({ "application/json": { conflict: z.object({ existing: z.string() }), created: z.object({}) } })
			.handler((c) => c.res.json("created", {}))
		const doc = generateOpenApi(app, { info: INFO })
		const operation = op(doc, "/items", "post")
		const declared = operation["x-honey-errors"] as Record<string, { schema?: unknown; status: number | null }>
		const marked = Object.entries(operation.responses as Record<string, Record<string, unknown>>).map(
			([code, response]) => [code, response["x-honey-error"] ?? false],
		)
		expect([Object.keys(declared), declared.taken, declared.too_big?.status, marked]).toEqual([
			["taken", "too_big"],
			{ status: 409 },
			422,
			[
				["201", false],
				["409", false],
				["422", true],
			],
		])
		expect(resolved(doc, declared.too_big?.schema)).toMatchObject({ properties: { limit: { type: "number" } } })
	})
})
