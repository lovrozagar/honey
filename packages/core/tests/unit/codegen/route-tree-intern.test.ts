import { describe, expect, it } from "vitest"
import * as z from "zod"
import { generateRouteTree, generateRouteTreeFromApp, prepareCodegen } from "../../../src/codegen.ts"
import { InternPool } from "../../../src/codegen-route-tree-intern.ts"
import { defineErrors, honey } from "../../../src/index.ts"
import type { RouteHandler, RouteTree } from "../../../src/tree.ts"

async function evalTreeModule(code: string): Promise<{
	handlers: Record<string, RouteHandler>
	meta?: Record<string, Record<string, unknown>>
	routeTree: RouteTree
}> {
	const { transform } = await import("esbuild")
	const { code: js } = await transform(code, {
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

describe("InternPool", () => {
	it("inlines unique short strings and small unique objects", () => {
		const pool = new InternPool()
		pool.count("ok")
		pool.count({ type: "boolean" })
		pool.seal()
		expect(pool.emitConstLines()).toEqual([])
		expect(pool.expr("ok")).toBe('"ok"')
		expect(pool.expr({ type: "boolean" })).toBe('{"type":"boolean"}')
	})

	it("interns repeated objects and reuses the same id", () => {
		const leaf = { type: "string" }
		const pool = new InternPool()
		pool.count({ properties: { a: leaf } })
		pool.count({ properties: { b: { type: "string" } } })
		pool.seal()
		const lines = pool.emitConstLines()
		expect(lines.some((l) => l.startsWith("const J0 = "))).toBe(true)
		expect(pool.expr({ type: "string" })).toBe("J0")
		expect(pool.expr({ properties: { a: { type: "string" } } })).toBe('{"properties":{"a":J0}}')
	})

	it("interns repeated long strings and numbers before parent objects", () => {
		const pool = new InternPool()
		pool.count({ maximum: 9007199254740991, pattern: "internal_server_error" })
		pool.count({ maximum: 9007199254740991, pattern: "internal_server_error" })
		pool.seal()
		const lines = pool.emitConstLines()
		expect(lines[0]?.startsWith("const T0 = ") || lines[0]?.startsWith("const U0 = ")).toBe(true)
		const ids = lines.map((l) => l.slice(6, l.indexOf(" =")))
		expect(ids.indexOf("T0")).toBeLessThan(ids.indexOf("J0"))
		expect(ids.indexOf("U0")).toBeLessThan(ids.indexOf("J0"))
	})

	it("force-interns unique roots so callers can share by reference", () => {
		const meta = { auth: "required" }
		const pool = new InternPool()
		pool.count(meta)
		pool.force(meta, "M")
		pool.force("GET /orgs", "P")
		pool.seal()
		expect(pool.expr(meta)).toBe("M0")
		expect(pool.expr("GET /orgs")).toBe("P0")
		expect(pool.emitConstLines()).toEqual(['const P0 = "GET /orgs"', 'const M0 = {"auth":"required"}'])
	})

	it("does not intern empty arrays even when they repeat", () => {
		const pool = new InternPool()
		pool.count([])
		pool.count([])
		pool.seal()
		expect(pool.expr([])).toBe("[]")
		expect(pool.emitConstLines()).toEqual([])
	})

	it("does not intern unique error-key arrays unless they repeat", () => {
		const pool = new InternPool()
		pool.count(["email_taken"])
		pool.seal()
		expect(pool.expr(["email_taken"])).toBe('["email_taken"]')
		pool.count(["forbidden", "unauthorized"])
		pool.count(["forbidden", "unauthorized"])
		const shared = new InternPool()
		shared.count(["forbidden", "unauthorized"])
		shared.count(["forbidden", "unauthorized"])
		shared.seal()
		expect(shared.expr(["forbidden", "unauthorized"])).toBe("A0")
	})

	it("skips booleans, null, undefined, and short unique strings", () => {
		const pool = new InternPool()
		pool.count(true)
		pool.count(null)
		pool.count(undefined)
		pool.count("ab")
		pool.force(null, "I")
		pool.force(undefined, "O")
		pool.seal()
		expect(pool.emitConstLines()).toEqual([])
		expect(pool.expr(null)).toBe("null")
		expect(pool.expr(undefined)).toBe("undefined")
		expect(pool.expr(true)).toBe("true")
		expect(pool.expr(false)).toBe("false")
	})

	it("omits undefined object keys so print matches JSON.stringify identity", () => {
		const pool = new InternPool()
		const obj = { a: 1, b: undefined as unknown }
		pool.force(obj, "M")
		pool.seal()
		expect(pool.emitConstLines()).toEqual(['const M0 = {"a":1}'])
	})

	it("casts forced I/O roots at the const, not at every use", () => {
		const iv = { json: { type: "string" } }
		const os = { "application/json": { ok: { type: "boolean" } } }
		const pool = new InternPool()
		pool.count(iv)
		pool.count(os)
		pool.force(iv, "I")
		pool.force(os, "O")
		pool.seal()
		const lines = pool.emitConstLines()
		expect(lines.some((l) => l.includes('as unknown as RouteHandler["iv"]'))).toBe(true)
		expect(lines.some((l) => l.includes('as unknown as RouteHandler["os"]'))).toBe(true)
		expect(pool.expr(iv)).toBe("I0")
		expect(pool.expr(os)).toBe("O0")
	})

	it("seal is idempotent", () => {
		const pool = new InternPool()
		pool.force("POST /users", "P")
		pool.seal()
		pool.seal()
		expect(pool.expr("POST /users")).toBe("P0")
		expect(pool.emitConstLines()).toHaveLength(1)
	})
})

describe("generateRouteTree intern", () => {
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
		expect(code).toContain("const H0: RouteHandler")
		expect(code).toContain("const H1: RouteHandler")
		expect(code).toContain("new Set(")
		expect(code).toMatch(/const A0 = \[/)
		expect(code).toMatch(/const M0 = \{/)
		expect(code).toContain("[P0]: H0")
		expect(code).toContain("[P1]: H1")

		const { handlers } = await evalTreeModule(code)
		expect(handlers["GET /a"]).not.toBe(handlers["GET /b"])
		expect(handlers["GET /a"].ek).not.toBe(handlers["GET /b"].ek)
		expect(handlers["GET /a"].ek).toEqual(handlers["GET /b"].ek)
		handlers["GET /a"].ek.add("extra")
		expect(handlers["GET /b"].ek.has("extra")).toBe(false)
		expect(handlers["GET /a"].mt).toBe(handlers["GET /b"].mt)
		expect(handlers["GET /a"].fn).toBeNull()
	})

	it("omits JSON Schema from intern even when routes share iv/os", async () => {
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
		expect(code).not.toMatch(/const I\d+ = /)
		expect(code).not.toMatch(/const O\d+ = /)
		expect(code).not.toMatch(/\biv:/)
		expect(code).not.toMatch(/\bos:/)
		expect(code).not.toContain('"additionalProperties"')
		const { handlers } = await evalTreeModule(code)
		expect(handlers["POST /one"].iv).toBeUndefined()
		expect(handlers["POST /two"].os).toBeUndefined()
	})

	it('inlines a unique error-key array so new Set(["email_taken"]) stays greppable', () => {
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
		expect(code).toContain('new Set(["email_taken"])')
	})

	it("emits tree helpers N/S and empty-children E", () => {
		const code = generateRouteTree([
			{
				boundaryErrorKey: null,
				errorKeys: [],
				inputSchemas: null,
				meta: null,
				method: "GET",
				middlewareNames: [],
				outputSchemas: null,
				path: "/users/:id",
			},
		])
		expect(code).toContain("function N(")
		expect(code).toContain("Record<string, RouteHandler>")
		expect(code).toContain('w as TreeNode["w"]')
		expect(code).toContain("function S(")
		expect(code).toContain("const E = Object.create(null)")
		expect(code).toContain("export const tree: TreeNode = N(")
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
		expect(code).toContain("H0")
		expect(code).toContain("H1")
		expect(code).toContain('"path"')
		const { handlers } = await evalTreeModule(code)
		expect(handlers["GET /"]).toBeDefined()
		expect(handlers["GET /files/*path"]).toBeDefined()
	})
})

describe("generateRouteTreeFromApp intern + MetaShape", () => {
	it("meta export reuses the handler mt const", async () => {
		await prepareCodegen()
		const app = honey<{}>()
			.meta<{ tags: string[]; summary: string }>()
			.get("/orgs")
			.meta({ summary: "List orgs", tags: ["orgs"] })
			.handler((c) => c.res.text("ok", "ok"))

		const code = generateRouteTreeFromApp(app)
		expect(code).toMatch(/const M0 = \{/)
		expect(code).toContain("as MetaShape")
		expect(code).toContain("mt: M0")
		expect(code).toMatch(/meta: Record<string, MetaShape> = \{\s*\[P0\]: M0/)
		expect(code).toContain('tags: ["orgs"]')
		expect(code).toContain("& Record<string, unknown>")
		expect(code).not.toContain("unknown[]")
		expect(code).toContain("export type RouteSelector = typeof P0")

		const { handlers, meta, routeTree } = await evalTreeModule(code)
		expect(meta?.["GET /orgs"]).toBe(handlers["GET /orgs"].mt)
		expect(routeTree.meta["GET /orgs"]).toBe(handlers["GET /orgs"].mt)
		expect(handlers["GET /orgs"].mt).toEqual({ summary: "List orgs", tags: ["orgs"] })
	})

	it("live-app intern omits shared input schemas from the isolate tree", async () => {
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
		expect(code).not.toMatch(/const I\d+ = /)
		expect(code).not.toMatch(/\biv:/)
		expect(code).not.toContain('"email"')
		const { handlers } = await evalTreeModule(code)
		expect(handlers["POST /a"].iv).toBeUndefined()
		expect(handlers["POST /b"].iv).toBeUndefined()
	})

	it("preserves pre-built ek greppability for a single route", () => {
		const errors = defineErrors({ email_taken: "conflict" })
		const app = honey<{}>()
			.get("/users")
			.errors(errors, "email_taken")
			.handler((c) => c.res.text("ok", "ok"))
		const code = generateRouteTreeFromApp(app)
		expect(code).toContain('new Set(["email_taken"])')
	})
})
