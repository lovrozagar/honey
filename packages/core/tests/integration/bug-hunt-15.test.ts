import http from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import {
	extractSchemas,
	generateManifest,
	generateOpenApi,
	generateRouteTree,
	generateRouteTreeFromApp,
} from "../../src/codegen.ts"
import { HoneyError } from "../../src/error.ts"
import { defineErrors } from "../../src/errors.ts"
import { etag } from "../../src/etag.ts"
import { honey } from "../../src/index.ts"
import { createMiddleware } from "../../src/middleware.ts"
import { type HoneyServer, serve } from "../../src/node.ts"

type TestMeta = { auth?: boolean; cached?: boolean; ttl?: number }

function request(
	port: number,
	path: string,
	opts?: {
		body?: string
		headers?: Record<string, string>
		method?: string
	},
): Promise<{ body: string; headers: http.IncomingHttpHeaders; status: number }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				headers: opts?.headers,
				hostname: "127.0.0.1",
				method: opts?.method ?? "GET",
				path,
				port,
			},
			(res) => {
				let data = ""
				res.on("data", (chunk) => {
					data += chunk
				})
				res.on("end", () => {
					resolve({ body: data, headers: res.headers, status: res.statusCode ?? 0 })
				})
			},
		)
		req.on("error", reject)
		if (opts?.body) req.write(opts.body)
		req.end()
	})
}

let server: HoneyServer | null = null

afterEach(() => {
	if (server) {
		server.close()
		server = null
	}
})

/* ══════════════════════════════════════════════
 * 1. GENERATE MANIFEST — basic route manifest
 * ══════════════════════════════════════════════ */

describe("bug-hunt-15: generateManifest", () => {
	it("generates manifest with routes, methods, and paths", () => {
		const app = honey<{}>()
		app.get("/users").handler((ctx) => ctx.res.json("ok", []))
		app.post("/users").handler((ctx) => ctx.res.json("created", {}))
		app.get("/users/:id").handler((ctx) => ctx.res.json("ok", {}))

		const manifest = generateManifest(app)
		expect(manifest.routes.length).toBe(3)

		const getUsersRoute = manifest.routes.find((r) => r.method === "GET" && r.path === "/users")
		expect(getUsersRoute).toBeTruthy()
		expect(getUsersRoute?.params).toEqual([])

		const getUserRoute = manifest.routes.find((r) => r.path === "/users/:id")
		expect(getUserRoute).toBeTruthy()
		expect(getUserRoute?.params).toEqual(["id"])
	})

	it("manifest includes error keys and meta", () => {
		const errors = defineErrors({
			not_found: "not_found",
			rate_limited: "too_many_requests",
		})

		const app = honey<{}>().meta<TestMeta>().errorFactory(errors)
		app
			.get("/items/:id")
			.errors("not_found")
			.meta({ auth: true })
			.handler((ctx) => ctx.res.json("ok", {}))

		const manifest = generateManifest(app)
		const route = manifest.routes[0]
		expect(route.errors).toContain("not_found")
		expect(route.meta).toEqual({ auth: true })

		/* errors array should have resolved error info */
		const errInfo = manifest.errors.find((e) => e.errorKey === "not_found")
		expect(errInfo).toBeTruthy()
		expect(errInfo?.status).toBe(404)
		expect(errInfo?.statusKey).toBe("not_found")
	})

	it("manifest with input schemas", () => {
		function testSchema() {
			return {
				"~standard": {
					validate: (data: unknown) => ({ value: data }),
					vendor: "test",
					version: 1,
				},
			}
		}

		const app = honey<{}>()
		app
			.post("/items")
			.input({ json: testSchema() })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const manifest = generateManifest(app)
		const route = manifest.routes[0]
		expect(route.input).toBeTruthy()
		expect(route.input?.json).toBeTruthy()
	})

	it("manifest with output schemas", () => {
		function testSchema() {
			return {
				"~standard": {
					validate: (data: unknown) => ({ value: data }),
					vendor: "test",
					version: 1,
				},
			}
		}

		const app = honey<{}>()
		app
			.get("/items")
			.output({ "application/json": { ok: testSchema() } })
			.handler((ctx) => ctx.res.json("ok", []))

		const manifest = generateManifest(app)
		const route = manifest.routes[0]
		expect(route.output).toBeTruthy()
		expect(route.output?.["application/json"]).toBeTruthy()
	})

	it("manifest with wildcard route", () => {
		const app = honey<{}>()
		app.get("/files/*path").handler((ctx) => ctx.res.json("ok", {}))

		const manifest = generateManifest(app)
		expect(manifest.routes[0].path).toBe("/files/*path")
	})
})

