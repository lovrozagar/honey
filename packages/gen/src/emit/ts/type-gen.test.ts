/**
 * `generateTypes`: an app's document, route tree and extracted types → `types.gen.d.ts`, checked
 * as a service consumes it (the `Routes` map, the extractors, `RouteSelector` and its `HoneyCodegen`
 * augmentation, route meta). Errors live in type-gen.errors.test.ts, ctx in type-gen.ctx.test.ts.
 */
import * as tsMorph from "ts-morph"
import { describe, expect, it } from "vitest"
import type { ExtractedTypes } from "../../extract/extract.ts"
import { extracted, type HoneyApp, type HoneyRoute, honeyDoc, object } from "./__fixtures__/honey-doc.ts"
import { typechecker } from "./__fixtures__/typecheck.ts"
import { generateTypes } from "./type-gen.ts"

const typecheck = typechecker(tsMorph)

type Json = Record<string, unknown>

const STRING = { type: "string" }
const NUMBER = { type: "number" }
const NULLABLE_STRING = { type: ["string", "null"] }
const arrayOf = (items: Json) => ({ items, type: "array" })
const json = (statuses: Record<string, Json>) => ({ "application/json": statuses })

/** generateTypes over `app`, what it reported, and each diagnostic of `consumer` beside its output. */
function check(app: HoneyApp, consumer: string, types: ExtractedTypes | null = null) {
	const reports: string[] = []
	const text = generateTypes({ ...app, extracted: types, report: (m) => reports.push(m) })
	return { diagnostics: typecheck(text, consumer), reports, text }
}

const route = (method: string, pattern: string, rest: Partial<HoneyRoute> = {}): HoneyRoute => ({
	method,
	pattern,
	...rest,
})

/** The types of `routes` with nothing extracted. */
const generate = (routes: HoneyRoute[]) =>
	generateTypes({ ...honeyDoc(routes), extracted: null, report: () => undefined })

/** A closed object schema, as Effect's JSON Schema writes a Struct. */
const struct = (properties: Json) => ({ ...object(properties), additionalProperties: false })

const USER = object({ email: STRING, id: STRING, name: STRING })

/* a real-world app: mixed inputs, optional and nullable fields, params, errors, outputs */
const REAL_WORLD = honeyDoc([
	route("GET", "/health"),
	route("POST", "/v1/auth/register", {
		errors: { email_taken: { status: 409 } },
		input: {
			json: object({ email: STRING, first_name: NULLABLE_STRING, last_name: NULLABLE_STRING, password: STRING }, [
				"email",
				"password",
			]),
		},
		output: json({ created: object({ id: STRING }) }),
	}),
	route("POST", "/v1/auth/login", {
		errors: { not_authorized: { status: 401 } },
		input: { json: object({ email: STRING, password: STRING }) },
		output: json({ ok: object({ token: STRING }) }),
	}),
	route("GET", "/v1/users", {
		input: { search: object({ limit: NUMBER, page: NUMBER }, ["page"]) },
		output: json({ ok: object({ items: arrayOf(USER), total: NUMBER }) }),
	}),
	route("GET", "/v1/users/:id", { errors: { not_found: { status: 404 } }, output: json({ ok: USER }) }),
	route("PUT", "/v1/users/:id", {
		errors: { not_found: { status: 404 } },
		input: { json: object({ avatar: NULLABLE_STRING, bio: NULLABLE_STRING, name: STRING }, ["name"]) },
	}),
	route("DELETE", "/v1/users/:id", { errors: { not_authorized: { status: 401 }, not_found: { status: 404 } } }),
	route("GET", "/v1/projects", {
		input: { search: object({ limit: NUMBER, offset: NUMBER }) },
		output: json({ ok: object({ items: arrayOf(object({ id: STRING, name: STRING })), total: NUMBER }) }),
	}),
	route("POST", "/v1/projects", {
		input: { json: object({ description: STRING, name: STRING }, ["name"]) },
		output: json({ created: object({ id: STRING }) }),
	}),
])

