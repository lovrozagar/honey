import { type } from "arktype"
import { describe, expect, it } from "vitest"
import * as v from "valibot"
import * as z from "zod"
import { readableStream } from "../input/input.ts"
import { honey } from "../routing/app.ts"
import { SILENT, type Logger } from "../telemetry/logger.ts"
import { generateOpenApi } from "./generate.ts"

const INFO = { title: "T", version: "1" }
type Doc = ReturnType<typeof generateOpenApi>
type Param = { in: string; name: string; required: boolean; schema: unknown; "x-honey-wildcard"?: true }

/** Parameters in name order. */
const byName = (list: Param[]) => list.toSorted((a, b) => (a.name < b.name ? -1 : 1))
const op = (doc: Doc, path: string, method = "get") => (doc.paths[path]?.[method] ?? {}) as Record<string, unknown>
const params = (doc: Doc, path: string, method = "get") => (op(doc, path, method).parameters ?? []) as Param[]
const names = (doc: Doc, path: string, method = "get") => params(doc, path, method).map((p) => p.name)
const content = (doc: Doc, path: string, method = "post") =>
	(op(doc, path, method).requestBody as { content?: Record<string, { schema: unknown }> } | undefined)?.content ?? {}

/** A Standard schema that accepts anything and publishes `json` as its JSON Schema, both sides. */
const publishing = (json: Record<string, unknown>) => ({
	"~standard": {
		jsonSchema: { input: () => json, output: () => json },
		validate: (value: unknown) => ({ value }),
		vendor: "raw",
		version: 1 as const,
	},
})

/** `schema` with a component reference followed. */
function resolved(doc: Doc, schema: unknown): Record<string, unknown> {
	const ref = (schema as { $ref?: string } | undefined)?.$ref
	return ref === undefined
		? ((schema ?? {}) as Record<string, unknown>)
		: (doc.components?.schemas?.[ref.split("/").pop() as string] ?? {})
}

describe("paths: one item per concrete path, its methods inside", () => {
	// v0: 0c567dd98f
	// v0: 725378e9c0
	// v0: e91110554f
	// v0: 86316dbd8f
	it("writes each route's path with {param}, under its method, a mounted route under the handle's base path", () => {
		const app = honey<{}>()
		app.get("/health").handler((c) => c.res.text("ok", "ok"))
		app.post("/v1/organizations").handler((c) => c.res.text("ok", "ok"))
		app.get("/orgs/:orgId/members/:memberId").handler((c) => c.res.text("ok", "ok"))
		const sub = honey<{}>()
		sub.get("/users").handler((c) => c.res.text("ok", "ok"))
		app.basePath("/v1").route(sub)
		const doc = generateOpenApi(app, { info: INFO })
		expect(Object.entries(doc.paths).map(([path, item]) => [path, Object.keys(item)])).toEqual([
			["/health", ["get"]],
			["/v1/organizations", ["post"]],
			["/orgs/{orgId}/members/{memberId}", ["get"]],
			["/v1/users", ["get"]],
		])
	})

	// v0: 2c1b71e6c2
	// v0: fc6222ab83
	it("documents all() as the standard methods the path does not declare itself, and keeps the slash trailingSlash enforce makes clients send", () => {
		const app = honey<{}>().trailingSlash("enforce")
		app.get("/upstream/*path").handler((c) => c.res.text("ok", "ok"))
		app.all("/upstream/*path").handler((c) => c.res.text("ok", "ok"))
		app.get("/users/:id").handler((c) => c.res.text("ok", "ok"))
		app.get("/").handler((c) => c.res.text("ok", "ok"))
		const doc = generateOpenApi(app, { info: INFO })
		expect([Object.keys(doc.paths), Object.keys(doc.paths["/upstream/{path}/"] ?? {})]).toEqual([
			["/upstream/{path}/", "/users/{id}/", "/"],
			["get", "post", "put", "patch", "delete"],
		])
	})

	it("marks every operation with the route id it came from: all() and an optional param share theirs, each .on() method has its own", () => {
		const app = honey<{}>()
		app.all("/any").handler((c) => c.res.text("ok", "ok"))
		app.get("/opt/:id?").handler((c) => c.res.text("ok", "ok"))
		app.on(["GET", "POST"], "/multi").handler((c) => c.res.text("ok", "ok"))
		app.ws("/socket").handler({ onMessage() {} })
		const doc = generateOpenApi(app, { info: INFO })
		const route = (path: string, method = "get") => op(doc, path, method)["x-honey-route"]
		expect([
			route("/any"),
			route("/any", "delete"),
			route("/opt"),
			route("/opt/{id}"),
			route("/multi"),
			route("/multi", "post"),
			route("/socket"),
		]).toEqual(["ALL /any", "ALL /any", "GET /opt/:id?", "GET /opt/:id?", "GET /multi", "POST /multi", "WS /socket"])
	})
})