/* ══════════════════════════════════════════════
 * 2. GENERATE OPENAPI — basic OpenAPI spec
 * ══════════════════════════════════════════════ */

describe("bug-hunt-15: generateOpenApi", () => {
	it("generates valid OpenAPI 3.1.0 spec", async () => {
		const app = honey<{}>()
		app.get("/users").handler((ctx) => ctx.res.json("ok", []))
		app.post("/users").handler((ctx) => ctx.res.json("created", {}))
		app.get("/users/:id").handler((ctx) => ctx.res.json("ok", {}))

		const spec = await generateOpenApi(app, {
			info: { title: "Test API", version: "1.0.0" },
		})

		expect(spec.openapi).toBe("3.1.0")
		expect(spec.info.title).toBe("Test API")
		expect(spec.paths["/users"]).toBeTruthy()
		expect(spec.paths["/users"].get).toBeTruthy()
		expect(spec.paths["/users"].post).toBeTruthy()
		expect(spec.paths["/users/{id}"]).toBeTruthy()
		expect(spec.paths["/users/{id}"].get).toBeTruthy()
	})

	it("OpenAPI includes path parameters", async () => {
		const app = honey<{}>()
		app.get("/users/:id").handler((ctx) => ctx.res.json("ok", {}))

		const spec = await generateOpenApi(app, {
			info: { title: "Test", version: "1.0.0" },
		})

		const params = spec.paths["/users/{id}"].get.parameters as Array<Record<string, unknown>>
		expect(params).toBeTruthy()
		const idParam = params.find((p) => p.name === "id")
		expect(idParam).toBeTruthy()
		expect(idParam?.in).toBe("path")
		expect(idParam?.required).toBe(true)
	})

	it("OpenAPI includes optional path parameters", async () => {
		const app = honey<{}>()
		app.get("/users/:id?").handler((ctx) => ctx.res.json("ok", {}))

		const spec = await generateOpenApi(app, {
			info: { title: "Test", version: "1.0.0" },
		})

		/* optional param routes register both with and without param */
		const pathKeys = Object.keys(spec.paths)
		expect(pathKeys.length).toBeGreaterThan(0)
	})

	it("OpenAPI includes error responses from error keys", async () => {
		const errors = defineErrors({
			item_not_found: "not_found",
		})

		const app = honey<{}>().errorFactory(errors)
		app
			.get("/items/:id")
			.errors("item_not_found")
			.handler((ctx) => ctx.res.json("ok", {}))

		const spec = await generateOpenApi(app, {
			info: { title: "Test", version: "1.0.0" },
		})

		const operation = spec.paths["/items/{id}"].get
		const responses = operation.responses as Record<string, Record<string, unknown>>
		/* should have a 404 error response */
		expect(responses["404"]).toBeTruthy()
		const errContent = responses["404"].content as Record<string, Record<string, unknown>>
		expect(errContent["application/json"]).toBeTruthy()
	})

	it("OpenAPI includes openApi meta (summary, tags, deprecated)", async () => {
		const app = honey<{}>()
		app
			.get("/items")
			.meta({
				deprecated: false,
				summary: "List all items",
				tags: ["items"],
			})
			.handler((ctx) => ctx.res.json("ok", []))

		const spec = await generateOpenApi(app, {
			info: { title: "Test", version: "1.0.0" },
		})

		const operation = spec.paths["/items"].get
		expect(operation.summary).toBe("List all items")
		expect(operation.tags).toEqual(["items"])
	})

	it("OpenAPI route with no responses → default 200", async () => {
		const app = honey<{}>()
		app.get("/health").handler((ctx) => ctx.res.json("ok", {}))

		const spec = await generateOpenApi(app, {
			info: { title: "Test", version: "1.0.0" },
		})

		const responses = spec.paths["/health"].get.responses as Record<string, Record<string, unknown>>
		expect(responses["200"]).toBeTruthy()
		expect(responses["200"].description).toBe("Success")
	})
})

/* ══════════════════════════════════════════════
 * 3. GENERATE ROUTE TREE CODE — static codegen
 * ══════════════════════════════════════════════ */