describe("the module skeleton", () => {
	// v0: 6770071363
	it("types every documented route under its pattern, with BaseCtx from the extracted env and HoneyError factories", () => {
		const app = honeyDoc([
			route("GET", "/items/:id", { errors: { not_found: { status: 404 } }, meta: { auth: true } }),
			route("POST", "/items"),
		])
		const consumer = `expectType<Equal<keyof Routes, "/items" | "/items/:id">>()
expectType<Equal<keyof Routes["/items/:id"], "get">>()
expectType<Equal<keyof Routes["/items"], "post">>()
expectType<Same<BaseCtx["env"], { DB: string }>>()
expectType<Equal<ReturnType<RouteCtx<"/items/:id", "get">["errors"]["not_found"]>, HoneyError>>()`
		const { diagnostics } = check(app, consumer, extracted({ env: "{ DB: string }" }))
		expect(diagnostics).toEqual([])
	})

	// v0: 81bd6fd06a
	it("types an app with no routes as an empty Routes map", () => {
		expect(check(honeyDoc([]), "expectType<Equal<keyof Routes, never>>()").diagnostics).toEqual([])
	})

	// v0: a31c4df124
	it("emits all seven Route* extractors even with no routes", () => {
		const consumer = `type Probe<P extends keyof Routes, M extends keyof Routes[P] & string> = [RouteCtx<P, M>, RouteInput<P, M>, RouteOutput<P, M>, RouteErrors<P, M>, RouteErrorShapes<P, M>, RouteErrorsByStatus<P, M>, RouteMeta<P, M>]
expectType<Equal<Probe<never, never>["length"], 7>>()`
		expect(check(honeyDoc([]), consumer).diagnostics).toEqual([])
	})

	// v0: b3ed47c6ec
	it("resolves each Route* extractor to that route's entry", () => {
		const app = honeyDoc([
			route("GET", "/health", {
				errors: { down: { status: 503 } },
				input: { search: object({ deep: { type: "boolean" } }) },
				meta: { summary: "Health" },
				output: json({ ok: object({ status: STRING }) }),
			}),
		])
		const consumer = `type E = Routes["/health"]["get"]
expectType<Equal<RouteCtx<"/health", "get">, E["ctx"]>>()
expectType<Equal<RouteInput<"/health", "get">, E["input"]>>()
expectType<Equal<RouteOutput<"/health", "get">, E["output"]>>()
expectType<Equal<RouteErrors<"/health", "get">, "down">>()
expectType<Equal<RouteErrorShapes<"/health", "get">, E["errorShapes"]>>()
expectType<Equal<RouteErrorsByStatus<"/health", "get">, E["errorsByStatus"]>>()
expectType<Equal<RouteMeta<"/health", "get">, { summary: "Health" }>>()
expectType<Same<RouteInput<"/health", "get">, { search: { deep: boolean } }>>()`
		expect(check(app, consumer).diagnostics).toEqual([])
	})
})

describe("the Routes map", () => {
	// v0: 8e405a63a7
	it("builds a GET route's ctx on BaseCtx", () => {
		const consumer = `type C = RouteCtx<"/health", "get">
expectType<Equal<C["env"], BaseCtx["env"]>>()
expectType<Equal<C["req"], Request>>()
expectType<Equal<C["routePattern"], "/health">>()`
		expect(check(honeyDoc([route("GET", "/health")]), consumer).diagnostics).toEqual([])
	})

	// v0: 5a5fd49d0e
	it("keys GET and POST on one path under the same Routes entry", () => {
		const app = honeyDoc([
			route("GET", "/users"),
			route("POST", "/users", { input: { json: object({ name: STRING }) } }),
		])
		const consumer = `expectType<Equal<keyof Routes["/users"], "get" | "post">>()
expectType<Same<RouteInput<"/users", "post">["json"], { name: string }>>()`
		expect(check(app, consumer).diagnostics).toEqual([])
	})

	it("types an all() route once, under the method all", () => {
		const consumer = `expectType<Equal<keyof Routes["/echo"], "all">>()`
		expect(check(honeyDoc([route("ALL", "/echo")]), consumer).diagnostics).toEqual([])
	})

	// v0: 494723e73f
	it("types every route of a multi-route app with its concrete input and output", () => {
		const app = honeyDoc([
			route("GET", "/health"),
			route("GET", "/users", {
				input: { search: object({ page: NUMBER }) },
				output: json({ ok: object({ items: arrayOf(STRING) }) }),
			}),
			route("POST", "/users", { input: { json: object({ email: STRING, name: STRING }) } }),
		])
		const consumer = `expectType<Equal<keyof Routes, "/health" | "/users">>()
expectType<Same<RouteInput<"/users", "get">, { search: { page: number } }>>()
expectType<Same<RouteInput<"/users", "post">, { json: { email: string; name: string } }>>()
expectType<Same<RouteOutput<"/users", "get">, { "application/json": { ok: { items: string[] } } }>>()`
		expect(check(app, consumer).diagnostics).toEqual([])
	})
})

