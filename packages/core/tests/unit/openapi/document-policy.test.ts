import { describe, expect, it, vi } from "vitest"
import * as z from "zod"
import { deduplicateSchemas, generateManifest, generateOpenApi, resolveRefs } from "../../../src/codegen.ts"
import { honey } from "../../../src/index.ts"
import { findMissingInvalidate } from "../../../src/invalidate-check.ts"
import { compileMetaSpec, mergeMetaSpec, MetaSpecCollector, publishableMetaKeys } from "../../../src/meta-spec.ts"
import { spec } from "../../../src/openapi/spec.ts"
import { bindInternalHandler, resetOpenApiRuntime } from "../../../src/openapi/spec-factory.ts"

const INFO = { title: "T", version: "1" }
type Ops = Record<string, Record<string, Record<string, unknown>>>

function ops(doc: { paths: unknown }): Ops {
	return doc.paths as Ops
}

describe("paths and methods (H34)", () => {
	it("a named wildcard is a path parameter, an unnamed one too", async () => {
		const app = honey<{}>()
		app.get("/files/*path").handler((c) => c.res.text("ok", "ok"))
		app.get("/star/*").handler((c) => c.res.text("ok", "ok"))
		const doc = await generateOpenApi(app, { info: INFO })
		expect(Object.keys(doc.paths).sort()).toEqual(["/files/{path}", "/star/{wildcard}"])
		const param = (ops(doc)["/files/{path}"].get.parameters as Array<Record<string, unknown>>)[0]
		expect(param).toMatchObject({ in: "path", name: "path", required: true, "x-honey-wildcard": true })
	})

	it("all() documents the standard methods, never an `all` key, and yields to explicit routes", async () => {
		const app = honey<{}>()
		app.get("/upstream/*path").handler((c) => c.res.text("ok", "explicit"))
		app.all("/upstream/*path").handler((c) => c.res.text("ok", "proxy"))
		const doc = await generateOpenApi(app, { info: INFO })
		const item = ops(doc)["/upstream/{path}"]
		expect(item).not.toHaveProperty("all")
		expect(Object.keys(item).sort()).toEqual(["delete", "get", "patch", "post", "put"])
	})

	it("every path parameter is required, optional-param variants included", async () => {
		const app = honey<{}>()
		app.get("/opt/:id?").handler((c) => c.res.text("ok", "ok"))
		const doc = await generateOpenApi(app, { info: INFO })
		expect(ops(doc)["/opt"].get.parameters).toBeUndefined()
		expect(ops(doc)["/opt/{id}"].get.parameters).toEqual([
			{ in: "path", name: "id", required: true, schema: { type: "string" } },
		])
	})
})

describe("operationIds", () => {
	it("one route expanded into several operations gets method and variant suffixes", async () => {
		const app = honey<{}>()
		app
			.on(["GET", "POST"], "/multi")
			.meta({ operationId: "multi" })
			.handler((c) => c.res.text("ok", "ok"))
		app
			.get("/opt/:id?")
			.meta({ operationId: "opt" })
			.handler((c) => c.res.text("ok", "ok"))
		const doc = await generateOpenApi(app, { info: INFO })
		expect(ops(doc)["/multi"].get.operationId).toBe("multi_get")
		expect(ops(doc)["/multi"].post.operationId).toBe("multi_post")
		expect(ops(doc)["/opt"].get.operationId).toBe("opt")
		expect(ops(doc)["/opt/{id}"].get.operationId).toBe("opt_with_id")
	})

	it("two routes declaring the same operationId fail generation", async () => {
		const app = honey<{}>()
		app
			.get("/a")
			.meta({ operationId: "same" })
			.handler((c) => c.res.text("ok", "ok"))
		app
			.get("/b")
			.meta({ operationId: "same" })
			.handler((c) => c.res.text("ok", "ok"))
		await expect(generateOpenApi(app, { info: INFO })).rejects.toThrow(/DUPLICATE_OPERATION_ID/)
	})
})

