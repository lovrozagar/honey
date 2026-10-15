import { describe, expect, it } from "vitest"
import * as z from "zod"
import { defineErrors } from "../errors/errors.ts"
import { defineMiddleware } from "../middleware/middleware.ts"
import { honey } from "../routing/app.ts"
import { gatewayTree, overlaySchemas } from "../routing/gateway-tree.ts"
import { createNode, insertRoute, type RouteTree } from "../routing/tree.ts"
import { mergeTree } from "../routing/tree-merge.ts"
import { generateOpenApi } from "./generate.ts"

const INFO = { title: "T", version: "1" }
type Doc = ReturnType<typeof generateOpenApi>
type Response = {
	content?: Record<string, { schema?: unknown }>
	description: string
	headers?: Record<string, unknown>
}

const responses = (doc: Doc, path: string, method: string | undefined = "get") =>
	(doc.paths[path]?.[method]?.responses ?? {}) as Record<string, Response>

/** `schema` with a component reference followed. */
function resolved(doc: Doc, schema: unknown): Record<string, unknown> {
	const ref = (schema as { $ref?: string } | undefined)?.$ref
	if (ref === undefined) return (schema ?? {}) as Record<string, unknown>
	return doc.components?.schemas?.[ref.split("/").pop() as string] ?? {}
}

/** The error body schema of `status`, under `media`. */
const errorSchema = (doc: Doc, path: string, status: string, at: { media?: string; method?: string } = {}) =>
	resolved(doc, responses(doc, path, at.method)[status]?.content?.[at.media ?? "application/json"]?.schema)

const keysOf = (schema: Record<string, unknown>) =>
	(schema.properties as { error_key?: { enum?: string[] } } | undefined)?.error_key?.enum

describe("success responses: by status, by media type", () => {
	// v0: ca15579e68
	// v0: 29dac10176
	// v0: ad4cf8839b
	// v0: b08bfff521

	it("documents each status key under its code with the converted schema", () => {
		const app = honey<{}>()
		app
			.post("/items")
			.output({
				"application/json": { created: z.object({ id: z.string() }), ok: z.object({ ids: z.array(z.string()) }) },
			})
			.handler((c) => c.res.json("ok", { ids: [] }))
		const doc = generateOpenApi(app, { info: INFO })
		const r = responses(doc, "/items", "post")
		expect([
			Object.keys(r),
			r["201"]?.description,
			resolved(doc, r["201"]?.content?.["application/json"]?.schema),
		]).toEqual([
			["200", "201"],
			"created",
			{ additionalProperties: false, properties: { id: { type: "string" } }, required: ["id"], type: "object" },
		])
	})

	// v0: 1fa5da333b
	// v0: d7d6c63d0f

	it("keeps each media type's schema at one status, documents a body with no schema bare, and answers 200 Success for a route that declares nothing", () => {
		const app = honey<{}>()
		app
			.get("/doc")
			.output({
				"application/json": { ok: z.object({ id: z.string() }) },
				"application/pdf": { ok: true },
				"text/csv": { ok: z.string() },
			})
			.handler((c) => c.res.json("ok", { id: "1" }))
		app.get("/bare").handler((c) => c.res.text("ok", "ok"))
		const doc = generateOpenApi(app, { info: INFO })
		const content = responses(doc, "/doc")["200"]?.content ?? {}
		expect([
			Object.keys(content),
			content["application/pdf"],
			resolved(doc, content["text/csv"]?.schema),
			responses(doc, "/bare"),
		]).toEqual([
			["application/json", "application/pdf", "text/csv"],
			{},
			{ type: "string" },
			{ "200": { description: "Success" } },
		])
	})
})