describe("path params", () => {
	// v0: d48578b92d
	it("types the pattern's params as ctx.params, each a string", () => {
		const consumer = `type P = RouteCtx<"/users/:userId/posts/:postId", "get">["params"]
expectType<Same<P, { postId: string; userId: string }>>()
expectType<Equal<P["userId"] | P["postId"], string>>()`
		expect(check(honeyDoc([route("GET", "/users/:userId/posts/:postId")]), consumer).diagnostics).toEqual([])
	})

	// v0: 4a3f99f9b3
	it("types path params beside the route's body and output", () => {
		const app = honeyDoc([
			route("PUT", "/users/:userId/posts/:postId", {
				input: { json: object({ body: STRING, title: STRING }) },
				output: json({ ok: object({ id: STRING, updated: { type: "boolean" } }) }),
			}),
		])
		const consumer = `type C = RouteCtx<"/users/:userId/posts/:postId", "put">
expectType<Same<C["params"], { postId: string; userId: string }>>()
expectType<Same<RouteInput<"/users/:userId/posts/:postId", "put">, { json: { body: string; title: string } }>>()
expectType<Same<RouteOutput<"/users/:userId/posts/:postId", "put">, { "application/json": { ok: { id: string; updated: boolean } } }>>()`
		expect(check(app, consumer).diagnostics).toEqual([])
	})
})

describe("Routes entries", () => {
	// v0: 1b35afa162
	it("types a route with no input as input {}", () => {
		const consumer = `expectType<Equal<RouteInput<"/health", "get">, {}>>()`
		expect(check(honeyDoc([route("GET", "/health")]), consumer).diagnostics).toEqual([])
	})

	// v0: 555da9d12f
	it("types a route with no output as output {}, core's placeholder 200 contributing nothing", () => {
		const consumer = `expectType<Equal<RouteOutput<"/health", "get">, {}>>()`
		expect(check(honeyDoc([route("GET", "/health")]), consumer).diagnostics).toEqual([])
	})

	// v0: 03a0e807c7
	it("types a real-world app: every path, optional markers, params, declared errors and outputs", () => {
		const consumer = `expectType<Equal<keyof Routes, "/health" | "/v1/auth/login" | "/v1/auth/register" | "/v1/projects" | "/v1/users" | "/v1/users/:id">>()
expectType<Equal<keyof Routes["/v1/users/:id"], "delete" | "get" | "put">>()
expectType<Same<RouteInput<"/v1/auth/register", "post">["json"], { email: string; first_name?: string | null; last_name?: string | null; password: string }>>()
expectType<Same<RouteInput<"/v1/users", "get">["search"], { limit?: number; page: number }>>()
expectType<Same<RouteInput<"/v1/users/:id", "put">["json"], { avatar?: string | null; bio?: string | null; name: string }>>()
expectType<Same<RouteInput<"/v1/projects", "post">["json"], { description?: string; name: string }>>()
expectType<Same<RouteCtx<"/v1/users/:id", "get">["params"], { id: string }>>()
expectType<Equal<RouteErrors<"/v1/auth/register", "post">, "email_taken">>()
expectType<Equal<RouteErrors<"/v1/users/:id", "delete">, "not_authorized" | "not_found">>()
expectType<Equal<RouteErrors<"/v1/projects", "get">, never>>()
expectType<Same<RouteOutput<"/v1/auth/login", "post">, { "application/json": { ok: { token: string } } }>>()
expectType<Same<RouteOutput<"/v1/projects", "get">["application/json"]["ok"], { items: { id: string; name: string }[]; total: number }>>()`
		expect(check(REAL_WORLD, consumer).diagnostics).toEqual([])
	})

	it("leaves websocket operations out of Routes", () => {
		const consumer = `expectType<Equal<keyof Routes, "/health">>()`
		expect(check(honeyDoc([route("GET", "/health"), route("WS", "/chat")]), consumer).diagnostics).toEqual([])
	})

	it("leaves out and reports, once, an operation without x-honey-route", () => {
		const app = honeyDoc([route("GET", "/health"), route("GET", "/legacy")])
		const paths = app.document.paths as Record<string, Record<string, Json>>
		delete paths["/legacy"]?.get?.["x-honey-route"]
		const { diagnostics, reports } = check(app, `expectType<Equal<keyof Routes, "/health">>()`)
		expect({ diagnostics, reports }).toEqual({
			diagnostics: [],
			reports: ["GET /legacy: no x-honey-route; left out of Routes"],
		})
	})

	it("emits the same bytes whatever order the document lists its routes in", () => {
		const routes = [
			route("POST", "/b", { errors: { z_key: { status: 409 }, a_key: { status: 400 } } }),
			route("GET", "/B"),
			route("GET", "/a/:id"),
			route("DELETE", "/a/:id"),
		]
		expect(generate(routes)).toBe(generate(routes.toReversed()))
	})
})

