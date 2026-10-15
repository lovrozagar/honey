import { describe, expect, it, vi } from "vitest"
import * as z from "zod"
import { defineErrors } from "../errors/errors.ts"
import { defineMiddleware } from "../middleware/middleware.ts"
import { honey } from "../routing/app.ts"
import type { RouteTree } from "../routing/tree.ts"
import { SILENT } from "../telemetry/logger.ts"
import { generateOpenApi } from "./generate.ts"
import { generateManifest } from "./manifest.ts"
import { serveManifest, serveOpenApi } from "./serve.ts"

type Doc = { info: Record<string, unknown>; paths: Record<string, Record<string, Record<string, unknown>>> }
type App = { fetch(request: Request, env: object): Promise<Response> | Response }

const get = (app: App, path: string, init?: RequestInit) => app.fetch(new Request(`http://x${path}`, init), {})
const json = async (app: App, path: string) => (await (await get(app, path)).json()) as Doc
const text = async (app: App, path: string) => (await get(app, path)).text()
/** Health and the users routes. */
function users() {
	const app = honey<{}>()
	app.get("/health").handler((c) => c.res.text("ok", "ok"))
	app.get("/users").handler((c) => c.res.json("ok", []))
	app.get("/users/:id").handler((c) => c.res.json("ok", {}))
	return app
}

/** GET /users serving its document and docs, loaded from `tree` when given one. */
function usersServing(tree?: RouteTree) {
	const app = honey<{}>()
	if (tree !== undefined) app.routeTree(tree)
	app.get("/users").handler((c) => c.res.json("ok", []))
	return serveOpenApi(app, { docs: "scalar", title: "T", version: "1" })
}

describe("serveOpenApi: the document, as JSON and YAML", () => {
	// v0: 112cc40b0c
	// v0: 1a5afd0484
	// v0: 135e45ccd9
	// v0: cf8fc0bd81
	// v0: b96245156b
	it("serves the app's 3.1 document as JSON at the stem, and the same document as YAML at .yaml and .yml", async () => {
		const app = serveOpenApi(users(), { description: "Users API", title: "Demo", version: "1.0.0" })
		const res = await get(app, "/openapi.json")
		const doc = (await res.json()) as Doc & { openapi: string }
		const [yml, yaml] = [await get(app, "/openapi.yml"), await get(app, "/openapi.yaml")]
		const ymlText = await yml.text()
		expect([
			res.headers.get("content-type"),
			doc.openapi,
			doc.info,
			Object.keys(doc.paths),
			[yml.headers.get("content-type"), yaml.headers.get("content-type")],
			ymlText === (await yaml.text()),
			/openapi: "3\.1\.0"\n/.test(ymlText) && ymlText.includes("/users/{id}:"),
		]).toEqual([
			"application/json; charset=utf-8",
			"3.1.0",
			{ description: "Users API", title: "Demo", version: "1.0.0" },
			["/health", "/users", "/users/{id}"],
			["application/yaml; charset=utf-8", "application/yaml; charset=utf-8"],
			true,
			true,
		])
	})
})

describe("serveOpenApi: where it serves, and what", () => {
	// v0: 29a8efd3cf
	// v0: 5d9e5bd3c0
	// v0: 26ef508dca
	// v0: 6b8c24e9ee
	it("serves under the handle's basePath and its own stem, filtered, its options kept out of info", async () => {
		const app = honey<{}>().meta<{ auth?: string }>()
		app.get("/public").handler((c) => c.res.text("ok", "ok"))
		app
			.get("/dashboard")
			.meta({ auth: "jwt" })
			.handler((c) => c.res.text("ok", "ok"))
		app
			.post("/items")
			.input({ json: z.object({ name: z.string() }), search: z.object({ q: z.string() }) })
			.handler((c) => c.res.text("ok", "ok"))
		serveOpenApi(app.basePath("/api"), {
			filterRoutes: (route) => route.meta.auth !== "jwt",
			path: "/docs/spec",
			profile: "default",
			securitySchemes: {},
			title: "Api",
			version: "2",
		})
		const doc = await json(app, "/api/docs/spec.json")
		const post = doc.paths["/items"]?.post as {
			parameters: { name: string }[]
			requestBody: { content: Record<string, { schema: { $ref?: string } }> }
		}
		const ref = post.requestBody.content["application/json"]?.schema.$ref ?? ""
		const components = (doc as Doc & { components?: { schemas: Record<string, unknown> } }).components?.schemas
		expect([
			doc.info,
			Object.keys(doc.paths),
			post.parameters.map((p) => p.name),
			JSON.stringify(components?.[ref.split("/").pop() as string] ?? {}).includes('"name"'),
			(await text(app, "/api/docs/spec.yaml")).includes("title: Api"),
		]).toEqual([{ title: "Api", version: "2" }, ["/items", "/public"], ["q"], true, true])
	})
})