describe("redirects and declared headers", () => {
	// v0: f5d269dceb
	// v0: 331c67f8cf
	// v0: 7c63527a4f

	it("documents a redirect by its code with a Location header and no body, beside a JSON answer", () => {
		const app = honey<{}>()
		app
			.get("/oauth/callback")
			.output({ redirect: { found: true } })
			.handler((c) => c.res.redirect("https://example.com"))
		app
			.get("/moved")
			.output({ redirect: { moved_permanently: true } })
			.handler((c) => c.res.redirect("/new", { status: 301 }))
		app
			.get("/mixed")
			.output({ "application/json": { ok: z.object({ id: z.string() }) }, redirect: { found: true } })
			.handler((c) => c.res.json("ok", { id: "1" }))
		const doc = generateOpenApi(app, { info: INFO })
		const location = { Location: { description: "Redirect target URL", schema: { format: "uri", type: "string" } } }
		expect([
			responses(doc, "/oauth/callback"),
			responses(doc, "/moved")["301"],
			Object.keys(responses(doc, "/mixed")),
		]).toEqual([
			{ "302": { description: "found", headers: location } },
			{ description: "moved permanently", headers: location },
			["200", "302"],
		])
	})

	it("documents the headers each status declares, by name, with their schemas and whether they are required", () => {
		const app = honey<{}>()
		app
			.post("/users")
			.output({
				"application/json": { created: z.object({ id: z.string() }) },
				headers: {
					created: z.object({ etag: z.string().optional(), location: z.string() }),
					found: z.object({ location: z.string() }),
				},
				redirect: { found: true },
			})
			.handler((c) => c.res.json("created", { id: "1" }, { headers: { location: "/users/1" } }))
		const r = responses(generateOpenApi(app, { info: INFO }), "/users", "post")
		expect([r["201"]?.headers, r["302"]?.headers]).toEqual([
			{
				etag: { required: false, schema: { type: "string" } },
				location: { required: true, schema: { type: "string" } },
			},
			{ location: { required: true, schema: { type: "string" } } },
		])
	})
})

describe("errors in honey's envelope (the default format)", () => {
	// v0: 57edf5ff79
	// v0: 2b63ae7db8
	// v0: 9136b422cf
	// v0: 4544bfa655
	// v0: 68f4933c56
	// v0: 08d9f2a22b

	it("documents every key of a status in one envelope: its key and status as enums, every field required, no vars", () => {
		const errors = defineErrors({ email_taken: "conflict", forbidden: "forbidden", slug_taken: "conflict" })
		const app = honey<{}>().errorFactory(errors)
		app
			.post("/orgs")
			.errors("slug_taken", "email_taken", "forbidden")
			.handler((c) => c.res.json("ok", {}))
		const doc = generateOpenApi(app, { info: INFO })
		expect([
			Object.keys(responses(doc, "/orgs", "post")),
			responses(doc, "/orgs", "post")["409"]?.description,
			errorSchema(doc, "/orgs", "409", { method: "post" }),
		]).toEqual([
			["403", "409"],
			"email_taken, slug_taken",
			{
				properties: {
					error_key: { enum: ["email_taken", "slug_taken"], type: "string" },
					fields: {
						additionalProperties: {
							items: {
								properties: { error_key: { type: "string" }, message: { type: "string" }, path: { type: "string" } },
								required: ["error_key", "message", "path"],
								type: "object",
							},
							type: "array",
						},
						type: "object",
					},
					message: { type: "string" },
					status: { enum: [409], type: "integer" },
					status_key: { type: "string" },
					success: { const: false },
				},
				required: ["error_key", "fields", "message", "status", "status_key", "success"],
				type: "object",
			},
		])
	})

	// v0: 3f4bf5cb56
	// v0: bbc57a1707
})

describe("errors in honey's envelope (the default format)", () => {
	it("puts a named key in its own route's enum only, beside the app's default keys", () => {
		const errors = defineErrors({ item_not_found: "not_found", not_found: "not_found" })
		const app = honey<{}>().errorFactory(errors).defaultErrors("not_found")
		app
			.get("/items/:id")
			.errors("item_not_found")
			.handler((c) => c.res.json("ok", {}))
		app.get("/other").handler((c) => c.res.json("ok", {}))
		const doc = generateOpenApi(app, { info: INFO })
		expect([keysOf(errorSchema(doc, "/items/{id}", "404")), keysOf(errorSchema(doc, "/other", "404"))]).toEqual([
			["item_not_found", "not_found"],
			["not_found"],
		])
	})
})