describe("input and output types", () => {
	// v0: b10d6edfc9
	it("types a search schema as input.search", () => {
		const app = honeyDoc([route("GET", "/search", { input: { search: object({ limit: NUMBER, q: STRING }) } })])
		const consumer = `expectType<Same<RouteInput<"/search", "get">, { search: { limit: number; q: string } }>>()`
		expect(check(app, consumer).diagnostics).toEqual([])
	})

	// v0: 3c06c03f2d
	it("keys a declared output by media type, then status key", () => {
		const app = honeyDoc([route("GET", "/users", { output: json({ ok: object({ id: STRING, name: STRING }) }) })])
		const consumer = `expectType<Same<RouteOutput<"/users", "get">, { "application/json": { ok: { id: string; name: string } } }>>()`
		expect(check(app, consumer).diagnostics).toEqual([])
	})

	// v0: 4a8c25fde6
	it("gives each output status key its own schema type", () => {
		const output = json({ created: object({ id: STRING }), ok: object({ message: STRING }) })
		const consumer = `type O = RouteOutput<"/multi-status", "post">["application/json"]
expectType<Equal<keyof O, "created" | "ok">>()
expectType<Same<O["created"], { id: string }>>()
expectType<Same<O["ok"], { message: string }>>()`
		expect(check(honeyDoc([route("POST", "/multi-status", { output })]), consumer).diagnostics).toEqual([])
	})
})