describe("serveOpenApi: the routes it mounts are internal", () => {
	// v0: 2ea3653c99
	// v0: 198bd328ca
	// v0: 3731e492aa
	// v0: 315fd50504
	it("leaves every served route out of the generated and served document and manifest", async () => {
		const app = serveManifest(serveOpenApi(users(), { docs: "scalar", title: "Demo", version: "1" }))
		const served = ["/openapi.json", "/openapi.yaml", "/openapi.yml", "/docs", "/manifest.json"]
		const manifest = (await (await get(app, "/manifest.json")).json()) as { routes: { path: string }[] }
		const paths = [
			Object.keys(generateOpenApi(app, { info: { title: "T", version: "1" } }).paths),
			Object.keys((await json(app, "/openapi.json")).paths),
			generateManifest(app).routes.map((r) => r.path),
			manifest.routes.map((r) => r.path),
		]
		expect(paths.map((list) => list.filter((p) => served.includes(p)))).toEqual([[], [], [], []])
		expect(paths.map((list) => list.includes("/health"))).toEqual([true, true, true, true])
	})

	// v0: be4a2e835c
	it("never runs the invalidate check, and documents a schema no converter can describe with a warning", async () => {
		const warnings: string[] = []
		const logger = { ...SILENT, warn: (first: unknown) => void warnings.push(String(first)) }
		const app = honey<{}>()
		app.post("/tables").handler((c) => c.res.text("ok", "ok"))
		app.get("/tables").handler((c) => c.res.text("ok", "ok"))
		const broken = {
			"~standard": { validate: (value: unknown) => ({ value }), vendor: "mystery", version: 1 as const },
		}
		app
			.post("/odd")
			.input({ json: broken })
			.handler((c) => c.res.text("ok", "ok"))
		serveOpenApi(app, { logger, title: "T", version: "1" })
		expect([(await get(app, "/openapi.json")).status, warnings]).toEqual([
			200,
			[expect.stringMatching(/SCHEMA_DEGRADED.*POST \/odd/s)],
		])
	})
})

describe("serveOpenApi: built once per route change", () => {
	// v0: 566cab4499
	// v0: d07111f349
	// v0: e46580ce46
	// v0: 2b491c0f59
	it("generates and serializes once per format until a route changes, then rebuilds both", async () => {
		const app = honey<{}>()
		app.get("/a").handler((c) => c.res.text("ok", "a"))
		let generations = 0
		serveOpenApi(app, {
			filterRoutes: (route) => (route.path === "/a" ? ++generations : 1) > 0,
			title: "T",
			version: "1",
		})
		const stringify = vi.spyOn(JSON, "stringify")
		const bodies = new Set<string>()
		for (let i = 0; i < 5; i++) bodies.add(await text(app, "/openapi.json"))
		for (let i = 0; i < 3; i++) await text(app, "/openapi.yaml")
		const documents = stringify.mock.calls.filter(([v]) => (v as { openapi?: string } | null)?.openapi === "3.1.0")
		stringify.mockRestore()
		const before = [generations, documents.length, bodies.size]
		app.get("/b").handler((c) => c.res.text("ok", "b"))
		expect([
			before,
			Object.keys((await json(app, "/openapi.json")).paths),
			(await text(app, "/openapi.yaml")).includes("/b:"),
			generations,
		]).toEqual([[1, 2, 1], ["/a", "/b"], true, 2])
	})
})

describe("serveOpenApi: a failed build", () => {
	// v0: 97b0eee277
	it("answers a failed build with a 500 until a route changes, without building again, then retries", async () => {
		const app = users()
		let failing = true
		let calls = 0
		serveOpenApi(app, {
			filterRoutes: () => {
				calls++
				if (failing) throw new Error("build failed")
				return true
			},
			logger: SILENT,
			title: "T",
			version: "1",
		})
		const first = (await get(app, "/openapi.json")).status
		const failedCalls = calls
		failing = false
		const again = (await get(app, "/openapi.json")).status
		const sameCalls = calls
		app.get("/later").handler((c) => c.res.text("ok", "later"))
		const after = await get(app, "/openapi.json")
		expect([
			first,
			again,
			sameCalls === failedCalls,
			after.status,
			Object.keys(((await after.json()) as Doc).paths),
		]).toEqual([500, 500, true, 200, ["/health", "/users", "/users/{id}", "/later"]])
	})
})