describe("content types", () => {
	it("json and form bodies of one route are both documented", async () => {
		const app = honey<{}>()
		app
			.post("/both")
			.input({ form: z.object({ f: z.string() }), json: z.object({ j: z.number() }) })
			.handler((c) => c.res.text("ok", "ok"))
		const doc = resolveRefs(await generateOpenApi(app, { info: INFO }))
		const content = (ops(doc)["/both"].post.requestBody as { content: Record<string, { schema: unknown }> }).content
		expect(Object.keys(content).sort()).toEqual(["application/json", "application/x-www-form-urlencoded"])
		expect(content["application/json"].schema).toMatchObject({ properties: { j: { type: "number" } } })
		expect(content["application/x-www-form-urlencoded"].schema).toMatchObject({ properties: { f: { type: "string" } } })
	})

	it("two response content types of one status keep their own schemas", async () => {
		const app = honey<{}>()
		app
			.get("/doc")
			.output({
				"application/json": { ok: z.object({ id: z.string() }) },
				"text/csv": { ok: z.string() },
			})
			.handler((c) => c.res.json("ok", { id: "1" }))
		const doc = await generateOpenApi(app, { info: INFO })
		const content = (ops(doc)["/doc"].get.responses as Record<string, { content: Record<string, unknown> }>)["200"]
			.content
		const resolved = resolveRefs(doc)
		const rc = (
			ops(resolved)["/doc"].get.responses as Record<string, { content: Record<string, { schema: unknown }> }>
		)["200"].content
		expect(Object.keys(content).sort()).toEqual(["application/json", "text/csv"])
		expect(rc["application/json"].schema).toMatchObject({ type: "object" })
		expect(rc["text/csv"].schema).toEqual({ type: "string" })
	})

	it("deduplicateSchemas keys slots by content type, so JSON never points at the XML schema", () => {
		const json = { properties: { a: { type: "string" } }, type: "object" }
		const xml = { properties: { b: { type: "string" } }, type: "object" }
		const deduped = deduplicateSchemas({
			info: INFO,
			openapi: "3.1.0",
			paths: {
				"/x": {
					get: {
						responses: {
							"200": {
								content: { "application/json": { schema: json }, "application/xml": { schema: xml } },
								description: "ok",
							},
						},
					},
				},
			},
		})
		const resolved = resolveRefs(deduped)
		const content = (
			resolved.paths["/x"].get.responses as Record<string, { content: Record<string, { schema: unknown }> }>
		)["200"].content
		expect(content["application/json"].schema).toEqual(json)
		expect(content["application/xml"].schema).toEqual(xml)
	})

	it("an existing component is never overwritten by a derived name", () => {
		const existing = { properties: { keep: { type: "string" } }, type: "object" }
		const deduped = deduplicateSchemas({
			components: { schemas: { ListXResponse200: existing } },
			info: INFO,
			openapi: "3.1.0",
			paths: {
				"/x": {
					get: {
						responses: {
							"200": {
								content: {
									"application/json": { schema: { properties: { other: { type: "number" } }, type: "object" } },
								},
								description: "ok",
							},
						},
					},
				},
			},
		})
		expect(deduped.components?.schemas?.ListXResponse200).toEqual(existing)
		expect(Object.keys(deduped.components?.schemas ?? {})).toHaveLength(2)
	})

	it("a `default` response key never becomes NaN in a schema name", () => {
		const deduped = deduplicateSchemas({
			info: INFO,
			openapi: "3.1.0",
			paths: {
				"/x": {
					get: {
						responses: {
							default: {
								content: { "application/json": { schema: { properties: { e: { type: "string" } }, type: "object" } } },
								description: "err",
							},
						},
					},
				},
			},
		})
		expect(Object.keys(deduped.components?.schemas ?? {}).join(",")).not.toMatch(/NaN/)
	})
})

