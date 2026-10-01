import { describe, expect, it } from "vitest"
import * as z from "zod"
import { generateRouteTree } from "../../../src/codegen.ts"
import { honey } from "../../../src/index.ts"
import { generateFromApp } from "../../../src/plugin.ts"

describe("generateRouteTree", () => {
	it("generates route tree code from routes config", () => {
		const code = generateRouteTree([
			{
				boundaryErrorKey: null,
				errorKeys: [],
				inputSchemas: null,
				meta: null,
				method: "GET",
				middlewareNames: [],
				outputSchemas: null,
				path: "/health",
			},
			{
				boundaryErrorKey: null,
				errorKeys: [],
				inputSchemas: null,
				meta: null,
				method: "GET",
				middlewareNames: [],
				outputSchemas: null,
				path: "/v1/organizations/:orgId",
			},
			{
				boundaryErrorKey: null,
				errorKeys: ["org_slug_taken"],
				inputSchemas: null,
				meta: null,
				method: "POST",
				middlewareNames: ["withDb", "withAuth"],
				outputSchemas: null,
				path: "/v1/organizations",
			},
		])

		expect(code).toContain("TreeNode")
		expect(code).toContain("health")
		expect(code).toContain("organizations")
	})

	it("emits null-prototype factory", () => {
		const code = generateRouteTree([
			{
				boundaryErrorKey: null,
				errorKeys: [],
				inputSchemas: null,
				meta: null,
				method: "GET",
				middlewareNames: [],
				outputSchemas: null,
				path: "/health",
			},
		])
		expect(code).toContain("Object.create(null)")
	})

	it("emits empty node constant E", () => {
		const code = generateRouteTree([
			{
				boundaryErrorKey: null,
				errorKeys: [],
				inputSchemas: null,
				meta: null,
				method: "GET",
				middlewareNames: [],
				outputSchemas: null,
				path: "/a/b/c",
			},
		])
		expect(code).toContain("const E")
	})

	it("deduplicates handler configs", () => {
		const code = generateRouteTree([
			{
				boundaryErrorKey: null,
				errorKeys: [],
				inputSchemas: null,
				meta: null,
				method: "GET",
				middlewareNames: [],
				outputSchemas: null,
				path: "/a",
			},
			{
				boundaryErrorKey: null,
				errorKeys: [],
				inputSchemas: null,
				meta: null,
				method: "GET",
				middlewareNames: [],
				outputSchemas: null,
				path: "/b",
			},
		])
		/* both routes have same mw/errors → should share handler pattern */
		expect(code).toContain("H0")
	})

	it("generated tree includes ws: null on nodes", () => {
		const code = generateRouteTree([
			{
				boundaryErrorKey: null,
				errorKeys: [],
				inputSchemas: null,
				meta: null,
				method: "GET",
				middlewareNames: [],
				outputSchemas: null,
				path: "/health",
			},
		])
		expect(code).toContain("ws: null")
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