describe("errors: a custom envelope schema", () => {
	// v0: 1bc774a242
	// v0: 12722ca715
	// v0: 982ae0db13
	// v0: e7683d5d1e

	it("replaces the envelope with the formatter's schema, injecting the key and status enums only where it has those fields", () => {
		const errors = defineErrors({ email_taken: "conflict", unauthorized: "unauthorized" })
		const withKeys = z.object({
			error_key: z.string(),
			message: z.string(),
			status: z.number().int(),
			success: z.literal(false),
		})
		const without = z.object({ code: z.string(), ok: z.literal(false) })
		const base = () => honey<{}>().errorFactory(errors)
		const schemaUnder = (formatter: (app: ReturnType<typeof base>) => void) => {
			const app = base()
			formatter(app)
			app
				.post("/a")
				.errors("email_taken")
				.handler((c) => c.res.json("ok", {}))
			return errorSchema(generateOpenApi(app, { info: INFO }), "/a", "409", { method: "post" })
		}
		const keyed = schemaUnder((app) =>
			app.defaultErrorFormatter(withKeys, (e) => ({
				error_key: e.errorKey,
				message: e.message,
				status: e.status,
				success: false as const,
			})),
		)
		const plain = schemaUnder((app) =>
			app.defaultErrorFormatter(without, (e) => ({ code: e.errorKey, ok: false as const })),
		)
		const fnOnly = schemaUnder((app) => app.defaultErrorFormatter((_e, shape) => ({ ...shape, at: 1 })))
		expect([
			keysOf(keyed),
			(keyed.properties as { status: unknown }).status,
			Object.keys(plain.properties as object),
			Object.keys(fnOnly.properties as object),
		]).toEqual([
			["email_taken"],
			{ enum: [409], type: "integer" },
			["code", "ok"],
			["error_key", "fields", "message", "status", "status_key", "success"],
		])
	})

	// v0: 25e0e68c8f
	// v0: 6744f5498a
})

describe("errors: a custom envelope schema", () => {
	it("is the app's setting, so it holds under basePath() and use()", () => {
		const errors = defineErrors({ unauthorized: "unauthorized" })
		const app = honey<{}>()
			.errorFactory(errors)
			.defaultErrorFormatter(z.object({ code: z.string(), ok: z.literal(false) }), (e) => ({
				code: e.errorKey,
				ok: false as const,
			}))
		app
			.basePath("/v1")
			.get("/a")
			.errors("unauthorized")
			.handler((c) => c.res.json("ok", {}))
		app
			.use(defineMiddleware({ fn: async (_c, next) => next() }))
			.get("/b")
			.errors("unauthorized")
			.handler((c) => c.res.json("ok", {}))
		const doc = generateOpenApi(app, { info: INFO })
		expect([
			Object.keys(errorSchema(doc, "/v1/a", "401").properties as object),
			Object.keys(errorSchema(doc, "/b", "401").properties as object),
		]).toEqual([
			["code", "ok"],
			["code", "ok"],
		])
	})
})

const schemaErrors = () =>
	defineErrors({
		item_gone: { schema: z.object({ reason: z.string() }), status: "not_found" },
		rate_limited: { schema: z.object({ retry_after: z.number() }), status: "too_many_requests" },
		user_not_found: "not_found",
	})

