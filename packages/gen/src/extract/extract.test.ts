import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { extract, type FixtureProject, fixtureProject, lines, routeId, SLOW, shown } from "./__fixtures__/project.ts"
import { extractTypes } from "./extract.ts"

/** The caller's route id, refusing "/bad" as the router would an invalid pattern. */
function refusing(method: string, path: string): string {
	if (path === "/bad") throw new Error("refused")
	return routeId(method, path)
}

let project: FixtureProject
beforeAll(() => {
	project = fixtureProject()
})
afterAll(() => project.dispose())

/** The H72 packages: exports maps, @types, typings, plain and index packages, an unreadable package.json. */
function writePackages(): void {
	const pkg = (dir: string, json: Record<string, unknown>, files: Record<string, string>) => {
		project.write(`h72/node_modules/${dir}/package.json`, JSON.stringify(json))
		for (const [rel, body] of Object.entries(files)) project.write(`h72/node_modules/${dir}/${rel}`, body)
	}
	pkg(
		"fakepkg",
		{ exports: { "./client": { types: "./dist/client.d.ts" }, "./private": null }, name: "fakepkg" },
		/* an unreadable package.json on the way up is no package boundary */
		{ "dist/client.d.ts": "export type Client<T> = { get(): T }\n", "dist/package.json": "{" },
	)
	pkg(
		"@types/fakelib",
		{ name: "@types/fakelib", types: "index.d.ts" },
		{ "index.d.ts": "export type Lib = { n: 1 }\n" },
	)
	pkg(
		"@types/scope__typed",
		{ name: "@types/scope__typed", typings: "index.d.ts" },
		{ "index.d.ts": "export type T = { t: 1 }\n" },
	)
	pkg("strpkg", { exports: "./index.d.ts", name: "strpkg" }, { "index.d.ts": "export type S = { s: 1 }\n" })
	pkg("plainpkg", { name: "plainpkg" }, { "lib/thing.d.ts": "export type P = { p: 1 }\n" })
	pkg("idxpkg", { name: "idxpkg" }, { "index.d.ts": "export type I = { i: 1 }\n" })
}

describe("the base: the env, whatever the app is exported as", () => {
	it(
		"writes the env type structurally, and unknown when honey() has no type argument",
		() => {
			// v0: a501b970a5
			// v0: 0f51b0b900
			const typed = project.write(
				"env/app.ts",
				lines(
					'import { honey } from "@lovrozagar/honey"',
					"type Env = { DB: string; SECRET: string }",
					"export const app = honey<Env>()",
				),
			)
			const bare = project.write(
				"env/bare.ts",
				lines('import { honey } from "@lovrozagar/honey"', "export const app = honey()"),
			)
			expect([extract(typed).types.env, extract(bare).types.env]).toEqual(["{ DB: string; SECRET: string }", "unknown"])
		},
		SLOW,
	)

	it(
		"finds the app under any export name, `export default honey()` included",
		() => {
			// v0: 92fa72b282
			// v0: 3a2b67a05a
			const named = project.write(
				"entries/named.ts",
				lines('import { honey } from "@lovrozagar/honey"', "export const myApp = honey<{ KEY: string }>()"),
			)
			const fallback = project.write(
				"entries/default.ts",
				lines('import { honey } from "@lovrozagar/honey"', "type Env = { KEY: string }", "export default honey<Env>()"),
			)
			expect([
				extract(named, { exportName: "myApp" }).types.env,
				extract(fallback, { exportName: "default" }).types.env,
			]).toEqual(["{ KEY: string }", "{ KEY: string }"])
		},
		SLOW,
	)
})

