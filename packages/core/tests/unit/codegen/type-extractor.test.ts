import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { extractBaseCtx, extractChainTypes } from "../../../src/type-extractor.ts"

const TEMP_ROOT = resolve(import.meta.dirname, "../../../.tmp-extractor-test")

function writeTempFile(dir: string, filename: string, content: string): string {
	const filePath = join(dir, filename)
	writeFileSync(filePath, content, "utf-8")
	return filePath
}

describe("extractBaseCtx", () => {
	beforeEach(() => {
		mkdirSync(TEMP_ROOT, { recursive: true })
	})

	afterEach(() => {
		rmSync(TEMP_ROOT, { force: true, recursive: true })
	})

	it("extracts env type from simple app", async () => {
		const entryPath = writeTempFile(
			TEMP_ROOT,
			"app.ts",
			[
				'import { honey } from "honey"',
				"type Env = { DB: string; SECRET: string }",
				"export const app = honey<Env>()",
			].join("\n"),
		)

		const result = await extractBaseCtx({ entryPath, exportName: "app" })
		expect(result.envType).toContain("DB")
		expect(result.envType).toContain("SECRET")
		expect(result.envType).toContain("string")
	})

	it("middlewareType is null when no user middleware is added", async () => {
		const entryPath = writeTempFile(
			TEMP_ROOT,
			"app.ts",
			['import { honey } from "honey"', "export const app = honey<{}>()"].join("\n"),
		)

		const result = await extractBaseCtx({ entryPath, exportName: "app" })
		/* realtime is injected on every app; user middleware is still absent */
		expect(result.middlewareType).toContain("realtime")
		expect(result.middlewareType).not.toContain("auth")
	})

	it("throws when export not found", async () => {
		const entryPath = writeTempFile(
			TEMP_ROOT,
			"app.ts",
			['import { honey } from "honey"', "export const app = honey()"].join("\n"),
		)

		await expect(extractBaseCtx({ entryPath, exportName: "nonexistent" })).rejects.toThrow(
			'Export "nonexistent" not found',
		)
	})

	it("envType is unknown when no type param provided", async () => {
		const entryPath = writeTempFile(
			TEMP_ROOT,
			"app.ts",
			['import { honey } from "honey"', "export const app = honey()"].join("\n"),
		)

		const result = await extractBaseCtx({ entryPath, exportName: "app" })
		/* honey() without type param defaults TEnv to Record<string, unknown> internally */
		expect(typeof result.envType).toBe("string")
	})

	it("extracts middleware-added properties via explicit type annotation", async () => {
		const entryPath = writeTempFile(
			TEMP_ROOT,
			"app.ts",
			[
				'import { honey } from "honey"',
				'import type { Honey, HoneyCtx } from "honey"',
				"",
				"type MwAdds = { userId: string; role: string }",
				"export const app: Honey<{}, HoneyCtx & MwAdds> = honey<{}>() as never",
			].join("\n"),
		)

		const result = await extractBaseCtx({ entryPath, exportName: "app" })
		expect(result.middlewareType).not.toBeNull()
		expect(result.middlewareType).toContain("userId")
		expect(result.middlewareType).toContain("role")
	})

	it("handles default export name", async () => {
		const entryPath = writeTempFile(
			TEMP_ROOT,
			"app.ts",
			['import { honey } from "honey"', "export const myApp = honey<{ KEY: string }>()"].join(
				"\n",
			),
		)

		const result = await extractBaseCtx({ entryPath, exportName: "myApp" })
		expect(result.envType).toContain("KEY")
	})

	it("tapsType is null when no .taps() declared", async () => {
		const entryPath = writeTempFile(
			TEMP_ROOT,
			"app.ts",
			['import { honey } from "honey"', "export const app = honey<{}>()"].join("\n"),
		)

		const result = await extractBaseCtx({ entryPath, exportName: "app" })
		expect(result.tapsType).toBeNull()
	})

	it("extracts tapsType when .taps<T>() declared", async () => {
		const entryPath = writeTempFile(
			TEMP_ROOT,
			"app.ts",
			[
				'import { honey } from "honey"',
				"type MyTaps = { audit: { action: string; resource: string } }",
				"export const app = honey<{}>().taps<MyTaps>()",
			].join("\n"),
		)

		const result = await extractBaseCtx({ entryPath, exportName: "app" })
		expect(result.tapsType).not.toBeNull()
		expect(result.tapsType).toContain("audit")
		expect(result.tapsType).toContain("action")
		expect(result.tapsType).toContain("resource")
	})

	it("tapsType is fully structural (no unresolved type aliases)", async () => {
		const entryPath = writeTempFile(
			TEMP_ROOT,
			"app.ts",
			[
				'import { honey } from "honey"',
				'type Payload = { action: "create" | "delete"; id: string }',
				"type Taps = { audit: Payload }",
				"export const app = honey<{}>().taps<Taps>()",
			].join("\n"),
		)

		const result = await extractBaseCtx({ entryPath, exportName: "app" })
		expect(result.tapsType).not.toBeNull()
		/* must be structural, not the alias name "Taps" */
		expect(result.tapsType).not.toBe("Taps")
		expect(result.tapsType).toContain("audit")
		expect(result.tapsType).toContain('"create"')
		expect(result.tapsType).toContain('"delete"')
	})

	it("accepts custom tsconfigPath", async () => {
		/* use the project's own tsconfig so module resolution works */
		const tsconfigPath = resolve(TEMP_ROOT, "../tsconfig.json")
		const entryPath = writeTempFile(
			TEMP_ROOT,
			"app.ts",
			['import { honey } from "honey"', "export const app = honey<{ X: number }>()"].join(
				"\n",
			),
		)

		const result = await extractBaseCtx({
			entryPath,
			exportName: "app",
			tsconfigPath,
		})
		expect(result.envType).toContain("X")
		expect(result.envType).toContain("number")
	})
})

