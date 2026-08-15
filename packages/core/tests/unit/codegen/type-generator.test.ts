import { describe, expect, it } from "vitest"
import * as z from "zod"
import { generateTypes } from "../../../src/codegen.ts"
import { createMiddleware, defineErrors, honey } from "../../../src/index.ts"

describe("generateTypes", () => {
	it("generates empty routes map for app with no routes", () => {
		const app = honey()
		const result = generateTypes(app, {})
		expect(result).toContain("export type Routes = {")
		expect(result).toContain("}")
		expect(result).not.toContain("ctx: BaseCtx")
	})

	it("generates route context for simple GET route", () => {
		const app = honey()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "ok"))
		const result = generateTypes(app, {})
		expect(result).toContain('"/health"')
		expect(result).toContain("get:")
		expect(result).toContain("ctx: BaseCtx")
	})

	it("generates input types from zod schemas", () => {
		const app = honey()
			.get("/search")
			.input({ search: z.object({ limit: z.number(), q: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", { q: ctx.input.search.q }))
		const result = generateTypes(app, {})
		expect(result).toContain("search: { limit: number; q: string }")
	})

	it("emits optional markers for ZodOptional object properties", () => {
		const app = honey()
			.post("/users")
			.input({
				json: z.object({
					email: z.string(),
					name: z.string().optional(),
					bio: z.string().nullable().optional(),
				}),
			})
			.handler((ctx) => ctx.res.json("created", {}))
		const result = generateTypes(app, {})
		expect(result).toContain("email: string")
		expect(result).toContain("name?: string | undefined")
		expect(result).toContain("bio?: string | null | undefined")
		expect(result).not.toContain("email?")
	})

	it("generates typed params from path", () => {
		const app = honey()
			.get("/users/:userId/posts/:postId")
			.handler((ctx) => ctx.res.text("ok", ctx.params.userId))
		const result = generateTypes(app, {})
		expect(result).toContain("readonly params: { userId: string; postId: string }")
	})

	it("generates output types", () => {
		const app = honey()
			.get("/users")
			.output({
				"application/json": {
					ok: z.object({ id: z.string(), name: z.string() }),
				},
			})
			.handler((ctx) => ctx.res.json("ok", { id: "1", name: "test" }))
		const result = generateTypes(app, {})
		expect(result).toContain('"application/json"')
		expect(result).toContain("ok: { id: string; name: string }")
	})

	it("handles multiple methods on same path", () => {
		const app = honey()
			.get("/users")
			.handler((ctx) => ctx.res.json("ok", []))
			.post("/users")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("created", { name: ctx.input.json.name }))
		const result = generateTypes(app, {})
		expect(result).toContain("get:")
		expect(result).toContain("post:")
	})

	it("does not generate convenience aliases", () => {
		const app = honey()
			.get("/users/:userId")
			.handler((ctx) => ctx.res.text("ok", ctx.params.userId))
		const result = generateTypes(app, {})
		expect(result).not.toContain("export type UsersUserIdGetCtx")
	})

	it("generates standalone BaseCtx with default env type", () => {
		const app = honey()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "ok"))
		const result = generateTypes(app, {})
		expect(result).toContain('import type { HoneyContext } from "@ecomet/honey"')
		expect(result).toContain("export type BaseCtx = HoneyContext<Record<string, unknown>>")
		expect(result).not.toContain("InferCtx")
	})

	it("custom base context name", () => {
		const app = honey()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "ok"))
		const result = generateTypes(app, {
			baseCtxName: "AppCtx",
		})
		expect(result).toContain("export type AppCtx = HoneyContext<Record<string, unknown>>")
		expect(result).toContain("ctx: AppCtx")
	})

	it("inlineEnvType and inlineMiddlewareType produces inline BaseCtx", () => {
		const app = honey()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "ok"))
		const result = generateTypes(app, {
			inlineEnvType: "{ DB: D1Database; KV: KVNamespace }",
			inlineMiddlewareType: "{ user: { id: string; role: string } }",
		})
		expect(result).toContain('import type { HoneyContext } from "@ecomet/honey"')
		expect(result).toContain(
			"export type BaseCtx = HoneyContext<{ DB: D1Database; KV: KVNamespace }> & { user: { id: string; role: string } }",
		)
		expect(result).not.toContain("_App")
	})

	it("no middleware falls back to inline env type", () => {
		const app = honey()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "ok"))
		const result = generateTypes(app, {
			inlineEnvType: "{ DB: D1Database }",
		})
		expect(result).toContain("export type BaseCtx = HoneyContext<{ DB: D1Database }>")
		expect(result).not.toContain("_App")
	})

	it("route with no input has empty input type", () => {
		const app = honey()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "ok"))
		const result = generateTypes(app, {})
		expect(result).toContain("input: {}")
	})

	it("route with no output has empty output type", () => {
		const app = honey()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "ok"))
		const result = generateTypes(app, {})
		expect(result).toContain("output: {}")
	})

	it("generates error type for route with .errors()", () => {
		const errs = defineErrors({
			email_taken: "conflict",
			not_authorized: "unauthorized",
		})

		const app = honey()
			.get("/users")
			.errors(errs, "email_taken", "not_authorized")
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const result = generateTypes(app, {})
		expect(result).toContain('errors: "email_taken" | "not_authorized"')
	})

	it("generates never error type for route without .errors()", () => {
		const app = honey()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const result = generateTypes(app, {})
		expect(result).toContain("errors: never")
	})

	it("generates route utility types (RouteCtx, RouteInput, RouteOutput, RouteErrors, RouteMeta)", () => {
		const app = honey()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "ok"))
		const result = generateTypes(app, {})
		expect(result).toContain("export type RouteCtx<")
		expect(result).toContain("export type RouteInput<")
		expect(result).toContain("export type RouteOutput<")
		expect(result).toContain("export type RouteErrors<")
		expect(result).toContain("export type RouteMeta<")
		expect(result).toContain("TPath extends keyof Routes")
		expect(result).toContain("TMethod extends keyof Routes[TPath] & string")
		expect(result).toContain("Routes[TPath][TMethod] extends { ctx: infer C } ? C : never")
	})

	it("utility types present even with no routes", () => {
		const app = honey()
		const result = generateTypes(app, {})
		expect(result).toContain("export type RouteCtx<")
		expect(result).toContain("export type RouteInput<")
	})

	it("full app generates valid structure", () => {
		const app = honey()
			.get("/")
			.handler((ctx) => ctx.res.text("ok", "ok"))
			.get("/users")
			.input({ search: z.object({ page: z.number() }) })
			.output({
				"application/json": { ok: z.object({ items: z.string().array() }) },
			})
			.handler((ctx) => ctx.res.json("ok", { items: [] }))
			.post("/users")
			.input({ json: z.object({ email: z.string(), name: z.string() }) })
			.handler((ctx) => ctx.res.json("created", {}))
			.get("/users/:id")
			.handler((ctx) => ctx.res.text("ok", ctx.params.id))
			.delete("/users/:id")
			.handler((ctx) => ctx.res.noContent())

		const result = generateTypes(app, {})

		expect(result).toContain('"/"')
		expect(result).toContain('"/users"')
		expect(result).toContain('"/users/:id"')
		expect(result).not.toContain("export type RootGetCtx")
	})

	describe("sub-chain middleware (routeMiddleware)", () => {
		it("adds per-route middleware additions to ctx type", () => {
			const app = honey()
				.get("/public")
				.handler((ctx) => ctx.res.text("ok", "ok"))
				.get("/private")
				.handler((ctx) => ctx.res.text("ok", "ok"))

			const result = generateTypes(app, {
				routeMiddleware: {
					"get /private": "{ auth: { sub: string } }",
				},
			})

			expect(result).toContain("ctx: BaseCtx & { auth: { sub: string } }")
			/* /public route should NOT have auth additions */
			const lines = result.split("\n")
			const publicBlock = lines
				.slice(
					lines.findIndex((l) => l.includes('"/public"')),
					lines.findIndex((l) => l.includes('"/private"')),
				)
				.join("\n")
			expect(publicBlock).toContain("ctx: BaseCtx")
			expect(publicBlock).not.toContain("auth")
		})

		it("combines routeMiddleware with input and errors", () => {
			const errs = defineErrors({ forbidden: "forbidden" })
			const app = honey()
				.post("/admin/action")
				.input({ json: z.object({ action: z.string() }) })
				.errors(errs, "forbidden")
				.handler((ctx) => ctx.res.json("ok", {}))

			const result = generateTypes(app, {
				routeMiddleware: {
					"post /admin/action": "{ auth: { sub: string; role: string } }",
				},
			})

			expect(result).toContain("BaseCtx & { auth: { sub: string; role: string } } & {")
			expect(result).toContain("input: { json: { action: string } }")
		})

		it("leaves routes without routeMiddleware entry unchanged", () => {
			const app = honey()
				.get("/health")
				.handler((ctx) => ctx.res.text("ok", "ok"))

			const result = generateTypes(app, {
				routeMiddleware: {
					"get /other": "{ auth: string }",
				},
			})

			expect(result).toContain("ctx: BaseCtx")
			expect(result).not.toContain("auth")
		})

		it("handles multiple chains with different additions", () => {
			const app = honey()
				.get("/public")
				.handler((ctx) => ctx.res.text("ok", "ok"))
				.get("/user-area")
				.handler((ctx) => ctx.res.text("ok", "ok"))
				.get("/admin-area")
				.handler((ctx) => ctx.res.text("ok", "ok"))

			const result = generateTypes(app, {
				routeMiddleware: {
					"get /user-area": "{ auth: { sub: string } }",
					"get /admin-area": "{ auth: { sub: string }; admin: { level: number } }",
				},
			})

			expect(result).toContain("ctx: BaseCtx & { auth: { sub: string } }")
			expect(result).toContain("ctx: BaseCtx & { auth: { sub: string }; admin: { level: number } }")
		})
	})
})