describe("path parameters", () => {
	// v0: e5154d0521
	// v0: d8813bb352
	// v0: 9847df71ef
	// v0: 5487962aae
	it("are each in path and required, an optional param's variant without it having none", () => {
		const app = honey<{}>()
		app.get("/v1/organizations/:orgId").handler((c) => c.res.text("ok", "ok"))
		app.get("/opt/:id?").handler((c) => c.res.text("ok", "ok"))
		const doc = generateOpenApi(app, { info: INFO })
		expect([params(doc, "/v1/organizations/{orgId}"), op(doc, "/opt").parameters, params(doc, "/opt/{id}")]).toEqual([
			[{ in: "path", name: "orgId", required: true, schema: { type: "string" } }],
			undefined,
			[{ in: "path", name: "id", required: true, schema: { type: "string" } }],
		])
	})

	// v0: cf07eb19e1
	// v0: 1f452d8cdc
	it("documents a named and an unnamed wildcard as path parameters, and keeps a hyphenated name whole", () => {
		const app = honey<{}>()
		app.get("/files/*path").handler((c) => c.res.text("ok", "ok"))
		app.get("/star/*").handler((c) => c.res.text("ok", "ok"))
		app.get("/u/:user-id").handler((c) => c.res.text("ok", "ok"))
		const doc = generateOpenApi(app, { info: INFO })
		const wildcard = {
			description: "The rest of the path; may contain `/`.",
			in: "path",
			required: true,
			schema: { type: "string" },
			"x-honey-wildcard": true,
		}
		expect([
			Object.keys(doc.paths),
			params(doc, "/files/{path}"),
			names(doc, "/star/{wildcard}"),
			names(doc, "/u/{user-id}"),
		]).toEqual([
			["/files/{path}", "/star/{wildcard}", "/u/{user-id}"],
			[{ ...wildcard, name: "path" }],
			["wildcard"],
			["user-id"],
		])
	})

	it("takes a param's schema from a declared params schema", () => {
		const app = honey<{}>()
		app
			.get("/items/:id")
			.input({ params: z.object({ id: z.string().uuid() }) })
			.handler((c) => c.res.text("ok", "ok"))
		expect(params(generateOpenApi(app, { info: INFO }), "/items/{id}")[0]?.schema).toEqual({
			format: "uuid",
			pattern: expect.any(String),
			type: "string",
		})
	})
})

describe("operationIds", () => {
	// v0: 54d224eee1
	// v0: 1417ba2705
	it("suffixes one route's expanded operations by method and variant, a WS route's too, steps past an id taken, and fails when two routes declare one id", () => {
		const app = honey<{}>()
		app
			.on(["GET", "POST"], "/multi")
			.meta({ operationId: "multi" })
			.handler((c) => c.res.text("ok", "ok"))
		app
			.get("/opt/:id?")
			.meta({ operationId: "opt" })
			.handler((c) => c.res.text("ok", "ok"))
		app
			.ws("/feed/:room?")
			.meta({ operationId: "feed" })
			.handler({ onMessage() {} })
		app
			.get("/taken")
			.meta({ operationId: "multi_get" })
			.handler((c) => c.res.text("ok", "ok"))
		const doc = generateOpenApi(app, { info: INFO })
		expect(
			[["/multi"], ["/multi", "post"], ["/opt"], ["/opt/{id}"], ["/feed"], ["/feed/{room}"], ["/taken"]].map(
				([path, method]) => op(doc, path as string, method).operationId,
			),
		).toEqual(["multi_get_", "multi_post", "opt", "opt_with_id", "feed", "feed_with_room", "multi_get"])
		const twice = honey<{}>()
		twice
			.get("/a")
			.meta({ operationId: "same" })
			.handler((c) => c.res.text("ok", "ok"))
		twice
			.get("/b")
			.meta({ operationId: "same" })
			.handler((c) => c.res.text("ok", "ok"))
		expect(() => generateOpenApi(twice, { info: INFO })).toThrow(/DUPLICATE_OPERATION_ID.*"same".*GET \/a, GET \/b/s)
	})
})

