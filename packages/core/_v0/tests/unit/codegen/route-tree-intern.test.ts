import { describe, expect, it } from "vitest"
import * as z from "zod"
import { generateRouteTree, generateRouteTreeFromApp, prepareCodegen } from "../../../src/codegen.ts"
import { InternPool } from "../../../src/codegen-route-tree-intern.ts"
import { defineErrors, honey } from "../../../src/index.ts"
import type { RouteEntry, RouteTree, TreeNode } from "../../../src/tree.ts"
import { createNode, insertRoute } from "../../../src/tree.ts"

type TreeModule = {
	meta?: Record<string, Record<string, unknown>>
	routeTree: RouteTree
	routes: RouteTree["routes"]
	tree: TreeNode
}

async function evalTreeModule(code: string): Promise<TreeModule> {
	const { transform } = await import("esbuild")
	const { code: js } = await transform(code, {
		format: "esm",
		loader: "ts",
		target: "esnext",
	})
	const dataUrl = `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
	return (await import(dataUrl)) as TreeModule
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
		pool.force(null, "M")
		pool.force(undefined, "P")
		pool.seal()
		expect(pool.emitConstLines()).toEqual([])
		expect(pool.expr(null)).toBe("null")
		expect(pool.expr(undefined)).toBe("undefined")
		expect(pool.expr(true)).toBe("true")
		expect(pool.expr(false)).toBe("false")
	})

	it("prints an own __proto__ key as a computed key so it never sets the prototype", () => {
		const pool = new InternPool()
		const obj = JSON.parse('{"__proto__":{"polluted":true},"a":1}') as Record<string, unknown>
		pool.force(obj, "M")
		pool.seal()
		const [line] = pool.emitConstLines()
		expect(line).toBe('const M0 = {["__proto__"]:{"polluted":true},"a":1}')
		const value = new Function(`${line}; return M0`)() as Record<string, unknown>
		expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
		expect(Object.keys(value)).toEqual(["__proto__", "a"])
	})

	it("omits undefined object keys so print matches JSON.stringify identity", () => {
		const pool = new InternPool()
		const obj = { a: 1, b: undefined as unknown }
		pool.force(obj, "M")
		pool.seal()
		expect(pool.emitConstLines()).toEqual(['const M0 = {"a":1}'])
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

function treeOf(routes: Array<[string, string, RouteEntry?]>): RouteTree {
	const root = createNode()
	const entries: Record<string, RouteEntry> = {}
	for (const [method, path, entry] of routes) entries[insertRoute(root, method as "GET", path)] = entry ?? {}
	return { meta: {}, root, routes: entries }
}

describe("generateRouteTree intern", () => {
	it("shares route data by identity, never handler objects", async () => {
		const shared = { ek: ["internal_server_error", "forbidden"], mt: { worker: "api" } }
		const code = generateRouteTree(
			treeOf([
				["GET", "/a", { bek: "internal_server_error", ...shared }],
				["GET", "/b", { bek: "internal_server_error", ...shared }],
			]),
		)
		expect(code).not.toContain("RouteHandler")
		expect(code).toMatch(/const A0 = \[/)
		expect(code).toMatch(/const M0 = \{/)
		expect(code).toContain("[P0]: { bek: T0, ek: A0, mt: M0 }")
		expect(code).toContain("[P1]: { bek: T0, ek: A0, mt: M0 }")

		const { routes, tree } = await evalTreeModule(code)
		expect(routes["GET /a"]?.mt).toBe(routes["GET /b"]?.mt)
		expect(tree.s.a?.m).toEqual({ GET: "GET /a" })
	})

	it("never emits JSON Schema even when the source tree carries it", async () => {
		const iv = { json: { properties: { id: { type: "string" } }, type: "object" } } as unknown as RouteEntry["iv"]
		const code = generateRouteTree(
			treeOf([
				["POST", "/one", { iv }],
				["POST", "/two", { iv }],
			]),
		)
		expect(code).not.toMatch(/\biv:/)
		expect(code).not.toMatch(/\bos:/)
		expect(code).not.toContain('"properties"')
		const { routes } = await evalTreeModule(code)
		expect(routes["POST /one"]?.iv).toBeUndefined()
	})

	it("inlines a unique error-key array so the key stays greppable", () => {
		const code = generateRouteTree(treeOf([["GET", "/users", { ek: ["email_taken"] }]]))
		expect(code).toContain('ek: ["email_taken"]')
	})

	it("emits null-prototype tree helpers and no shared sentinel", async () => {
		const code = generateRouteTree(
			treeOf([
				["GET", "/users/:id"],
				["GET", "/health"],
			]),
		)
		expect(code).toContain("function N(")
		expect(code).toContain("function S<T>(")
		expect(code).not.toContain("const E =")
		expect(code).toContain("export const tree: TreeNode = N(")
		const { tree } = await evalTreeModule(code)
		expect(Object.getPrototypeOf(tree.s)).toBeNull()
		const health = tree.s.health
		const id = tree.s.users?.d?.c
		expect(health?.s).not.toBe(id?.s)
	})

	it("wildcard, root and prototype-named segments compile", async () => {
		const code = generateRouteTree(
			treeOf([
				["GET", "/"],
				["GET", "/files/*path"],
				["GET", "/constructor/toString"],
				["GET", "/__proto__/hasOwnProperty"],
			]),
		)
		const { routes, tree } = await evalTreeModule(code)
		expect(routes["GET /"]).toBeDefined()
		expect(routes["GET /files/*path"]).toBeDefined()
		expect(tree.s.files?.w?.n).toBe("path")
		expect(tree.s.constructor?.s.toString?.m).toEqual({ GET: "GET /constructor/toString" })
		expect(Object.keys(tree.s)).toContain("__proto__")
		expect(Object.getPrototypeOf(tree.s)).toBeNull()
	})
})

describe("generateRouteTreeFromApp intern + MetaShape", () => {
	it("meta export reuses the route mt const", async () => {
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
		expect(code).toMatch(/meta: Record<string, MetaShape> = S\(\{\s*\[P0\]: M0/)
		expect(code).toContain('tags: ["orgs"]')
		expect(code).toContain("& Record<string, unknown>")
		expect(code).not.toContain("unknown[]")
		expect(code).toContain("export type RouteSelector = typeof P0")

		const { meta, routeTree, routes } = await evalTreeModule(code)
		expect(meta?.["GET /orgs"]).toBe(routes["GET /orgs"]?.mt)
		expect(routeTree.meta["GET /orgs"]).toBe(routes["GET /orgs"]?.mt)
		expect(routes["GET /orgs"]?.mt).toEqual({ summary: "List orgs", tags: ["orgs"] })
	})

	it("live-app tree omits input schemas", async () => {
		await prepareCodegen()
		const app = honey<{}>()
		const body = z.object({ email: z.string().email(), name: z.string() })
		app
			.post("/a")
			.input({ json: body })
			.handler((c) => c.res.text("ok", "ok"))
		const code = generateRouteTreeFromApp(app)
		expect(code).not.toMatch(/\biv:/)
		expect(code).not.toContain('"email"')
	})

	it("preserves error-key greppability for a single route", () => {
		const errors = defineErrors({ email_taken: "conflict" })
		const app = honey<{}>()
			.get("/users")
			.errors(errors, "email_taken")
			.handler((c) => c.res.text("ok", "ok"))
		const code = generateRouteTreeFromApp(app)
		expect(code).toContain('ek: ["email_taken"]')
	})
})

describe("route-tree emission cost", () => {
	it("keys each value once: deep and wide meta stays linear", () => {
		/* a 1500-level chain: re-serializing per level would build over a million characters of keys */
		let deep: Record<string, unknown> = { leaf: "end-of-chain" }
		for (let i = 0; i < 1500; i++) deep = { [`k${i % 7}`]: deep }
		const pool = new InternPool()
		const t0 = performance.now()
		for (let i = 0; i < 3; i++) pool.count(deep)
		pool.seal()
		expect(pool.id(deep)).toBeDefined()
		expect(performance.now() - t0).toBeLessThan(500)
	})

	it("equal JSON shares one const, whatever the object identity", () => {
		const pool = new InternPool()
		pool.count({ a: [1, { b: "xxxxxxxxxx" }] })
		pool.count({ a: [1, { b: "xxxxxxxxxx" }] })
		pool.count({ a: [1, { b: "yyyyyyyyyy" }] })
		pool.seal()
		expect(pool.id({ a: [1, { b: "xxxxxxxxxx" }] })).toBeDefined()
		expect(pool.id({ a: [1, { b: "yyyyyyyyyy" }] })).toBeUndefined()
		/* an undefined property is not part of the value, as in JSON */
		expect(pool.id({ a: [1, { b: "xxxxxxxxxx" }], c: undefined })).toBe(pool.id({ a: [1, { b: "xxxxxxxxxx" }] }))
	})

	it("never converts a schema to JSON Schema", async () => {
		const { getJsonSchemaConverter, setJsonSchemaConverter } = await import("../../../src/openapi/json-schema-slot.ts")
		const prev = getJsonSchemaConverter()
		let calls = 0
		setJsonSchemaConverter(() => {
			calls++
			return {}
		})
		try {
			const app = honey()
			app
				.post("/users")
				.input({ json: z.object({ name: z.string() }) })
				.handler((c) => c.res.json("ok", c.input.json))
			generateRouteTreeFromApp(app)
		} finally {
			setJsonSchemaConverter(prev)
		}
		expect(calls).toBe(0)
	})
})