describe("the base: the entry and the tsconfig it is read with", () => {
	it(
		"throws on an export that is missing or not a honey app",
		() => {
			// v0: 1a53918b16
			const entryPath = project.write(
				"entries/missing.ts",
				lines('import { honey } from "@lovrozagar/honey"', "export const app = honey()", "export const n = 1"),
			)
			expect(() => extract(entryPath, { exportName: "nonexistent" })).toThrow(
				`Export "nonexistent" not found in ${entryPath}`,
			)
			expect(() => extract(entryPath, { exportName: "n" })).toThrow('Export "n" is not a honey app')
		},
		SLOW,
	)

	it(
		"reads the project through the tsconfig it is given, else the nearest one",
		() => {
			// v0: 0ca2eabe14
			const broken = fixtureProject({ paths: { "@lovrozagar/honey": ["./missing.ts"] } })
			try {
				broken.write(
					"alt/tsconfig.json",
					readFileSync(join(project.root, "tsconfig.json"), "utf8").replace(
						"./honey.ts",
						resolve(project.root, "honey.ts"),
					),
				)
				const entryPath = broken.write(
					"app.ts",
					lines('import { honey } from "@lovrozagar/honey"', "export const app = honey<{ X: number }>()"),
				)
				expect(extract(entryPath, { tsconfigPath: join(broken.root, "alt/tsconfig.json") }).types.env).toBe(
					"{ X: number }",
				)
				expect(() => extract(entryPath)).toThrow('Export "app" is not a honey app')
			} finally {
				broken.dispose()
			}
		},
		SLOW,
	)
})

describe("the base: the app's own additions and its taps", () => {
	it(
		"lists what middleware added, never what the context itself owns",
		() => {
			// v0: 4bbc7a8e0b
			// v0: 7b7f0cda8a
			const bare = project.write(
				"mw/bare.ts",
				lines('import { honey } from "@lovrozagar/honey"', "export const app = honey<{}>()"),
			)
			const annotated = project.write(
				"mw/annotated.ts",
				lines(
					'import { honey, type Honey, type HoneyContext } from "@lovrozagar/honey"',
					"type MwAdds = { userId: string; role?: string }",
					"export const app: Honey<{}, HoneyContext<{}> & MwAdds> = honey<{}>() as never",
				),
			)
			expect(extract(bare).types.middleware).toEqual([])
			expect(shown(extract(annotated).types.middleware)).toEqual(["userId: string", "role?: string"])
		},
		SLOW,
	)

	it(
		"writes taps structurally, null when none are declared",
		() => {
			// v0: 159d58f309
			// v0: 73a8f61442
			// v0: 34d3db2a0c
			// v0: 81c8d17a0a
			const none = project.write(
				"taps/none.ts",
				lines('import { honey } from "@lovrozagar/honey"', "export const app = honey<{}>()"),
			)
			const declared = project.write(
				"taps/declared.ts",
				lines(
					'import { honey } from "@lovrozagar/honey"',
					'type Payload = { action: "create" | "delete"; id: string }',
					"type Taps = { audit: Payload }",
					"export const app = honey<{}>().taps<Taps>()",
				),
			)
			expect([extract(none).types.taps, extract(declared).types.taps]).toEqual([
				null,
				'{ audit: { action: "create" | "delete"; id: string } }',
			])
		},
		SLOW,
	)
})

describe("routes: keyed by the caller's route id", () => {
	it(
		"keys each route by the caller's route id; a route nothing added to has no entry",
		() => {
			// v0: 172856deca
			// v0: f3ce381b1d
			// v0: feaa41400d
			const entryPath = project.write(
				"routes/chains.ts",
				lines(
					'import { createMiddleware, honey } from "@lovrozagar/honey"',
					"type AuthData = { sub: string }",
					"const withAuth = createMiddleware(async (_c, next) => next({ auth: { sub: 'x' } as AuthData }))",
					"const withAdmin = createMiddleware(async (_c, next) => next({ admin: { level: 1 } }))",
					"export const app = honey<{}>()",
					'app.get("/public").handler((c) => c.res.text("ok", "ok"))',
					"const authed = app.use(withAuth)",
					'authed.get("/user").handler((c) => c.res.text("ok", "ok"))',
					"const admin = authed.use(withAdmin)",
					'admin.get("/admin").handler((c) => c.res.text("ok", "ok"))',
				),
			)
			const bare = project.write(
				"routes/bare.ts",
				lines('import { honey } from "@lovrozagar/honey"', "export const app = honey<{ DB: string }>()"),
			)
			const { routes } = extract(entryPath).types
			expect(Object.keys(routes).sort()).toEqual(["GET /admin", "GET /user"])
			expect(shown(routes["GET /user"])).toEqual(["auth: { sub: string }"])
			expect(shown(routes["GET /admin"])).toEqual(["auth: { sub: string }", "admin: { level: number }"])
			expect(extract(bare).types).toEqual({ env: "{ DB: string }", middleware: [], routes: {}, taps: null })
		},
		SLOW,
	)
})

