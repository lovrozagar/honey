import { describe, expect, it } from "vitest"
import * as z from "zod"
import { generateRouteTree, generateRouteTreeFromApp, prepareCodegen } from "../../../src/codegen.ts"
import { defineErrors, honey } from "../../../src/index.ts"
import type { RouteHandler, RouteTree } from "../../../src/tree.ts"

async function evalTreeModule(code: string): Promise<{
	handlers: Record<string, RouteHandler>
	meta?: Record<string, Record<string, unknown>>
	routeTree: RouteTree
}> {
	const { transform } = await import("esbuild")
	const rewritten = code.replace(
		/from\s+"@lovrozagar\/honey\/tree"/g,
		`from ${JSON.stringify(new URL("../../../src/tree.ts", import.meta.url).href)}`,
	)
	const { code: js } = await transform(rewritten, {
		format: "esm",
		loader: "ts",
		target: "esnext",
	})
	const dataUrl = `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
	return (await import(dataUrl)) as {
		handlers: Record<string, RouteHandler>
		meta?: Record<string, Record<string, unknown>>
		routeTree: RouteTree
	}
}

describe("generateRouteTree packed JSON", () => {
	it("keeps unique handlers and unique Sets when error keys match", async () => {
		const code = generateRouteTree([
			{
				boundaryErrorKey: "internal_server_error",
				errorKeys: ["internal_server_error", "forbidden"],
				inputSchemas: null,
				meta: { worker: "api" },
				method: "GET",
				middlewareNames: [],
				outputSchemas: null,
				path: "/a",
			},
			{
				boundaryErrorKey: "internal_server_error",
				errorKeys: ["internal_server_error", "forbidden"],
				inputSchemas: null,
				meta: { worker: "api" },
				method: "GET",
				middlewareNames: [],
				outputSchemas: null,
				path: "/b",
			},
		])
		expect(code).toContain("assembleRouteTree")
		expect(code).toContain("PackedRouteTable")
		expect(code).toContain('"GET /a"')
		expect(code).toContain('"GET /b"')
		expect(code).toContain("internal_server_error")

		const { handlers } = await evalTreeModule(code)
		expect(handlers["GET /a"]).not.toBe(handlers["GET /b"])
		expect(handlers["GET /a"].ek).not.toBe(handlers["GET /b"].ek)
		expect(handlers["GET /a"].ek).toEqual(handlers["GET /b"].ek)
		handlers["GET /a"].ek.add("extra")
		expect(handlers["GET /b"].ek.has("extra")).toBe(false)
		expect(handlers["GET /a"].mt).toEqual(handlers["GET /b"].mt)
		expect(handlers["GET /a"].fn).toBeNull()
	})

	it("round-trips identical iv/os JSON", async () => {
		const schema = {
			json: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
		}
		const os = {
			"application/json": {
				ok: { additionalProperties: false, properties: { id: { type: "string" } }, required: ["id"], type: "object" },
			},
		}
		const code = generateRouteTree([
			{
				boundaryErrorKey: null,
				errorKeys: [],
				inputSchemas: schema,
				meta: null,
				method: "POST",
				middlewareNames: [],
				outputSchemas: os,
				path: "/one",
			},
			{
				boundaryErrorKey: null,
				errorKeys: [],
				inputSchemas: schema,
				meta: null,
				method: "POST",
				middlewareNames: [],
				outputSchemas: os,
				path: "/two",
			},
		])
		expect(code).toContain('"j":')
		const { handlers } = await evalTreeModule(code)
		expect(handlers["POST /one"].iv).toEqual(schema)
		expect(handlers["POST /one"].os).toEqual(os)
		expect(handlers["POST /one"].iv).toEqual(handlers["POST /two"].iv)
		expect(handlers["POST /one"].os).toEqual(handlers["POST /two"].os)
	})

	it("keeps a unique error key greppable in the packed table", () => {
		const code = generateRouteTree([
			{
				boundaryErrorKey: null,
				errorKeys: ["email_taken"],
				inputSchemas: null,
				meta: null,
				method: "GET",
				middlewareNames: [],
				outputSchemas: null,
				path: "/users",
			},
		])
		expect(code).toContain("email_taken")
	})

	it("wildcard and root routes still compile", async () => {
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
		expect(code).toContain("GET /")
		expect(code).toContain("/files/*path")
		const { handlers } = await evalTreeModule(code)
		expect(handlers["GET /"]).toBeDefined()
		expect(handlers["GET /files/*path"]).toBeDefined()
	})
})

describe("generateRouteTreeFromApp packed JSON + MetaShape", () => {
	it("meta export reuses the handler mt object", async () => {
		await prepareCodegen()
		const app = honey<{}>()
			.meta<{ tags: string[]; summary: string }>()
			.get("/orgs")
			.meta({ summary: "List orgs", tags: ["orgs"] })
			.handler((c) => c.res.text("ok", "ok"))

		const code = generateRouteTreeFromApp(app)
		expect(code).toContain("assembleRouteTree")
		expect(code).toContain('"summary":"List orgs"')
		expect(code).toContain('tags: ["orgs"]')
		expect(code).toContain("& Record<string, unknown>")
		expect(code).not.toContain("unknown[]")
		expect(code).toContain("export type RouteSelector = typeof P[number]")

		const { handlers, meta, routeTree } = await evalTreeModule(code)
		expect(meta?.["GET /orgs"]).toBe(handlers["GET /orgs"].mt)
		expect(routeTree.meta["GET /orgs"]).toBe(handlers["GET /orgs"].mt)
		expect(handlers["GET /orgs"].mt).toEqual({ summary: "List orgs", tags: ["orgs"] })
	})

	it("shared nested string schemas survive JSON.parse structurally", async () => {
		await prepareCodegen()
		const app = honey<{}>()
		const body = z.object({ email: z.string().email(), name: z.string() })
		app
			.post("/a")
			.input({ json: body })
			.handler((c) => c.res.text("ok", "ok"))
		app
			.post("/b")
			.input({ json: body })
			.handler((c) => c.res.text("ok", "ok"))
		const code = generateRouteTreeFromApp(app)
		expect(code).toContain('"email"')
		const { handlers } = await evalTreeModule(code)
		expect(handlers["POST /a"].iv).toEqual(handlers["POST /b"].iv)
	})

	it("preserves pre-built ek greppability for a single route", () => {
		const errors = defineErrors({ email_taken: "conflict" })
		const app = honey<{}>()
			.get("/users")
			.errors(errors, "email_taken")
			.handler((c) => c.res.text("ok", "ok"))
		const code = generateRouteTreeFromApp(app)
		expect(code).toContain("email_taken")
	})
})

describe("packed schema keys", () => {
	it("round-trips a property named type and required: ['type']", async () => {
		const schema = {
			json: {
				properties: { type: { type: "string" } },
				required: ["type"],
				type: "object",
			},
		}
		const code = generateRouteTree([
			{
				boundaryErrorKey: null,
				errorKeys: [],
				inputSchemas: schema,
				meta: null,
				method: "POST",
				middlewareNames: [],
				outputSchemas: null,
				path: "/typed",
			},
		])
		expect(code).toContain('"t":"o"')
		expect(code).toContain('"r":["type"]')
		const { handlers } = await evalTreeModule(code)
		expect(handlers["POST /typed"].iv).toEqual(schema)
	})

	it("does not rewrite enum values that match vocabulary words", async () => {
		const schema = {
			json: { enum: ["type", "properties", "required"], type: "string" },
		}
		const code = generateRouteTree([
			{
				boundaryErrorKey: null,
				errorKeys: [],
				inputSchemas: schema,
				meta: null,
				method: "POST",
				middlewareNames: [],
				outputSchemas: null,
				path: "/kind",
			},
		])
		expect(code).toContain('"en":["type","properties","required"]')
		const { handlers } = await evalTreeModule(code)
		expect(handlers["POST /kind"].iv).toEqual(schema)
	})

	it("collapses duplicate iv/os columns to a value table", async () => {
		const schema = {
			json: {
				properties: { email: { format: "email", type: "string" }, name: { type: "string" } },
				required: ["email", "name"],
				type: "object",
			},
		}
		const code = generateRouteTree([
			{
				boundaryErrorKey: null,
				errorKeys: ["taken"],
				inputSchemas: schema,
				meta: { worker: "api" },
				method: "POST",
				middlewareNames: [],
				outputSchemas: null,
				path: "/a",
			},
			{
				boundaryErrorKey: null,
				errorKeys: ["taken"],
				inputSchemas: schema,
				meta: { worker: "api" },
				method: "POST",
				middlewareNames: [],
				outputSchemas: null,
				path: "/b",
			},
		])
		expect(code).toContain('"t":')
		expect(code).toContain('"x":')
		expect(code).toContain('"k":["taken"]')
		expect(code).toContain('"f":"e"')
		expect(code).toContain('"t":"s"')
		const { handlers } = await evalTreeModule(code)
		expect([...handlers["POST /a"].ek]).toEqual(["taken"])
		expect(handlers["POST /a"].mt).toEqual({ worker: "api" })
		expect(handlers["POST /a"].iv).toEqual(schema)
	})

	it("packs repeated meta keys through a u dictionary", async () => {
		const metaA = {
			operationId: "listThings",
			permissions: "things:read",
			security: "jwt",
			summary: "List things",
			tags: ["things"],
			tenant: "auto",
			worker: "api",
		}
		const metaB = {
			operationId: "getThing",
			permissions: "things:write",
			security: "apiKey",
			summary: "Get thing",
			tags: ["things"],
			tenant: "auto",
			worker: "api",
		}
		const code = generateRouteTree([
			{
				boundaryErrorKey: null,
				errorKeys: [],
				inputSchemas: null,
				meta: metaA,
				method: "GET",
				middlewareNames: [],
				outputSchemas: null,
				path: "/a",
			},
			{
				boundaryErrorKey: null,
				errorKeys: [],
				inputSchemas: null,
				meta: metaB,
				method: "GET",
				middlewareNames: [],
				outputSchemas: null,
				path: "/b",
			},
		])
		expect(code).toContain('"u":')
		expect(code).toContain("operationId")
		const { handlers } = await evalTreeModule(code)
		expect(handlers["GET /a"].mt).toEqual(metaA)
		expect(handlers["GET /b"].mt).toEqual(metaB)
	})

	it("emits n1 for a nullable oneOf string", async () => {
		const schema = {
			json: { oneOf: [{ type: "string" }, { type: "null" }] },
		}
		const code = generateRouteTree([
			{
				boundaryErrorKey: null,
				errorKeys: [],
				inputSchemas: schema,
				meta: null,
				method: "GET",
				middlewareNames: [],
				outputSchemas: null,
				path: "/opt",
			},
		])
		expect(code).toContain('"n1":1')
		expect(code).not.toContain("oneOf")
		const { handlers } = await evalTreeModule(code)
		expect(handlers["GET /opt"].iv).toEqual(schema)
	})

	it("emits JSON.parse when a property is named __proto__", async () => {
		const properties = Object.create(null) as Record<string, unknown>
		Object.defineProperty(properties, "__proto__", {
			configurable: true,
			enumerable: true,
			value: { type: "string" },
			writable: true,
		})
		const schema = { json: { properties, type: "object" } }
		const code = generateRouteTree([
			{
				boundaryErrorKey: null,
				errorKeys: [],
				inputSchemas: schema,
				meta: null,
				method: "POST",
				middlewareNames: [],
				outputSchemas: null,
				path: "/proto",
			},
		])
		expect(code).toContain("JSON.parse")
		const { handlers } = await evalTreeModule(code)
		const iv = handlers["POST /proto"].iv as { json: { properties: Record<string, unknown>; type: string } }
		expect(Object.hasOwn(iv.json.properties, "__proto__")).toBe(true)
		expect(Object.getOwnPropertyDescriptor(iv.json.properties, "__proto__")?.value).toEqual({ type: "string" })
		expect(iv.json.type).toBe("object")
	})
})