describe("errors with a schema of their own", () => {
	// v0: 0384b54dcc
	// v0: b3854d7e37
	// v0: 89d1696514
	// v0: ccf2e07f22

	it("documents a schema error by its own body, each at its status, beside 2xx answers", () => {
		const app = honey<{}>().errorFactory(schemaErrors())
		app
			.get("/a")
			.errors("item_gone", "rate_limited")
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((c) => c.res.json("ok", { id: "1" }))
		const doc = generateOpenApi(app, { info: INFO })
		expect([
			Object.keys(responses(doc, "/a")),
			Object.keys(errorSchema(doc, "/a", "404").properties as object),
			Object.keys(errorSchema(doc, "/a", "429").properties as object),
			responses(doc, "/a")["404"]?.description,
		]).toEqual([["200", "404", "429"], ["reason"], ["retry_after"], "item_gone"])
	})

	// v0: 3303cc38a5
	// v0: e2136c2427

	it("offers a standard key and a schema error at one status as oneOf, merging the custom schema into each schema error by allOf", () => {
		const app = honey<{}>()
			.errorFactory(schemaErrors())
			.customErrorFormatter(z.object({ trace: z.string() }), (_e, data) => ({ ...data, trace: "t" }))
		app
			.get("/a")
			.errors("item_gone", "user_not_found")
			.handler((c) => c.res.json("ok", {}))
		const doc = generateOpenApi(app, { info: INFO })
		const [standard, custom] = (errorSchema(doc, "/a", "404").oneOf ?? []) as Record<string, unknown>[]
		expect([
			keysOf(resolved(doc, standard)),
			Object.keys(resolved(doc, custom)),
			responses(doc, "/a")["404"]?.description,
		]).toEqual([["user_not_found"], ["allOf"], "item_gone, user_not_found"])
	})
})

describe("errors as Problem Details (errorFormat problem+json)", () => {
	it("documents standard errors as application/problem+json, their type URIs and status as enums, and schema errors under application/json", () => {
		const app = honey<{}>().errorFactory(schemaErrors()).errorFormat("problem+json")
		app
			.get("/a")
			.errors("user_not_found", "item_gone")
			.handler((c) => c.res.json("ok", {}))
		const doc = generateOpenApi(app, { info: INFO })
		const problem = errorSchema(doc, "/a", "404", { media: "application/problem+json", method: "get" })
		expect([
			Object.keys(responses(doc, "/a")["404"]?.content ?? {}),
			problem.required,
			(problem.properties as Record<string, unknown>).type,
			(problem.properties as Record<string, unknown>).status,
			Object.keys(errorSchema(doc, "/a", "404").properties as object),
		]).toEqual([
			["application/problem+json", "application/json"],
			["detail", "status", "title", "type"],
			{ enum: ["https://honey.dev/errors/user_not_found"], type: "string" },
			{ enum: [404], type: "integer" },
			["reason"],
		])
	})

	it("documents a status of standard keys as problem+json only, and one of schema errors as application/json only", () => {
		const app = honey<{}>().errorFactory(schemaErrors()).errorFormat("problem+json")
		app
			.get("/plain")
			.errors("user_not_found")
			.handler((c) => c.res.json("ok", {}))
		app
			.get("/own")
			.errors("item_gone")
			.handler((c) => c.res.json("ok", {}))
		const doc = generateOpenApi(app, { info: INFO })
		expect([
			Object.keys(responses(doc, "/plain")["404"]?.content ?? {}),
			Object.keys(responses(doc, "/own")["404"]?.content ?? {}),
		]).toEqual([["application/problem+json"], ["application/json"]])
	})
})

/** A gateway's or a worker's errors: the shared keys and `extra`. */
const errorsOf = <const TExtra extends Record<string, "bad_request" | "conflict">>(extra: TExtra) =>
	defineErrors({ internal_server_error: "internal_server_error", optimistic_lock_conflict: "conflict", ...extra })