describe("bug-hunt-15: generateRouteTree", () => {
	it("generates valid TypeScript route tree code", () => {
		const code = generateRouteTree([
			{
				boundaryErrorKey: null,
				errorKeys: [],
				inputSchemas: null,
				meta: null,
				method: "GET",
				middlewareNames: [],
				outputSchemas: null,
				path: "/users",
			},
			{
				boundaryErrorKey: null,
				errorKeys: [],
				inputSchemas: null,
				meta: null,
				method: "POST",
				middlewareNames: [],
				outputSchemas: null,
				path: "/users",
			},
			{
				boundaryErrorKey: null,
				errorKeys: ["not_found"],
				inputSchemas: null,
				meta: { auth: true },
				method: "GET",
				middlewareNames: ["authMw"],
				outputSchemas: null,
				path: "/users/:id",
			},
		])

		expect(code).toContain("import type")
		expect(code).toContain("export const tree")
		expect(code).toContain("export const handlers")
		expect(code).toContain("H0")
		expect(code).toContain("H1")
		expect(code).toContain("H2")
	})

	it("route tree with wildcard → correct structure", () => {
		const code = generateRouteTree([
			{
				boundaryErrorKey: null,
				errorKeys: [],
				inputSchemas: null,
				meta: null,
				method: "GET",
				middlewareNames: [],
				outputSchemas: null,
				path: "/files/*path",
			},
		])

		expect(code).toContain('"path"')
		expect(code).toContain("H0")
	})

	it("route tree with root route /", () => {
		const code = generateRouteTree([
			{
				boundaryErrorKey: null,
				errorKeys: [],
				inputSchemas: null,
				meta: null,
				method: "GET",
				middlewareNames: [],
				outputSchemas: null,
				path: "/",
			},
		])

		expect(code).toContain("H0")
		expect(code).toContain("export const tree")
	})
})

/* ══════════════════════════════════════════════
 * 4. GENERATE ROUTE TREE FROM APP
 * ══════════════════════════════════════════════ */

describe("bug-hunt-15: generateRouteTreeFromApp", () => {
	it("generates code from live app", () => {
		const app = honey<{}>().meta<TestMeta>()
		app.get("/users").handler((ctx) => ctx.res.json("ok", []))
		app
			.get("/users/:id")
			.meta({ auth: true })
			.handler((ctx) => ctx.res.json("ok", {}))

		const code = generateRouteTreeFromApp(app)
		expect(code).toContain("export const tree")
		expect(code).toContain("export const handlers")
		expect(code).toContain("export const routeTree")
	})

	it("app with meta → meta export emitted", () => {
		const app = honey<{}>().meta<TestMeta>()
		app
			.get("/items")
			.meta({ cached: true, ttl: 60 })
			.handler((ctx) => ctx.res.json("ok", []))

		const code = generateRouteTreeFromApp(app)
		expect(code).toContain("export const meta")
		expect(code).toContain("cached")
	})

	it("app without meta → no meta export, meta: {} in routeTree", () => {
		const app = honey<{}>()
		app.get("/items").handler((ctx) => ctx.res.json("ok", []))

		const code = generateRouteTreeFromApp(app)
		expect(code).not.toContain("export const meta:")
		expect(code).toContain("meta: {}")
	})
})

/* ══════════════════════════════════════════════
 * 5. EXTRACT SCHEMAS
 * ══════════════════════════════════════════════ */

describe("bug-hunt-15: extractSchemas", () => {
	it("extracts input and output schemas by route key", () => {
		function testSchema() {
			return {
				"~standard": {
					types: { input: "string", output: "string" },
					validate: (data: unknown) => ({ value: data }),
					vendor: "test",
					version: 1,
				},
			}
		}

		const app = honey<{}>()
		app
			.post("/items")
			.input({ json: testSchema() })
			.output({ "application/json": { created: testSchema() } })
			.handler((ctx) => ctx.res.json("created", "created"))

		const schemas = extractSchemas(app)
		expect(schemas["POST /items"]).toBeTruthy()
		expect(schemas["POST /items"].input).toBeTruthy()
		expect(schemas["POST /items"].output).toBeTruthy()
	})

	it("route without schemas → empty object", () => {
		const app = honey<{}>()
		app.get("/health").handler((ctx) => ctx.res.json("ok", {}))

		const schemas = extractSchemas(app)
		expect(schemas["GET /health"]).toEqual({})
	})
})