describe("schemas", () => {
	it("unions stay anyOf — overlapping members must not start rejecting valid values", async () => {
		const app = honey<{}>()
		app
			.get("/u")
			.output({ "application/json": { ok: z.object({ v: z.union([z.string(), z.string().email()]) }) } })
			.handler((c) => c.res.json("ok", { v: "a" }))
		const doc = resolveRefs(await generateOpenApi(app, { info: INFO }))
		const text = JSON.stringify(doc)
		expect(text).toContain('"anyOf"')
		expect(text).not.toContain('"oneOf"')
	})

	it("a recursive schema's self-reference points at its component, not the document root", async () => {
		const Category = z.object({
			name: z.string(),
			get subcategories() {
				return z.array(Category)
			},
		})
		const app = honey<{}>()
		app
			.get("/categories")
			.output({ "application/json": { ok: Category } })
			.handler((c) => c.res.json("ok", { name: "a", subcategories: [] }))
		const doc = await generateOpenApi(app, { info: INFO })
		const text = JSON.stringify(doc)
		expect(text).not.toContain('"$ref":"#"')
		expect(text).not.toContain("$defs")
		const schemas = doc.components?.schemas ?? {}
		const [name] = Object.keys(schemas).filter((n) => JSON.stringify(schemas[n]).includes("subcategories"))
		expect(name).toBeDefined()
		expect(JSON.stringify(schemas[name])).toContain(`"$ref":"#/components/schemas/${name}"`)
	})
})

describe("websocket operations", () => {
	it("go through filterRoutes and meta.internal, and never replace an HTTP GET", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const app = honey<{}>()
			app.get("/live").handler((c) => c.res.text("ok", "http"))
			app.ws("/live").handler({ onMessage() {} })
			app
				.ws("/hidden")
				.meta({ internal: true })
				.handler({ onMessage() {} })
			app.ws("/filtered").handler({ onMessage() {} })
			const doc = await generateOpenApi(app, {
				filterRoutes: (r) => r.path !== "/filtered",
				info: INFO,
			})
			expect(ops(doc)["/live"].get["x-websocket"]).toBeUndefined()
			expect(doc.paths["/hidden"]).toBeUndefined()
			expect(doc.paths["/filtered"]).toBeUndefined()
		} finally {
			warn.mockRestore()
		}
	})

	it("drop x-internal search fields", async () => {
		const app = honey<{}>()
		app
			.ws("/s")
			.input({ search: z.object({ secret: z.string().meta({ "x-internal": true }), token: z.string() }) })
			.handler({ onMessage() {} })
		const doc = await generateOpenApi(app, { info: INFO })
		const names = (ops(doc)["/s"].get.parameters as Array<{ name: string }>).map((p) => p.name)
		expect(names).toEqual(["token"])
	})
})

describe("filterRoutes", () => {
	it("receives an object for meta, never null", async () => {
		const app = honey<{}>()
		app.get("/plain").handler((c) => c.res.text("ok", "ok"))
		const doc = await generateOpenApi(app, {
			filterRoutes: (r) => (r.meta as { hidden?: boolean }).hidden !== true,
			info: INFO,
		})
		expect(doc.paths["/plain"]).toBeDefined()
	})
})

describe("validation against the inventory", () => {
	it("an invalidate selector that names no route fails generation", async () => {
		const app = honey<{}>()
		app
			.post("/users")
			.meta({ invalidate: ["GET /userz"] } as never)
			.handler((c) => c.res.text("ok", "ok"))
		await expect(generateOpenApi(app, { info: INFO })).rejects.toThrow(/INVALID_SELECTOR.*GET \/userz/)
		/* a served document does not check it */
		await expect(generateOpenApi(app, { info: INFO, invalidate: "off" })).resolves.toBeDefined()
	})

	it("duplicate selectors are emitted once", async () => {
		const app = honey<{}>()
		app.get("/users").handler((c) => c.res.text("ok", "ok"))
		app
			.post("/users")
			.meta({ invalidate: ["GET /users", "GET /users"] })
			.handler((c) => c.res.text("ok", "ok"))
		const doc = await generateOpenApi(app, { info: INFO })
		expect(ops(doc)["/users"].post["x-invalidate"]).toEqual(["GET /users"])
	})

	it("a security scheme missing from securitySchemes fails generation", async () => {
		const app = honey<{}>()
		app
			.get("/me")
			.meta({ security: "jwt" })
			.handler((c) => c.res.text("ok", "ok"))
		await expect(
			generateOpenApi(app, { info: INFO, securitySchemes: { apiKey: { in: "header", name: "k", type: "apiKey" } } }),
		).rejects.toThrow(/UNKNOWN_SECURITY_SCHEME/)
		await expect(
			generateOpenApi(app, { info: INFO, securitySchemes: { jwt: { scheme: "bearer", type: "http" } } }),
		).resolves.toBeDefined()
	})
})

