import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { extract, type FixtureProject, fixtureProject, lines, SLOW, shown } from "./__fixtures__/project.ts"

let project: FixtureProject
beforeAll(() => {
	project = fixtureProject()
})
afterAll(() => project.dispose())

const extracted = (entryPath: string) => extract(entryPath, { routeId: (method, path) => `${method} ${path}` }).types

describe("the chain: intersections, optionality and a context without the framework's class", () => {
	it(
		"a prop two middleware add is their intersection; an optional one stays optional",
		() => {
			const entryPath = project.write(
				"chain/narrow.ts",
				lines(
					'import { createMiddleware, honey } from "@lovrozagar/honey"',
					"const loose = createMiddleware((_c, next) => next({ who: 'x' as string | null }))",
					"const strict = createMiddleware((_c, next) => next({ who: 'x' }))",
					"const maybe = createMiddleware((_c, next) => next({} as { hint?: number }))",
					"export const app = honey<{}>()",
					'app.use(loose).use(strict).use(maybe).get("/x").handler((c) => c.res.text("ok", "ok"))',
				),
			)
			expect(extracted(entryPath).routes).toEqual({
				"GET /x": [
					{ name: "who", optional: false, type: "string" },
					{ name: "hint", optional: true, type: "number" },
				],
			})
		},
		SLOW,
	)

	it(
		"a context typed without the framework's class owns nothing: every prop is added",
		() => {
			const entryPath = project.write(
				"chain/custom.ts",
				lines(
					'import { honey, type Honey } from "@lovrozagar/honey"',
					"export const app: Honey<{}, { res: number; custom: string }> = honey<{}>() as never",
				),
			)
			expect(extracted(entryPath).middleware).toEqual([
				{ name: "res", optional: false, type: "number" },
				{ name: "custom", optional: false, type: "string" },
			])
		},
		SLOW,
	)
})

describe("the chain: what the framework owns, and props without a declaration of their own", () => {
	it(
		"a mapped type's prop is added; a destructured parameter or loop variable falls back to its type",
		() => {
			project.write("chain/db.ts", "export type Db = { q: number }\n")
			const entryPath = project.write(
				"chain/edges.ts",
				lines(
					'import { createMiddleware, honey } from "@lovrozagar/honey"',
					'import type { Db } from "./db.ts"',
					'const mapped = createMiddleware((_c, next) => next({} as Record<"tenant", string>))',
					"const param = createMiddleware((_c, next) => {",
					"\tconst run = ({ db }: { db: Db }) => next({ db })",
					"\treturn run({ db: { q: 1 } })",
					"})",
					"const loop = createMiddleware((_c, next) => {",
					"\tfor (const { row } of [{ row: { r: 1 } }]) return next({ row })",
					"\treturn next({ row: { r: 2 } })",
					"})",
					"export const app = honey<{}>().use(mapped).use(param).use(loop)",
				),
			)
			expect(extracted(entryPath).middleware).toEqual([
				{ name: "tenant", optional: false, type: "string" },
				{ name: "db", optional: false, type: `import("${project.root}/chain/db.ts").Db` },
				{ name: "row", optional: false, type: "{ r: number }" },
			])
		},
		SLOW,
	)

	it(
		"owns every name the context class declares; a user prop of the same name is the user's",
		() => {
			const entryPath = project.write(
				"mw/owned.ts",
				lines(
					'import { createMiddleware, honey } from "@lovrozagar/honey"',
					"const mw = createMiddleware((_c, next) => next({ log: 'mine', user: 1 }))",
					"export const app = honey<{}>().use(mw)",
				),
			)
			const names = extract(entryPath).types.middleware.map((p) => p.name)
			expect(names).toEqual(["log", "user"])
			for (const owned of ["error", "ip", "signal", "req", "res", "env", "errors", "meta", "tap"]) {
				expect(names).not.toContain(owned)
			}
		},
		SLOW,
	)
})

describe("the chain: a prop's declared type, by reference", () => {
	it(
		"references an exported type by import(), through an annotation, an untyped value or a shorthand; an anonymous one is written out",
		() => {
			// v0: b9461569ac
			// v0: aa1eea7a00
			// v0: 3ec4d9e63f
			// v0: 5771ecf0e2
			project.write(
				"refs/db-types.ts",
				lines(
					"type InnerSchema = { users: { id: string; name: string }; posts: { id: string; title: string } }",
					"export type DbClient = { query: InnerSchema; batch: (items: unknown[]) => Promise<unknown[]> }",
					"export type SessionDb = { schema: InnerSchema; exec: (sql: string) => Promise<void> }",
				),
			)
			const entryPath = project.write(
				"refs/app.ts",
				lines(
					'import { createMiddleware, honey } from "@lovrozagar/honey"',
					'import type { DbClient, SessionDb } from "./db-types.ts"',
					"const withDb = createMiddleware((_c: { env: { DB: string } }, next) => {",
					"\tconst db: DbClient = {} as DbClient",
					"\tconst untyped = {} as DbClient",
					"\tconst sessionDb: SessionDb = {} as SessionDb",
					"\tconst token = 'abc'",
					'\tconst anon = { query: { users: { id: "x" } }, run: () => {} }',
					"\treturn next({ anon, db, sessionDb, token, untyped })",
					"})",
					"export const app = honey<{ DB: string }>().use(withDb)",
				),
			)
			const types = `import("${join(project.root, "refs/db-types.ts")}")`
			expect(shown(extract(entryPath).types.middleware)).toEqual([
				"anon: { query: { users: { id: string } }; run: () => void }",
				`db: ${types}.DbClient`,
				`sessionDb: ${types}.SessionDb`,
				"token: string",
				`untyped: ${types}.DbClient`,
			])
		},
		SLOW,
	)
})

describe("the chain: a destructured binding's declared type", () => {
	it(
		"traces a destructured binding back to the annotation its source returns",
		() => {
			project.write("refs/shard.ts", "export type ShardDb = { shard: number; query: (sql: string) => unknown }\n")
			const entryPath = project.write(
				"refs/destructured.ts",
				lines(
					'import { createMiddleware, honey } from "@lovrozagar/honey"',
					'import type { ShardDb } from "./shard.ts"',
					"function openShardSession() {",
					"\tconst shardDb: ShardDb = { query: () => null, shard: 1 }",
					"\treturn { shardDb }",
					"}",
					"const mw = createMiddleware((_c, next) => {",
					"\tconst { shardDb } = openShardSession()",
					"\treturn next({ shardDb })",
					"})",
					"export const app = honey<{}>().use(mw)",
				),
			)
			expect(shown(extract(entryPath).types.middleware)).toEqual([
				`shardDb: import("${join(project.root, "refs/shard.ts")}").ShardDb`,
			])
		},
		SLOW,
	)
})