/* ══════════════════════════════════════════════
 * 6. OPENAPI — toOpenApiPath conversion
 * ══════════════════════════════════════════════ */

describe("bug-hunt-15: OpenAPI path conversion", () => {
	it(":param → {param} in OpenAPI paths", async () => {
		const app = honey<{}>()
		app.get("/orgs/:orgId/members/:memberId").handler((ctx) => ctx.res.json("ok", {}))

		const spec = await generateOpenApi(app, {
			info: { title: "Test", version: "1.0.0" },
		})

		expect(spec.paths["/orgs/{orgId}/members/{memberId}"]).toBeTruthy()
	})
})

/* ══════════════════════════════════════════════
 * 7. ETAG — response with no body (null body, non-204)
 *
 * What about a 200 response with null body?
 * e.g., ctx.res.raw(new Response(null, { status: 200 }))
 * ══════════════════════════════════════════════ */

describe("bug-hunt-15: ETag with null body 200", () => {
	it("200 with null body → no ETag (0 bytes)", async () => {
		const app = honey<{}>().use(etag())
		app.get("/empty").handler((ctx) => ctx.res.raw(new Response(null, { status: 200 })))

		const res = await app.fetch(new Request("http://localhost/empty"), {})
		expect(res.status).toBe(200)
		/* null body → arrayBuffer is 0 bytes → no ETag */
		expect(res.headers.get("etag")).toBeNull()
	})
})

/* ══════════════════════════════════════════════
 * 8. CONCURRENT ERROR + SUCCESS REQUESTS
 *
 * Verify errors in one request don't affect others.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-15: concurrent errors don't pollute success", () => {
	it("mixed error + success concurrent requests → isolated", async () => {
		const app = honey<{}>()
		app.get("/ok/:n").handler((ctx) => ctx.res.json("ok", { n: ctx.params.n }))
		app.get("/fail/:n").handler((ctx) => {
			throw new HoneyError({ errorKey: `err_${ctx.params.n}`, status: "bad_request" })
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const promises = Array.from({ length: 20 }, (_, i) =>
			i % 2 === 0 ? request(addr.port, `/ok/${i}`) : request(addr.port, `/fail/${i}`),
		)
		const results = await Promise.all(promises)

		for (let i = 0; i < 20; i++) {
			if (i % 2 === 0) {
				expect(results[i].status).toBe(200)
				const data = JSON.parse(results[i].body) as Record<string, string>
				expect(data.n).toBe(String(i))
			} else {
				expect(results[i].status).toBe(400)
			}
		}
	})
})

/* ══════════════════════════════════════════════
 * 9. MIDDLEWARE ADDING SAME KEY TWICE — last wins
 * ══════════════════════════════════════════════ */

describe("bug-hunt-15: middleware overwriting same ctx key", () => {
	it("two middlewares setting same key → last value wins", async () => {
		const mw1 = createMiddleware(async (_ctx, next) => next({ version: "v1" }))
		const mw2 = createMiddleware(async (_ctx, next) => next({ version: "v2" }))

		const app = honey<{}>().use(mw1).use(mw2)
		app.get("/test").handler((ctx) => ctx.res.json("ok", { version: ctx.version }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.version).toBe("v2")
	})
})

/* ══════════════════════════════════════════════
 * 10. GENERATE TYPES — type codegen
 * ══════════════════════════════════════════════ */

describe("bug-hunt-15: generateTypes", () => {
	it("generates TypeScript type declarations", () => {
		const { generateTypes } = require("../../src/codegen.ts")

		const errors = defineErrors({ not_found: "not_found" })
		const app = honey<{}>().meta<TestMeta>().errorFactory(errors)
		app
			.get("/items/:id")
			.errors("not_found")
			.meta({ auth: true })
			.handler((ctx) => ctx.res.json("ok", {}))
		app.post("/items").handler((ctx) => ctx.res.json("created", {}))

		const code = generateTypes(app, {
			inlineEnvType: "{ DB: string }",
		})

		expect(code).toContain("export type BaseCtx")
		expect(code).toContain("export type Routes")
		expect(code).toContain('"/items/:id"')
		expect(code).toContain('"/items"')
		expect(code).toContain("HoneyContext")
		expect(code).toContain("HoneyError")
	})
})