describe("serveOpenApi: caching headers", () => {
	// v0: df54b1782a
	it("sends a strong ETag with no-cache and nosniff, answers a match with an empty 304, and tags a changed document anew", async () => {
		const app = serveManifest(serveOpenApi(users(), { title: "T", version: "1" }))
		for (const path of ["/openapi.json", "/openapi.yaml", "/manifest.json"]) {
			const res = await get(app, path)
			const tag = res.headers.get("etag") ?? ""
			const hit = await get(app, path, { headers: { "if-none-match": `W/${tag}` } })
			expect([
				/^"[\w-]{22}"$/.test(tag),
				res.headers.get("cache-control"),
				res.headers.get("x-content-type-options"),
				hit.status,
				await hit.text(),
				hit.headers.get("etag") === tag,
			]).toEqual([true, "no-cache", "nosniff", 304, "", true])
		}
		const before = (await get(app, "/openapi.json")).headers.get("etag") ?? ""
		app.get("/b").handler((c) => c.res.text("ok", "b"))
		const changed = await get(app, "/openapi.json", { headers: { "if-none-match": before } })
		expect([changed.status, changed.headers.get("etag") === before]).toEqual([200, false])
	})

	// v0: aeb6f13242
	it("gives a storm of concurrent requests one document, and the next one after a new route", async () => {
		const app = serveOpenApi(users(), { title: "Storm", version: "1" })
		const storm = await Promise.all(Array.from({ length: 50 }, () => text(app, "/openapi.json")))
		app.get("/later").handler((c) => c.res.text("ok", "later"))
		const later = Object.keys((await json(app, "/openapi.json")).paths)
		expect([new Set(storm).size, later.includes("/later")]).toEqual([1, true])
	})
})

describe("serveOpenApi: the docs UI", () => {
	// v0: b8afbd8d98
	// v0: 7af4a56bf4
	// v0: b76e662e6a
	it("mounts no docs page unless asked, Scalar or Swagger at /docs when asked, each pointing at the JSON", async () => {
		const page = async (docs?: "scalar" | "swagger") => {
			const res = await get(serveOpenApi(users(), { docs, title: "T", version: "1" }), "/docs")
			return [
				res.status,
				res.status === 200 ? /cdn\.jsdelivr\.net\/npm\/(@scalar|swagger-ui-dist)/.exec(await res.text())?.[1] : null,
			]
		}
		expect([await page(), await page("scalar"), await page("swagger")]).toEqual([
			[404, null],
			[200, "@scalar"],
			[200, "swagger-ui-dist"],
		])
		expect(await text(serveOpenApi(users(), { docs: "swagger", title: "T", version: "1" }), "/docs")).toContain(
			'"url":"/openapi.json"',
		)
	})

	// v0: 8333ad60e0
	// v0: d3c0fb55b5
	it("mounts at docsPath, and points at the URL the browser sees: stripped prefix, then basePath, then the stem", async () => {
		const based = honey<{}>()
		serveOpenApi(based.basePath("/api"), { docs: "scalar", docsPath: "/reference", title: "T", version: "1" })
		const stripped = honey<{}>().stripPrefix("/edge")
		serveOpenApi(stripped.basePath("/v1"), { docs: "scalar", title: "T", version: "1" })
		expect([
			await text(based, "/api/reference"),
			await text(stripped, "/edge/v1/docs"),
			(await get(stripped, "/edge/v1/openapi.json")).status,
		]).toEqual([
			expect.stringContaining('"url":"/api/openapi.json"'),
			expect.stringContaining('"url":"/edge/v1/openapi.json"'),
			200,
		])
	})
})