describe("request bodies", () => {
	// v0: 32743cd28a
	// v0: 5889947a59
	// v0: c091a16d80
	// v0: 0a2f64ab66
	it("documents a json body, required, with its input-side schema and no x-internal property", () => {
		const app = honey<{}>()
		app
			.post("/items")
			.input({ json: z.object({ j: z.number(), trace: z.string().meta({ "x-internal": true }) }) })
			.handler((c) => c.res.text("ok", "ok"))
		const doc = generateOpenApi(app, { info: INFO })
		const body = content(doc, "/items")
		const json = resolved(doc, body["application/json"]?.schema)
		expect([
			(op(doc, "/items", "post").requestBody as { required: boolean }).required,
			Object.keys(body),
			json.properties,
			json.required,
		]).toEqual([true, ["application/json"], { j: { type: "number" } }, ["j"]])
	})
})

describe("form bodies: urlencoded, and multipart when a part is binary", () => {
	// v0: 97959a43a7
	// v0: 1fb2a3fdaa
	// v0: 48eaf32b5f
	// v0: 2ed8817faf
	// v0: 520636424a
	// v0: 9e9462a7a5
	// v0: 1499d2378e
	it("adds multipart for a file or a byte part, unwraps a readableStream form, and keeps a scalar-only form urlencoded", () => {
		const app = honey<{}>()
		app
			.post("/extract")
			.input({ form: readableStream(z.object({ columns: z.string(), file: z.file() })) })
			.handler((c) => c.res.text("ok", "ok"))
		app
			.post("/upload")
			.input({ form: publishing({ properties: { payload: { format: "byte", type: "string" } }, type: "object" }) })
			.handler((c) => c.res.text("ok", "ok"))
		app
			.post("/login")
			.input({ form: z.object({ title: z.string() }) })
			.handler((c) => c.res.text("ok", "ok"))
		app
			.post("/notes")
			.input({ form: readableStream(z.object({ title: z.string() })) })
			.handler((c) => c.res.text("ok", "ok"))
		const doc = generateOpenApi(app, { info: INFO })
		const multipart = (path: string) =>
			resolved(doc, content(doc, path)["multipart/form-data"]?.schema).properties as Record<string, { format?: string }>
		expect([
			Object.keys(content(doc, "/extract")),
			multipart("/extract").file?.format,
			multipart("/upload").payload?.format,
			Object.keys(content(doc, "/login")),
			Object.keys(content(doc, "/notes")),
			Object.keys(
				resolved(doc, content(doc, "/notes")["application/x-www-form-urlencoded"]?.schema).properties as object,
			),
		]).toEqual([
			["multipart/form-data", "application/x-www-form-urlencoded"],
			"binary",
			"byte",
			["application/x-www-form-urlencoded"],
			["application/x-www-form-urlencoded"],
			["title"],
		])
	})
})

describe("binary bodies", () => {
	it("documents each media type a binary body accepts, as any bytes: no schema", () => {
		const app = honey<{}>()
		app
			.put("/avatar")
			.input({ binary: ["image/png", "image/jpeg"] })
			.handler((c) => c.res.text("ok", "ok"))
		app
			.put("/blob")
			.input({ binary: "application/octet-stream" })
			.handler((c) => c.res.text("ok", "ok"))
		const doc = generateOpenApi(app, { info: INFO })
		expect([content(doc, "/avatar", "put"), content(doc, "/blob", "put")]).toEqual([
			{ "image/jpeg": {}, "image/png": {} },
			{ "application/octet-stream": {} },
		])
	})
})