describe("metaSpec composition", () => {
	it("a sub-app's strict:off never downgrades a parent that left strict at its default", () => {
		const merged = mergeMetaSpec({ meta: {} }, { meta: {}, strict: "off" })
		expect(merged?.strict).toBe("error")
		const collector = new MetaSpecCollector()
		expect(compileMetaSpec(merged, collector).strict).toBe("error")
	})

	it("entries for different targets or disjoint profiles are not duplicates", () => {
		const collector = new MetaSpecCollector()
		compileMetaSpec(
			{
				meta: {
					a: { key: "x-thing", on: "http" },
					b: { key: "x-thing", on: "ws" },
					c: { key: "x-other", profiles: ["public"] },
					d: { key: "x-other", profiles: ["internal"] },
				},
			},
			collector,
		)
		expect(collector.diagnostics.filter((d) => d.code === "DUPLICATE_TARGET")).toEqual([])
	})

	it("overlapping entries are still duplicates", () => {
		const collector = new MetaSpecCollector()
		compileMetaSpec({ meta: { a: { key: "x-thing" }, b: { key: "x-thing", on: "http" } } }, collector)
		expect(collector.diagnostics.some((d) => d.code === "DUPLICATE_TARGET")).toBe(true)
	})
})

describe("served manifest", () => {
	it("applies the document's visibility policy", () => {
		const app = honey<{}>()
		app.metaSpec({ meta: { captcha: false, team: "x-team" } } as never)
		app
			.get("/public")
			.meta({ captcha: true, summary: "Public", team: "core", worker: "origin" } as never)
			.handler((c) => c.res.text("ok", "ok"))
		app
			.get("/admin/secret")
			.meta({ internal: true } as never)
			.handler((c) => c.res.text("ok", "ok"))

		const published = generateManifest(app, { visibility: "published" })
		expect(published.routes.map((r) => r.path)).toEqual(["/public"])
		expect(published.routes[0].meta).toEqual({ summary: "Public", team: "core" })

		/* the generate-time artifact keeps everything */
		const all = generateManifest(app)
		expect(all.routes.map((r) => r.path).sort()).toEqual(["/admin/secret", "/public"])
	})

	it("publishableMetaKeys: built-ins and mapped keys, never hidden or unmapped ones", () => {
		const allowed = publishableMetaKeys({ meta: { summary: false, team: "x-team" } })
		expect(allowed("team")).toBe(true)
		expect(allowed("tags")).toBe(true)
		expect(allowed("summary")).toBe(false)
		expect(allowed("internal")).toBe(false)
		expect(allowed("worker")).toBe(false)
	})

	it("the /manifest.json route serves the published view", async () => {
		await import("../../../src/openapi/register.ts")
		const app = honey<{}>()
		app.manifest()
		app
			.get("/hidden")
			.meta({ internal: true, worker: "x" } as never)
			.handler((c) => c.res.text("ok", "ok"))
		app
			.get("/shown")
			.meta({ worker: "x" } as never)
			.handler((c) => c.res.text("ok", "ok"))
		const body = (await (await app.fetch(new Request("http://x/manifest.json"), {})).json()) as {
			routes: Array<{ meta: Record<string, unknown>; path: string }>
		}
		expect(body.routes.map((r) => r.path)).toEqual(["/shown"])
		expect(body.routes[0].meta).toEqual({})
	})
})

describe("invalidate check", () => {
	const mutation = (meta: Record<string, unknown> | null, operation: Record<string, unknown> = {}) => ({
		meta,
		method: "post",
		operation,
		path: "/users",
	})
	const read = { meta: null, method: "get", operation: {}, path: "/users" }

	it("a profile without x-invalidate does not make a declared mutation look undeclared", () => {
		expect(findMissingInvalidate([read, mutation({ invalidate: ["GET /users"] })], undefined)).toEqual([])
	})

	it("an entity with no tagged reader falls back to path shape instead of staying silent", () => {
		const findings = findMissingInvalidate([read, mutation(null, { "x-entity": "user" })], "x-entity")
		expect(findings).toEqual([{ affects: ["GET /users"], method: "POST", path: "/users" }])
	})
})

