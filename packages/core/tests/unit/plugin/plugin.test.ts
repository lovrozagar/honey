import { describe, expect, it } from "vitest"
import * as z from "zod"
import { generateRouteTree } from "../../../src/codegen.ts"
import { honey } from "../../../src/index.ts"
import type { RouteEntry, RouteTree } from "../../../src/tree.ts"
import { createNode, insertRoute } from "../../../src/tree.ts"
import { generateFromApp } from "../../../src/plugin.ts"

function treeOf(routes: Array<[string, string, RouteEntry?]>): RouteTree {
	const root = createNode()
	const entries: Record<string, RouteEntry> = {}
	for (const [method, path, entry] of routes) entries[insertRoute(root, method as "GET", path)] = entry ?? {}
	return { meta: {}, root, routes: entries }
}

describe("generateRouteTree", () => {
	it("generates route tree code from a tree", () => {
		const code = generateRouteTree(
			treeOf([
				["GET", "/health"],
				["GET", "/v1/organizations/:orgId"],
				["POST", "/v1/organizations", { ek: ["org_slug_taken"] }],
			]),
		)
		expect(code).toContain("TreeNode")
		expect(code).toContain("health")
		expect(code).toContain("organizations")
		expect(code).toContain('ek: ["org_slug_taken"]')
	})

	it("emits null-prototype factory", () => {
		const code = generateRouteTree(treeOf([["GET", "/health"]]))
		expect(code).toContain("Object.create(null)")
	})

	it("emits fresh children per node — no shared empty-node sentinel", () => {
		const code = generateRouteTree(treeOf([["GET", "/a/b/c"]]))
		expect(code).not.toContain("const E")
		expect(code).toContain("s: Record<string, TreeNode> = S({})")
	})

	it("websocket leaves are part of the topology", () => {
		const app = honey<{}>()
		app.ws("/live").handler({})
		app.get("/health").handler((c) => c.res.text("ok", "ok"))
		const code = generateRouteTree(app.toRouteTree())
		expect(code).toContain('"WS /live"')
	})
})

describe("generateFromApp", () => {
	it("generates route tree from Honey instance", async () => {
		const h = honey<{}>()
		h.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		h.post("/users").handler((ctx) => ctx.res.text("ok", "ok"))

		const artifacts = await generateFromApp(h)
		expect(artifacts.routeTree).toContain("TreeNode")
		expect(artifacts.routeTree).toContain("health")
		expect(artifacts.routeTree).toContain("users")
	})

	it("captures error keys from routes", async () => {
		const h = honey<{}>()
		const errors = {
			email_taken: () => new Error("taken"),
		}
		h.post("/test")
			.errors(errors, "email_taken")
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const artifacts = await generateFromApp(h)
		expect(artifacts.routeTree).toContain("email_taken")
	})

	it("generates manifest when option provided", async () => {
		const h = honey<{}>()
		h.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		const artifacts = await generateFromApp(h, {
			manifest: { output: "manifest.gen.json" },
		})
		expect(artifacts.manifest).toBeDefined()
		const parsed = JSON.parse(artifacts.manifest ?? "{}") as Record<string, unknown>
		expect(parsed.routes).toBeDefined()
		expect(parsed.errors).toBeDefined()
	})

	it("generates openApi when option provided", async () => {
		const h = honey<{}>()
		h.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		h.post("/items")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const artifacts = await generateFromApp(h, {
			openApi: {
				info: { title: "Test API", version: "1.0" },
				output: "openapi.gen.json",
			},
		})
		expect(artifacts.openApi).toBeDefined()
		const parsed = JSON.parse(artifacts.openApi ?? "{}") as Record<string, unknown>
		expect(parsed.openapi).toBe("3.1.0")
		expect(parsed.paths).toBeDefined()
	})

	it("no manifest/openApi without options", async () => {
		const h = honey<{}>()
		h.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const artifacts = await generateFromApp(h)
		expect(artifacts.manifest).toBeUndefined()
		expect(artifacts.openApi).toBeUndefined()
	})

	it("handles parameterized routes", async () => {
		const h = honey<{}>()
		h.get("/users/:userId/posts/:postId").handler((ctx) => ctx.res.text("ok", "ok"))

		const artifacts = await generateFromApp(h)
		expect(artifacts.routeTree).toContain("userId")
	})
})