describe("query and header parameters: one per property", () => {
	// v0: 4b457fb637
	// v0: 1439a92249
	// v0: b832450ed3
	// v0: 5307a2c15f
	// v0: 984a1cf106
	// v0: f58c5a66c8
	it("decomposes a search object of any vendor into query parameters, each with its schema and whether it is required", () => {
		const app = honey<{}>()
		app
			.get("/zod")
			.input({ search: z.object({ limit: z.number().optional(), page: z.number() }) })
			.handler((c) => c.res.text("ok", "ok"))
		app
			.get("/valibot")
			.input({ search: v.object({ limit: v.optional(v.number()), page: v.number() }) })
			.handler((c) => c.res.text("ok", "ok"))
		app
			.get("/arktype")
			.input({ search: type({ "limit?": "number", page: "number" }) })
			.handler((c) => c.res.text("ok", "ok"))
		const doc = generateOpenApi(app, { info: INFO })
		const expected = [
			{ in: "query", name: "limit", required: false, schema: { type: "number" } },
			{ in: "query", name: "page", required: true, schema: { type: "number" } },
		]
		/* each vendor lists its properties in its own order; the parameters follow it */
		expect([byName(params(doc, "/zod")), byName(params(doc, "/valibot")), byName(params(doc, "/arktype"))]).toEqual([
			expected,
			expected,
			expected,
		])
	})

	// v0: eb953ca731
	// v0: 664d47d84c
	it("leaves an x-internal search or header field out, and documents headers in header", () => {
		const app = honey<{}>()
		app
			.post("/login")
			.input({
				headers: z.object({
					"cf-connecting-ip": z.string().optional().meta({ "x-internal": true }),
					"x-client": z.string(),
				}),
				search: z.object({ limit: z.number(), trace_id: z.string().optional().meta({ "x-internal": true }) }),
			})
			.handler((c) => c.res.text("ok", "ok"))
		expect(params(generateOpenApi(app, { info: INFO }), "/login", "post").map((p) => `${p.in} ${p.name}`)).toEqual([
			"header x-client",
			"query limit",
		])
	})
})

describe("query parameters: the input side of a search schema", () => {
	const ListQuery = z
		.object({
			filter: z.string().optional(),
			limit: z.coerce.number().int().min(1).max(100).default(20),
			q: z.string().optional(),
		})
		.transform((data) => ({ ...data, filterAst: null as unknown, parsedFields: [] as string[] }))

	// v0: a36aed7775
	// v0: 0a3eda415f
	// v0: 15508ec3e4
	it("documents what a client sends, never a transform's parsed output, and keeps every field beside an unrepresentable one", () => {
		const app = honey<{}>()
		app
			.get("/items")
			.input({ search: ListQuery })
			.handler((c) => c.res.text("ok", "ok"))
		app
			.get("/q")
			.input({ search: z.object({ at: z.date().optional(), q: z.string(), tag: z.custom<string>() }) })
			.handler((c) => c.res.text("ok", "ok"))
		const doc = generateOpenApi(app, { info: INFO, logger: SILENT })
		expect([names(doc, "/items"), names(doc, "/q")]).toEqual([
			["filter", "limit", "q"],
			["at", "q", "tag"],
		])
	})
})

describe("what an operation leaves out", () => {
	// v0: 571b719e70
	// v0: 404f6bcbca
	// v0: d1d81e1cea
	// v0: 153c34f8c2
	// v0: 59c978b725
	it("drops an internal route, its own meta's or its chain's, and never writes a raw invalidate or an invalidate null", () => {
		const app = honey<{}>()
		app.metaSpec({ meta: {}, strict: "error" })
		app
			.get("/health")
			.meta({ internal: true })
			.handler((c) => c.res.text("ok", "ok"))
		app
			.meta({ internal: true })
			.get("/metrics")
			.handler((c) => c.res.text("ok", "ok"))
		app.get("/users").handler((c) => c.res.text("ok", "ok"))
		app
			.post("/users")
			.meta({ invalidate: ["GET /users"], summary: "Create user" })
			.handler((c) => c.res.text("ok", "ok"))
		app
			.post("/sessions")
			.meta({ invalidate: null })
			.handler((c) => c.res.text("ok", "ok"))
		const doc = generateOpenApi(app, { info: INFO, logger: SILENT })
		expect([
			Object.keys(doc.paths),
			op(doc, "/users", "post").summary,
			op(doc, "/users", "post").invalidate,
			op(doc, "/sessions", "post")["x-invalidate"],
		]).toEqual([["/users", "/sessions"], "Create user", undefined, undefined])
	})
})