describe("routes: every kind of middleware and method", () => {
	it(
		"sees chained, scoped and builder middleware, and every method of .on() and .all()",
		() => {
			// v0: a9806c1119
			const entryPath = project.write(
				"routes/kinds.ts",
				lines(
					'import { createMiddleware, honey } from "@lovrozagar/honey"',
					"const a = createMiddleware((_c, next) => next({ a: 'x' }))",
					"const s = createMiddleware((_c, next) => next({ s: 1 }))",
					"const b = createMiddleware((_c, next) => next({ b: true }))",
					"export const app = honey<{}>()",
					'app.use(a).get("/guarded").handler((c) => c.res.text("ok", "ok"))',
					'const scoped = app.use("/admin", s)',
					'scoped.get("/admin/x").handler((c) => c.res.text("ok", "ok"))',
					'scoped.get("/other").handler((c) => c.res.text("ok", "ok"))',
					'app.post("/one").use(b).handler((c) => c.res.text("ok", "ok"))',
					'app.use(a).on(["GET", "PUT"], "/both").handler((c) => c.res.text("ok", "ok"))',
					'app.use(a).all("/any").handler((c) => c.res.text("ok", "ok"))',
				),
			)
			const { routes } = extract(entryPath).types
			expect(Object.fromEntries(Object.entries(routes).map(([id, props]) => [id, shown(props)]))).toEqual({
				"ALL /any": ["a: string"],
				"GET /admin/x": ["s: number"],
				"GET /both": ["a: string"],
				"GET /guarded": ["a: string"],
				"POST /one": ["b: boolean"],
				"PUT /both": ["a: string"],
			})
		},
		SLOW,
	)
})

describe("routes: full paths, across modules", () => {
	it(
		"keys a route by its full path, base path included, wherever it is registered",
		() => {
			// v0: 76b15f5774
			// v0: aa8f12a2b6
			const entryPath = project.write(
				"h71/app.ts",
				lines(
					'import { createMiddleware, honey } from "@lovrozagar/honey"',
					'import { mountPublic } from "./public.ts"',
					"type User = { id: string }",
					"const auth = createMiddleware((_c, next) => next({ user: { id: 'u' } as User }))",
					"export const app = honey<{}>()",
					'const v1 = app.basePath("/v1/").use(auth)',
					'v1.get("/items").handler((c) => c.res.json("ok", { id: c.user.id }))',
					"mountPublic(app)",
				),
			)
			project.write(
				"h71/public.ts",
				lines(
					'import { createMiddleware, type Honey } from "@lovrozagar/honey"',
					"const flags = createMiddleware((_c, next) => next({ flags: ['beta'] as string[] }))",
					"export function mountPublic(app: Honey<{}>) {",
					'\tapp.basePath("/public").use(flags).get("/items").handler((c) => c.res.json("ok", { f: c.flags }))',
					"}",
				),
			)
			const { routes } = extract(entryPath).types
			/* never a suffix ("GET /items") another route could be looked up by */
			expect(Object.keys(routes).sort()).toEqual(["GET /public/items", "GET /v1/items"])
			expect(shown(routes["GET /v1/items"])).toEqual(["user: { id: string }"])
			expect(shown(routes["GET /public/items"])).toEqual(["flags: string[]"])
		},
		SLOW,
	)
})

describe("routes: what is skipped, and said", () => {
	it(
		"skips, and reports, a route whose path is no literal, one the router refuses, and an id two registrations disagree on",
		() => {
			const entryPath = project.write(
				"routes/skipped.ts",
				lines(
					'import { createMiddleware, honey } from "@lovrozagar/honey"',
					"const a = createMiddleware((_c, next) => next({ a: 1 }))",
					"const b = createMiddleware((_c, next) => next({ b: 1 }))",
					"export const app = honey<{}>()",
					'const path: string = "/dyn"',
					'app.use(a).get(path).handler((c) => c.res.text("ok", "ok"))',
					'app.use(a).get("/bad").handler((c) => c.res.text("ok", "ok"))',
					'app.use(a).get("/twice").handler((c) => c.res.text("ok", "ok"))',
					'app.use(b).get("/twice").handler((c) => c.res.text("ok", "ok"))',
					'app.use(a).get("/same").handler((c) => c.res.text("ok", "ok"))',
					'app.use(a).get("/same").handler((c) => c.res.text("ok", "ok"))',
				),
			)
			const { reports, types } = extract(entryPath, { routeId: refusing })
			expect(Object.keys(types.routes)).toEqual(["GET /same"])
			expect(reports).toEqual([
				expect.stringMatching(
					/routes\/skipped\.ts:6: the route's path is not a literal type; its ctx is not extracted$/,
				),
				expect.stringMatching(
					/routes\/skipped\.ts:7: the router refuses "\/bad" \(refused\); its ctx is not extracted$/,
				),
				'"GET /twice" is registered with different middleware; its ctx is not extracted',
			])
		},
		SLOW,
	)
})