describe("vendor and recursive schemas", () => {
	// v0: 7b85e5f7e5
	it("types a search input and a JSON output concretely, never unknown", () => {
		const app = honeyDoc([
			route("GET", "/users", {
				input: { search: object({ limit: NUMBER, q: STRING }) },
				output: json({ ok: object({ id: STRING, name: STRING }) }),
			}),
		])
		const consumer = `expectType<Same<RouteInput<"/users", "get">["search"], { limit: number; q: string }>>()
expectType<Same<RouteOutput<"/users", "get">["application/json"]["ok"], { id: string; name: string }>>()
expectType<Equal<unknown extends RouteInput<"/users", "get">["search"]["q"] ? true : false, false>>()`
		expect(check(app, consumer).diagnostics).toEqual([])
	})

	// v0: 2803d8f745
	it("types an input and an output from different vendors' JSON Schema alike", () => {
		const app = honeyDoc([
			route("POST", "/items", {
				input: { json: { $schema: "https://json-schema.org/draft/2020-12/schema", ...object({ name: STRING }) } },
				output: json({ ok: { ...object({ id: STRING }), additionalProperties: false } }),
			}),
		])
		const consumer = `expectType<Same<RouteInput<"/items", "post">, { json: { name: string } }>>()
expectType<Same<RouteOutput<"/items", "post">, { "application/json": { ok: { id: string } } }>>()`
		expect(check(app, consumer).diagnostics).toEqual([])
	})

	// v0: 9a75eedce5
	it("places an Effect schema's JSON Schema as the json input and the status-keyed output", () => {
		const app = honeyDoc([
			route("POST", "/items", {
				input: { json: struct({ name: STRING }) },
				output: json({ ok: struct({ id: STRING }) }),
			}),
		])
		const consumer = `expectType<Same<RouteInput<"/items", "post">["json"], { name: string }>>()
expectType<Same<RouteOutput<"/items", "post">["application/json"]["ok"], { id: string }>>()`
		expect(check(app, consumer).diagnostics).toEqual([])
	})

	it("types a recursive component recursively, never unknown at depth", () => {
		const ref = { $ref: "#/components/schemas/FilterNode" }
		const FilterNode = object({
			conditions: arrayOf(object({ field: STRING, operator: STRING, value: {} })),
			logic: { enum: ["and", "or"], type: "string" },
			subgroups: arrayOf(ref),
		})
		const app = honeyDoc([route("POST", "/items", { input: { json: object({ filter: ref }) } })], { FilterNode })
		const consumer = `type F = RouteInput<"/items", "post">["json"]["filter"]
expectType<Equal<F["logic"], "and" | "or">>()
expectType<Equal<F["subgroups"][number]["subgroups"][number]["logic"], "and" | "or">>()
expectType<Same<F["conditions"][number]["field"], string>>()`
		expect(check(app, consumer).diagnostics).toEqual([])
	})
})

describe("RouteSelector and the HoneyCodegen augmentation", () => {
	// v0: 53841828e3
	it("types RouteSelector as the union of every route's METHOD /pattern", () => {
		const app = honeyDoc([
			route("GET", "/v1/users"),
			route("GET", "/v1/users/:id"),
			route("POST", "/v1/users"),
			route("DELETE", "/v1/users/:id"),
		])
		const consumer = `import type { RouteSelector } from "./types.gen"
expectType<Equal<RouteSelector, "DELETE /v1/users/:id" | "GET /v1/users" | "GET /v1/users/:id" | "POST /v1/users">>()`
		expect(check(app, consumer).diagnostics).toEqual([])
	})

	// v0: 2a3909d553
	it("lists RouteSelector members in code-unit order", () => {
		const app = honeyDoc([route("POST", "/z"), route("GET", "/a"), route("DELETE", "/m"), route("GET", "/B")])
		const { text } = check(app, "")
		const members = text.match(/export type RouteSelector = (.+)/)?.[1]?.split(" | ")
		expect(members).toEqual(['"DELETE /m"', '"GET /B"', '"GET /a"', '"POST /z"'])
	})

	// v0: 8ab3dbcaa6
	it("emits no RouteSelector for an app with no routes", () => {
		const { diagnostics, text } = check(honeyDoc([]), "")
		expect({ diagnostics, selector: /RouteSelector/.test(text) }).toEqual({ diagnostics: [], selector: false })
	})

	// v0: b99f9ef5db
	it("leaves HoneyCodegen unaugmented with no routes: invalidate keeps plain strings", () => {
		const consumer = `import type { RouteSelectorOf } from "@lovrozagar/honey"
expectType<Equal<RouteSelectorOf, string>>()`
		const { diagnostics, text } = check(honeyDoc([]), consumer)
		expect({ diagnostics, augmented: text.includes("HoneyCodegen") }).toEqual({ augmented: false, diagnostics: [] })
	})

	// v0: c143d3a344
	it("leaves an internal route out of Routes and RouteSelector", () => {
		const app = honeyDoc([route("GET", "/v1/users"), route("GET", "/v1/internal", { meta: { internal: true } })])
		const consumer = `import type { RouteSelector } from "./types.gen"
expectType<Equal<RouteSelector, "GET /v1/users">>()
expectType<Equal<keyof Routes, "/v1/users">>()`
		expect(check(app, consumer).diagnostics).toEqual([])
	})

	// v0: 2ab0bbb8f5
	it('augments "@lovrozagar/honey" HoneyCodegen so invalidate takes exactly the route selectors', () => {
		const app = honeyDoc([route("GET", "/v1/users"), route("POST", "/v1/users")])
		const consumer = `import type { HoneyCodegen, RouteSelectorOf } from "@lovrozagar/honey"
import type { RouteSelector } from "./types.gen"
expectType<Equal<HoneyCodegen["routeSelector"], RouteSelector>>()
expectType<Equal<RouteSelectorOf, "GET /v1/users" | "POST /v1/users">>()`
		const { diagnostics, text } = check(app, consumer)
		expect({ diagnostics, module: text.includes('declare module "@lovrozagar/honey"') }).toEqual({
			diagnostics: [],
			module: true,
		})
	})
})