describe("server prefix and trailing slash", () => {
	it("stripPrefix becomes a server; trailingSlash(enforce) keeps the slash clients must send", async () => {
		const app = honey<{}>().stripPrefix("/api").trailingSlash("enforce")
		app.get("/users/:id").handler((c) => c.res.text("ok", "ok"))
		app.get("/").handler((c) => c.res.text("ok", "ok"))
		const doc = await generateOpenApi(app, { info: INFO })
		expect(doc.servers).toEqual([{ url: "/api" }])
		expect(Object.keys(doc.paths).sort()).toEqual(["/", "/users/{id}/"])
	})
})

describe("standalone spec()", () => {
	it("documents bodies and parameters without the codegen runtime, and keeps options out of info", async () => {
		resetOpenApiRuntime()
		const app = honey<{}>()
		const handler = spec({ profile: "default", securitySchemes: {}, title: "Docs", version: "2" })
		app.get("/openapi.json").handler(handler as never)
		app
			.post("/items")
			.input({ json: z.object({ name: z.string() }), search: z.object({ q: z.string() }) })
			.handler((c) => c.res.text("ok", "ok"))
		const doc = resolveRefs(await (await app.fetch(new Request("http://x/openapi.json"), {})).json()) as unknown as {
			info: Record<string, unknown>
			paths: Ops
		}
		expect(doc.info).toEqual({ title: "Docs", version: "2" })
		const post = doc.paths["/items"].post
		expect((post.parameters as Array<{ name: string }>).map((p) => p.name)).toEqual(["q"])
		expect(JSON.stringify(post.requestBody)).toContain('"name"')
	})

	it("rebuilds after routes change, and serves the same bytes otherwise", async () => {
		const app = honey<{}>()
		app.get("/openapi.json").handler(spec({ title: "T", version: "1" }) as never)
		app.get("/a").handler((c) => c.res.text("ok", "ok"))
		const first = await (await app.fetch(new Request("http://x/openapi.json"), {})).text()
		const again = await (await app.fetch(new Request("http://x/openapi.json"), {})).text()
		expect(again).toBe(first)
		app.get("/b").handler((c) => c.res.text("ok", "ok"))
		const after = JSON.parse(await (await app.fetch(new Request("http://x/openapi.json"), {})).text()) as {
			paths: Record<string, unknown>
		}
		expect(Object.keys(after.paths)).toContain("/b")
	})

	it("one handler bound to two apps documents each of them", async () => {
		const handler = spec({ title: "T", version: "1" })
		const a = honey<{}>()
		a.get("/only-a").handler((c) => c.res.text("ok", "ok"))
		const b = honey<{}>()
		b.get("/only-b").handler((c) => c.res.text("ok", "ok"))
		const res = { raw: (r: Response) => r as never }
		const docA = JSON.parse(await (await bindInternalHandler(handler, a)({ res } as never)).text())
		const docB = JSON.parse(await (await bindInternalHandler(handler, b)({ res } as never)).text())
		expect(Object.keys(docA.paths)).toEqual(["/only-a"])
		expect(Object.keys(docB.paths)).toEqual(["/only-b"])
	})
})

describe("schema name hash collisions", () => {
	it("two shapes whose 24-bit name hashes collide still get distinct components", () => {
		/* djb2 of these canonical forms collides in the first 6 hex digits */
		const a = { enum: ["aR"] }
		const b = { enum: ["b1"] }
		const op = (schema: unknown) => ({
			get: { responses: { "200": { content: { "application/json": { schema } }, description: "ok" } } },
		})
		/* same derived base name for both (the variant qualifier is dropped), different shapes */
		const deduped = deduplicateSchemas({
			info: INFO,
			openapi: "3.1.0",
			paths: { "/webhooks/github": op(a), "/webhooks/stripe": op(b) } as never,
		})
		const resolved = resolveRefs(deduped)
		const schemaOf = (p: string) =>
			(resolved.paths[p].get.responses as Record<string, { content: Record<string, { schema: unknown }> }>)["200"]
				.content["application/json"].schema
		expect(schemaOf("/webhooks/github")).toEqual(a)
		expect(schemaOf("/webhooks/stripe")).toEqual(b)
	})
})