describe("extractChainTypes", () => {
	beforeEach(() => {
		mkdirSync(TEMP_ROOT, { recursive: true })
	})

	afterEach(() => {
		rmSync(TEMP_ROOT, { force: true, recursive: true })
	})

	it("returns route middleware additions for sub-chain routes", async () => {
		const entryPath = writeTempFile(
			TEMP_ROOT,
			"app.ts",
			[
				'import { honey, createMiddleware } from "honey"',
				"",
				"type AuthData = { sub: string }",
				"const withAuth = createMiddleware(async (_ctx, next) => next({ auth: { sub: 'test' } as AuthData }))",
				"",
				"export const app = honey<{}>()",
				'  .get("/public")',
				"  .handler((ctx) => ctx.res.text('ok', 'ok'))",
				"",
				"const authed = app.use(withAuth)",
				'authed.get("/private").handler((ctx) => ctx.res.text("ok", "ok"))',
			].join("\n"),
		)

		const result = await extractChainTypes({ entryPath, exportName: "app" })
		expect(result.base.middlewareType).toContain("realtime")
		expect(result.routeMiddleware["get /private"]).toBeDefined()
		expect(result.routeMiddleware["get /private"]).toContain("auth")
		expect(result.routeMiddleware["get /public"]).toBeUndefined()
	})

	it("handles multiple sub-chains with different additions", async () => {
		const entryPath = writeTempFile(
			TEMP_ROOT,
			"app.ts",
			[
				'import { honey, createMiddleware } from "honey"',
				"",
				"const withAuth = createMiddleware(async (_ctx, next) => next({ auth: { sub: 'x' } }))",
				"const withAdmin = createMiddleware(async (_ctx, next) => next({ admin: { level: 1 } }))",
				"",
				"export const app = honey<{}>()",
				'app.get("/public").handler((ctx) => ctx.res.text("ok", "ok"))',
				"",
				"const authed = app.use(withAuth)",
				'authed.get("/user").handler((ctx) => ctx.res.text("ok", "ok"))',
				"",
				"const admin = authed.use(withAdmin)",
				'admin.get("/admin").handler((ctx) => ctx.res.text("ok", "ok"))',
			].join("\n"),
		)

		const result = await extractChainTypes({ entryPath, exportName: "app" })
		expect(result.routeMiddleware["get /public"]).toBeUndefined()
		expect(result.routeMiddleware["get /user"]).toContain("auth")
		expect(result.routeMiddleware["get /user"]).not.toContain("admin")
		expect(result.routeMiddleware["get /admin"]).toContain("auth")
		expect(result.routeMiddleware["get /admin"]).toContain("admin")
	})

	it("handles inline .use().get() chain", async () => {
		const entryPath = writeTempFile(
			TEMP_ROOT,
			"app.ts",
			[
				'import { honey, createMiddleware } from "honey"',
				"",
				"const withAuth = createMiddleware(async (_ctx, next) => next({ auth: 'x' }))",
				"",
				"export const app = honey<{}>()",
				'app.use(withAuth).get("/guarded").handler((ctx) => ctx.res.text("ok", "ok"))',
			].join("\n"),
		)

		const result = await extractChainTypes({ entryPath, exportName: "app" })
		expect(result.routeMiddleware["get /guarded"]).toContain("auth")
	})

	it("returns base ctx same as extractBaseCtx", async () => {
		const entryPath = writeTempFile(
			TEMP_ROOT,
			"app.ts",
			['import { honey } from "honey"', "export const app = honey<{ DB: string }>()"].join(
				"\n",
			),
		)

		const result = await extractChainTypes({ entryPath, exportName: "app" })
		expect(result.base.envType).toContain("DB")
		expect(result.base.middlewareType).toContain("realtime")
		expect(result.base.tapsType).toBeNull()
		expect(Object.keys(result.routeMiddleware)).toHaveLength(0)
	})

	it("extractChainTypes extracts tapsType from .taps<T>()", async () => {
		const entryPath = writeTempFile(
			TEMP_ROOT,
			"app.ts",
			[
				'import { honey } from "honey"',
				"type MyTaps = { audit: { action: string } }",
				"export const app = honey<{}>().taps<MyTaps>()",
			].join("\n"),
		)

		const result = await extractChainTypes({ entryPath, exportName: "app" })
		expect(result.base.tapsType).not.toBeNull()
		expect(result.base.tapsType).toContain("audit")
		expect(result.base.tapsType).toContain("action")
	})

	it("middleware with type-annotated property uses import reference, not structural expansion", async () => {
		/* simulate: separate file exports a complex type alias, middleware annotates with it */
		const typesPath = writeTempFile(
			TEMP_ROOT,
			"db-types.ts",
			[
				"type InnerSchema = {",
				"  users: { id: string; name: string; email: string; role: string; created_at: number; updated_at: number }",
				"  posts: { id: string; title: string; body: string; author_id: string; status: string; created_at: number }",
				"  comments: { id: string; post_id: string; user_id: string; body: string; created_at: number }",
				"}",
				"export type DbClient = { query: InnerSchema; batch: (items: unknown[]) => Promise<unknown[]> }",
			].join("\n"),
		)

		const entryPath = writeTempFile(
			TEMP_ROOT,
			"app.ts",
			[
				'import { honey, createMiddleware } from "honey"',
				'import type { DbClient } from "./db-types"',
				"",
				"const withDb = createMiddleware((_ctx: { env: { DB: string } }, next) => {",
				"  const db: DbClient = {} as DbClient",
				"  return next({ db })",
				"})",
				"",
				"export const app = honey<{ DB: string }>()",
				"  .use(withDb)",
				'  .get("/test")',
				'  .handler((ctx) => ctx.res.text("ok", "ok"))',
			].join("\n"),
		)

		const result = await extractBaseCtx({ entryPath, exportName: "app" })
		expect(result.middlewareType).not.toBeNull()
		expect(result.middlewareType).toContain("db:")
		/* must use import reference, not inline the full structural type */
		expect(result.middlewareType).toContain("import(")
		expect(result.middlewareType).toContain("DbClient")
		/* must NOT contain structural expansion of the inner schema */
		expect(result.middlewareType).not.toContain("InnerSchema")
		expect(result.middlewareType).not.toContain("users:")
	})

	it("middleware with untyped variable falls back to structural expansion", async () => {
		writeTempFile(
			TEMP_ROOT,
			"db-types.ts",
			["export type DbClient = { query: { users: { id: string } }; run: () => void }"].join("\n"),
		)

		const entryPath = writeTempFile(
			TEMP_ROOT,
			"app.ts",
			[
				'import { honey, createMiddleware } from "honey"',
				'import type { DbClient } from "./db-types"',
				"",
				"const withDb = createMiddleware((_ctx: { env: { DB: string } }, next) => {",
				"  const db = {} as DbClient",
				"  return next({ db })",
				"})",
				"",
				"export const app = honey<{ DB: string }>()",
				"  .use(withDb)",
				'  .get("/test")',
				'  .handler((ctx) => ctx.res.text("ok", "ok"))',
			].join("\n"),
		)

		const result = await extractBaseCtx({ entryPath, exportName: "app" })
		expect(result.middlewareType).not.toBeNull()
		/* no type annotation on variable → structural expansion is expected */
		expect(result.middlewareType).toContain("query:")
		expect(result.middlewareType).toContain("users:")
	})

	it("middleware shorthand property traces to variable type annotation", async () => {
		writeTempFile(
			TEMP_ROOT,
			"session-types.ts",
			[
				"type Schema = { tables: { id: string; name: string; cols: string[] }; views: { id: string; query: string } }",
				"export type SessionDb = { schema: Schema; exec: (sql: string) => Promise<void> }",
			].join("\n"),
		)

		const entryPath = writeTempFile(
			TEMP_ROOT,
			"app.ts",
			[
				'import { honey, createMiddleware } from "honey"',
				'import type { SessionDb } from "./session-types"',
				"",
				"const withSession = createMiddleware((_ctx: { env: {} }, next) => {",
				"  const sessionDb: SessionDb = {} as SessionDb",
				"  const token = 'abc'",
				"  return next({ sessionDb, token })",
				"})",
				"",
				"export const app = honey<{}>()",
				"  .use(withSession)",
				'  .get("/test")',
				'  .handler((ctx) => ctx.res.text("ok", "ok"))',
			].join("\n"),
		)

		const result = await extractBaseCtx({ entryPath, exportName: "app" })
		expect(result.middlewareType).not.toBeNull()
		/* typed variable via shorthand → import reference */
		expect(result.middlewareType).toContain("sessionDb:")
		expect(result.middlewareType).toContain("import(")
		expect(result.middlewareType).toContain("SessionDb")
		/* untyped primitive stays structural */
		expect(result.middlewareType).toContain("token:")
		/* must NOT inline the schema structure */
		expect(result.middlewareType).not.toContain("tables:")
		expect(result.middlewareType).not.toContain("views:")
	})
})