describe("serveManifest: the published manifest", () => {
	// v0: fcc17af2f3
	// v0: 3e40c123b7
	// v0: 6c3fe953a3
	// v0: ca95a7d053
	// v0: ac1b3f50b9
	it("serves the published manifest under the handle's basePath or at its own path, refreshed after a new route", async () => {
		const app = honey<{}>()
		app.get("/health").handler((c) => c.res.text("ok", "ok"))
		app
			.get("/hidden")
			.meta({ internal: true, worker: "x" } as never)
			.handler((c) => c.res.text("ok", "ok"))
		app
			.get("/shown")
			.meta({ worker: "x" } as never)
			.handler((c) => c.res.text("ok", "ok"))
		serveManifest(app.basePath("/api"))
		serveManifest(app, { path: "/_meta/routes" })
		const read = async (path: string) =>
			(await (await get(app, path)).json()) as { errors: unknown[]; routes: { meta: object; path: string }[] }
		const first = await read("/api/manifest.json")
		app.get("/later").handler((c) => c.res.text("ok", "later"))
		expect([
			(await get(app, "/api/manifest.json")).headers.get("content-type"),
			first.errors,
			first.routes.map((r) => [r.path, r.meta]),
			(await read("/_meta/routes")).routes.map((r) => r.path),
		]).toEqual([
			"application/json; charset=utf-8",
			[],
			[
				["/health", {}],
				["/shown", {}],
			],
			["/health", "/shown", "/later"],
		])
	})
})

describe("serving across composed apps (F15)", () => {
	// v0: 28817fb649
	// v0: 44ec7ed497
	it.each(["gateway-first", "sub-first"])(
		"keeps a sub's served routes with the sub: the gateway serves its own (%s)",
		async (order) => {
			const sub = honey<{}>()
			sub.get("/users").handler((c) => c.res.text("ok", "users"))
			serveManifest(serveOpenApi(sub, { docs: "scalar", title: "Sub", version: "1" }))
			const gateway = honey<{}>()
			gateway.get("/health").handler((c) => c.res.text("ok", "ok"))
			if (order === "gateway-first") serveOpenApi(gateway, { docs: "swagger", title: "Gateway", version: "1" })
			gateway.route(sub)
			if (order === "sub-first") serveOpenApi(gateway, { docs: "swagger", title: "Gateway", version: "1" })
			const doc = await json(gateway, "/openapi.json")
			expect([
				doc.info.title,
				Object.keys(doc.paths),
				(await text(gateway, "/docs")).includes("swagger-ui"),
				(await get(gateway, "/manifest.json")).status,
				(await json(sub, "/openapi.json")).info.title,
			]).toEqual(["Gateway", ["/health", "/users"], true, 404, "Sub"])
		},
	)
})

describe("serving across composed and loaded apps (F15)", () => {
	// v0: 4c03f4af4e
	// v0: d2293e2891
	it("mounts two serving apps without a collision, and leaves served routes out of a snapshot an app loads and serves again", async () => {
		const a = serveOpenApi(users(), { docs: "scalar", title: "A", version: "1" })
		const b = honey<{}>()
		b.get("/b").handler((c) => c.res.text("ok", "b"))
		serveOpenApi(b, { docs: "scalar", title: "B", version: "1" })
		a.route(b)
		const snapshot = usersServing().toRouteTree()
		const loaded = usersServing(snapshot)
		expect([
			(await get(a, "/b")).status,
			(await get(a, "/docs")).status,
			Object.keys(snapshot.routes),
			JSON.stringify(snapshot.root).includes("openapi"),
			(await get(loaded, "/openapi.json")).status,
			(await get(loaded, "/docs")).status,
			Object.keys((await json(loaded, "/openapi.json")).paths),
		]).toEqual([200, 200, ["GET /users"], false, 200, 200, ["/users"]])
	})

	// v0: b415d83716
	it("documents a scoped middleware's keys on the routes it covers only, a served route among them still answering", async () => {
		const errors = defineErrors({ blocked: "forbidden", teapot: "bad_request" })
		const block = defineMiddleware({ errors: [errors, "blocked"], fn: async (_c, next) => next() })
		const app = honey<{}>().errorFactory(errors).defaultErrors("teapot")
		serveOpenApi(app, { title: "t", version: "1" })
		app.use("/openapi.json", block)
		app.use("/admin", block)
		app.get("/admin/x").handler((c) => c.res.json("ok", {}))
		app.get("/public").handler((c) => c.res.json("ok", {}))
		const doc = await json(app, "/openapi.json")
		expect([
			Object.keys(doc.paths["/admin/x"]?.get?.responses ?? {}),
			Object.keys(doc.paths["/public"]?.get?.responses ?? {}),
		]).toEqual([["400", "403"], ["400"]])
	})
})