describe("routes: only a route's own additions", () => {
	it(
		"leaves out what the app itself added: a route lists only its own additions",
		() => {
			const entryPath = project.write(
				"routes/beyond.ts",
				lines(
					'import { createMiddleware, honey } from "@lovrozagar/honey"',
					"const auth = createMiddleware((_c, next) => next({ auth: 'x' }))",
					"const admin = createMiddleware((_c, next) => next({ admin: true }))",
					"export const app = honey<{}>().use(auth)",
					'app.use(admin).get("/a").handler((c) => c.res.text("ok", "ok"))',
					'app.get("/b").handler((c) => c.res.text("ok", "ok"))',
				),
			)
			const { middleware, routes } = extract(entryPath).types
			expect([shown(middleware), routes]).toEqual([
				["auth: string"],
				{ "GET /a": [{ name: "admin", optional: false, type: "boolean" }] },
			])
		},
		SLOW,
	)
})

describe("types: a named type by reference, everything else exactly", () => {
	it(
		"writes import() specifiers the output can resolve: through a package's exports, @types to the typed package, relative inside the project; lib types bare",
		() => {
			// v0: 08b186a1a7
			writePackages()
			project.write("h72/own.ts", "export type Own = { o: true }\n")
			const entryPath = project.write(
				"h72/app.ts",
				lines(
					'import { createMiddleware, honey } from "@lovrozagar/honey"',
					'import type { Client } from "fakepkg/client"',
					'import type { Lib } from "fakelib"',
					'import type { I } from "idxpkg"',
					'import type { P } from "plainpkg/lib/thing"',
					'import type { T } from "@scope/typed"',
					'import type { S } from "strpkg"',
					'import type { Own } from "./own.ts"',
					"type Row = { id: string }",
					"const mw = createMiddleware((_c, next) => {",
					"\tconst client: Client<Row> = { get: () => ({ id: 'x' }) }",
					"\tconst lib: Lib = { n: 1 }",
					"\tconst own: Own = { o: true }",
					"\tconst when: Date = new Date()",
					"\tconst refs = {} as { i: I; p: P; s: S; t: T }",
					"\treturn next({ client, lib, own, refs, when })",
					"})",
					"export const app = honey<{}>().use(mw)",
				),
			)
			expect(shown(extract(entryPath, { outputDir: join(project.root, "h72/_gen") }).types.middleware)).toEqual([
				'client: import("fakepkg/client").Client<{ id: string }>',
				'lib: import("fakelib").Lib',
				'own: import("../own.ts").Own',
				'refs: { i: import("idxpkg").I; p: import("plainpkg/lib/thing").P; s: import("strpkg").S; t: import("@scope/typed").T }',
				"when: Date",
			])
			/* from a directory above the file, a relative specifier still starts with ./ */
			expect(shown(extract(entryPath, { outputDir: join(project.root, "h72") }).types.middleware)[2]).toBe(
				'own: import("./own.ts").Own',
			)
		},
		SLOW,
	)
})

describe("ts-morph is optional", () => {
	it("without it, extracts nothing and says so once", () => {
		const reports: string[] = []
		const types = extractTypes({
			entryPath: "app.ts",
			exportName: "app",
			report: (m) => reports.push(m),
			routeId,
			tsMorph: undefined,
		})
		expect([types, reports]).toEqual([
			null,
			["ts-morph is not installed: middleware and env types are not extracted (install ts-morph to type ctx)"],
		])
	})
})