describe("errors: where a key's status comes from", () => {
	// v0: 5e035db0c2
	// v0: fd7332a3e0

	it("takes a loaded leaf's status from the factory of the app it came from, then the key's status suffix", () => {
		const worker = honey<{}>()
			.errorFactory(defineErrors({ item_not_found: "not_found", not_found: "not_found" }))
			.defaultErrors("not_found")
		worker
			.get("/items/:id")
			.errors("item_not_found")
			.handler((c) => c.res.json("ok", {}))
		const gateway = honey<{}>()
			.errorFactory(defineErrors({ not_found: "not_found" }))
			.routeTree(worker.toRouteTree())
		const root = createNode()
		const id = insertRoute(root, "GET", "/events/:id")
		const loose = honey<{}>().routeTree({ meta: {}, root, routes: { [id]: { ek: ["billing_event_not_found"] } }, v: 2 })
		const doc = generateOpenApi(gateway, { info: INFO })
		expect([
			keysOf(errorSchema(doc, "/items/{id}", "404")),
			Object.keys(responses(generateOpenApi(loose, { info: INFO }), "/events/{id}")),
		]).toEqual([["item_not_found", "not_found"], ["404"]])
	})

	// v0: 41d060c00f
	it("documents a delegated route's own keys under its own app's statuses, beside the gateway's default keys", () => {
		const down = honey<{}>()
			.errorFactory(errorsOf({ column_name_taken: "conflict" }))
			.defaultBoundary("internal_server_error")
		down
			.post("/columns")
			.errors("column_name_taken", "optimistic_lock_conflict")
			.handler((c) => c.res.json("ok", {}))
		const source = mergeTree([down.toRouteTree(), { worker: "down" }])
		const gateway = (tree?: RouteTree) => {
			const app = honey<{}>()
				.errorFactory(errorsOf({ captcha_failed: "bad_request" }))
				.defaultBoundary("internal_server_error")
				.defaultErrors("captcha_failed")
			if (tree !== undefined) app.routeTree(tree)
			app.all("/*").handler((c) => c.res.json("ok", {}))
			return app
		}
		const app = gateway(gatewayTree(gateway(), source))
		overlaySchemas(app, source)
		const doc = generateOpenApi(app, { info: INFO })
		expect([
			keysOf(errorSchema(doc, "/columns", "409", { method: "post" })),
			keysOf(errorSchema(doc, "/columns", "400", { method: "post" })),
		]).toEqual([["column_name_taken", "optimistic_lock_conflict"], ["captcha_failed"]])
	})
})

describe("errors: what a route declares, and nothing more", () => {
	it("documents a scoped middleware's keys on the routes it covers only", () => {
		const errors = defineErrors({ blocked: "forbidden" })
		const block = defineMiddleware({ errors: [errors, "blocked"], fn: async (_c, next) => next() })
		const app = honey<{}>().errorFactory(errors)
		app.use("/admin", block)
		app.get("/admin/x").handler((c) => c.res.json("ok", {}))
		app.get("/public").handler((c) => c.res.json("ok", {}))
		const doc = generateOpenApi(app, { info: INFO })
		expect([Object.keys(responses(doc, "/admin/x")), Object.keys(responses(doc, "/public"))]).toEqual([
			["403"],
			["200"],
		])
	})
})

describe("declared headers beside a redirect", () => {
	it("keeps a redirect's Location beside the headers it declares, and documents a record of headers as none named", () => {
		const app = honey<{}>()
		app
			.post("/move")
			.output({
				"application/json": { created: z.object({}) },
				headers: { created: z.record(z.string(), z.string()), found: z.object({ "x-trace": z.string() }) },
				redirect: { found: true },
			})
			.handler((c) => c.res.json("created", {}, { headers: {} }))
		const r = responses(generateOpenApi(app, { info: INFO }), "/move", "post")
		expect([r["201"]?.headers, Object.keys(r["302"]?.headers ?? {})]).toEqual([{}, ["Location", "x-trace"]])
	})
})

describe("errors a route does not get documented", () => {
	it("leaves out a key with no status anywhere, and a status the route answers itself", () => {
		const root = createNode()
		const id = insertRoute(root, "GET", "/odd")
		const loose = honey<{}>().routeTree({ meta: {}, root, routes: { [id]: { ek: ["mystery"] } }, v: 2 })
		const app = honey<{}>().errorFactory(defineErrors({ email_taken: "conflict" }))
		app
			.post("/users")
			.errors("email_taken")
			.output({ "application/json": { conflict: z.object({ existing: z.string() }) } })
			.handler((c) => c.res.json("conflict", { existing: "1" }))
		expect([
			responses(generateOpenApi(loose, { info: INFO }), "/odd"),
			responses(generateOpenApi(app, { info: INFO }), "/users", "post")["409"]?.description,
		]).toEqual([{ "200": { description: "Success" } }, "conflict"])
	})
})