/** A logger that keeps each warning's message. */
function recording(): { logger: Logger; warnings: string[] } {
	const warnings: string[] = []
	const warn = (first: unknown, second?: unknown) =>
		void warnings.push(String(typeof first === "string" ? first : second))
	return { logger: { ...SILENT, warn }, warnings }
}

describe("WebSocket operations", () => {
	// v0: 4c2b9d2aa5
	// v0: 74e37ef9b9
	it("document a WS route as a GET upgrade: its policy run as ws, its search fields as parameters bar x-internal ones", () => {
		const app = honey<{}>().meta<{ tenant?: string }>()
		app.metaSpec({ meta: { tenant: { key: "x-tenant", on: "http" } } })
		app
			.get("/a")
			.meta({ tenant: "orgId" })
			.handler((c) => c.res.text("ok", "ok"))
		app
			.ws("/live")
			.meta({ tenant: "orgId" } as never)
			.input({ search: z.object({ secret: z.string().meta({ "x-internal": true }), token: z.string() }) })
			.handler({ onMessage() {} })
		const doc = generateOpenApi(app, { info: INFO })
		expect([
			op(doc, "/a")["x-tenant"],
			op(doc, "/live")["x-tenant"],
			op(doc, "/live")["x-websocket"],
			names(doc, "/live"),
			op(doc, "/live").responses,
		]).toEqual(["orgId", undefined, true, ["token"], { "101": { description: "WebSocket upgrade" } }])
	})

	it("leaves out a WS route an HTTP GET of the same path shadows, and says so through the logger", () => {
		const app = honey<{}>()
		app.get("/chat").handler((c) => c.res.text("ok", "ok"))
		app.ws("/chat").handler({ onMessage() {} })
		const { logger, warnings } = recording()
		const doc = generateOpenApi(app, { info: INFO, logger })
		expect([op(doc, "/chat")["x-websocket"], warnings]).toEqual([
			undefined,
			[expect.stringMatching(/WS_SHADOWED.*WS \/chat/s)],
		])
	})
})

describe("bodies and parameters whose schema lists no properties", () => {
	it("keeps a form urlencoded when no part is bytes, and documents a record's search or params as nothing more", () => {
		const app = honey<{}>()
		app
			.post("/form")
			.input({ form: publishing({ properties: { any: true, tags: { items: { type: "string" }, type: "array" } } }) })
			.handler((c) => c.res.text("ok", "ok"))
		app
			.post("/record")
			.input({ form: publishing({ additionalProperties: { type: "string" }, type: "object" }) })
			.handler((c) => c.res.text("ok", "ok"))
		app
			.get("/pair/:a/:b")
			.input({
				params: publishing({ properties: { a: { type: "integer" } }, type: "object" }) as never,
				search: publishing({ additionalProperties: { type: "string" }, type: "object" }),
			})
			.handler((c) => c.res.text("ok", "ok"))
		app
			.get("/one/:id")
			.input({ params: publishing({ type: "object" }) as never })
			.handler((c) => c.res.text("ok", "ok"))
		const doc = generateOpenApi(app, { info: INFO })
		expect([
			Object.keys(content(doc, "/form")),
			Object.keys(content(doc, "/record")),
			params(doc, "/pair/{a}/{b}").map((p) => [p.name, p.in, p.schema]),
			params(doc, "/one/{id}").map((p) => p.schema),
		]).toEqual([
			["application/x-www-form-urlencoded"],
			["application/x-www-form-urlencoded"],
			[
				["a", "path", { type: "integer" }],
				["b", "path", { type: "string" }],
			],
			[{ type: "string" }],
		])
	})
})