describe("route meta", () => {
	/* the meta of each route as the tree carries it: chain, middleware and route meta resolved (O1) */
	const META_APP = honeyDoc([
		route("GET", "/health", { meta: { summary: "Health check" } }),
		route("GET", "/orgs", {
			input: { search: object({ limit: NUMBER }) },
			meta: {
				auth: "required",
				operationId: "listOrgs",
				rateLimit: "strict",
				summary: "List orgs",
				tags: ["Organization"],
			},
		}),
		route("POST", "/orgs", {
			input: { json: object({ name: STRING }) },
			meta: { auth: "required", deprecated: true, security: [{ bearerAuth: [] }], summary: "Create org" },
		}),
	])

	// v0: 1bd65834a7
	it("types each route's full meta, custom keys and OpenAPI keys alike, as literals", () => {
		const consumer = `expectType<Equal<RouteMeta<"/health", "get">, { summary: "Health check" }>>()
expectType<Equal<RouteMeta<"/orgs", "get">, { auth: "required"; operationId: "listOrgs"; rateLimit: "strict"; summary: "List orgs"; tags: ["Organization"] }>>()
expectType<Equal<RouteMeta<"/orgs", "post">, { auth: "required"; deprecated: true; security: [{ bearerAuth: [] }]; summary: "Create org" }>>()`
		expect(check(META_APP, consumer).diagnostics).toEqual([])
	})

	// v0: 3e07faac56
	it("types chain meta per route, a route's own value overriding the chain's", () => {
		const app = honeyDoc([
			route("GET", "/test", { meta: { security: "jwt", tags: "Auth" } }),
			route("POST", "/test", { meta: { security: "jwt", tags: "Override" } }),
		])
		const consumer = `expectType<Equal<RouteMeta<"/test", "get">, { security: "jwt"; tags: "Auth" }>>()
expectType<Equal<RouteMeta<"/test", "post">, { security: "jwt"; tags: "Override" }>>()`
		expect(check(app, consumer, extracted({ env: "{}" })).diagnostics).toEqual([])
	})

	// v0: 2717e15bd2
	it("types invalidate beside deprecated, operationId and tags, and a meta-less route as {}", () => {
		const meta = { deprecated: true, invalidate: ["GET /v1/users"], operationId: "user.create", tags: "users" }
		const app = honeyDoc([route("GET", "/v1/users"), route("POST", "/v1/users", { meta })])
		const consumer = `expectType<Equal<RouteMeta<"/v1/users", "post">, { deprecated: true; invalidate: ["GET /v1/users"]; operationId: "user.create"; tags: "users" }>>()
expectType<Equal<RouteMeta<"/v1/users", "get">, {}>>()`
		expect(check(app, consumer).diagnostics).toEqual([])
	})

	// v0: eecb2cdc81
	it("types invalidate as a literal string tuple", () => {
		const app = honeyDoc([
			route("GET", "/v1/users"),
			route("GET", "/v1/users/:id"),
			route("POST", "/v1/users", { meta: { invalidate: ["GET /v1/users", "GET /v1/users/:id"] } }),
		])
		const consumer = `expectType<Equal<RouteMeta<"/v1/users", "post">["invalidate"], ["GET /v1/users", "GET /v1/users/:id"]>>()`
		expect(check(app, consumer).diagnostics).toEqual([])
	})
})
