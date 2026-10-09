import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { generateTypes } from "../../../src/codegen.ts"
import { extractBaseCtx, extractChainTypes } from "../../../src/type-extractor.ts"

/* own directory: other extractor tests share `.tmp-extractor-test` */
const ROOT = resolve(import.meta.dirname, `../../../.tmp-extractor-hardening-${process.pid}`)

function write(rel: string, content: string): string {
	const path = join(ROOT, rel)
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, content, "utf8")
	return path
}

const lines = (...l: string[]) => l.join("\n")

beforeAll(() => mkdirSync(ROOT, { recursive: true }))
afterAll(() => rmSync(ROOT, { force: true, recursive: true }))

describe("route keys include the base path (H71)", () => {
	it("two handles with the same route path get their own middleware, keyed by full path", async () => {
		const entryPath = write(
			"h71/app.ts",
			lines(
				'import { createMiddleware, honey } from "@lovrozagar/honey"',
				'import { mountPublic } from "./public.ts"',
				"type User = { id: string }",
				"const auth = createMiddleware((_c, next) => next({ user: { id: 'u' } as User }))",
				"export const app = honey<{}>()",
				'const v1 = app.basePath("/v1").use(auth)',
				'v1.get("/items").handler((c) => c.res.json("ok", { id: c.user.id }))',
				"mountPublic(app)",
			),
		)
		write(
			"h71/public.ts",
			lines(
				'import { createMiddleware, type Honey } from "@lovrozagar/honey"',
				"const flags = createMiddleware((_c, next) => next({ flags: ['beta'] as string[] }))",
				"export function mountPublic(app: Honey<{}>) {",
				'\tapp.basePath("/public").use(flags).get("/items").handler((c) => c.res.json("ok", { f: c.flags }))',
				"}",
			),
		)
		const result = await extractChainTypes({ entryPath, exportName: "app" })
		expect(Object.keys(result.routeMiddleware).sort()).toEqual(["get /public/items", "get /v1/items"])
		expect(result.routeMiddleware["get /v1/items"]).toContain("user:")
		expect(result.routeMiddleware["get /v1/items"]).not.toContain("flags")
		/* found in a module the entry imports, not only in the entry */
		expect(result.routeMiddleware["get /public/items"]).toContain("flags:")
	})

	it("generateTypes looks a route up exactly — no suffix-stripping guess", () => {
		const code = generateTypes(
			{
				_collectRoutes: () => [
					{ handler: { ek: new Set(), iv: null, mt: null, mw: [], os: null }, method: "GET", path: "/public/items" },
				],
				_collectWsRoutes: () => [],
				_errorFactory: null,
			} as never,
			{ routeMiddleware: { "get /items": "{ user: { id: string } }" } },
		)
		expect(code).not.toContain("MwCtx")
	})
})

describe("import() references resolve (H72)", () => {
	it("maps package files through exports, @types to the typed package, and drops lib imports", async () => {
		write(
			"h72/node_modules/fakepkg/package.json",
			JSON.stringify({ exports: { "./client": { types: "./dist/client.d.ts" } }, name: "fakepkg" }),
		)
		write("h72/node_modules/fakepkg/dist/client.d.ts", "export type Client<T> = { get(): T }\n")
		write(
			"h72/node_modules/@types/fakelib/package.json",
			JSON.stringify({ name: "@types/fakelib", types: "index.d.ts" }),
		)
		write("h72/node_modules/@types/fakelib/index.d.ts", "export type Lib = { n: number }\n")
		const entryPath = write(
			"h72/app.ts",
			lines(
				'import { createMiddleware, honey } from "@lovrozagar/honey"',
				'import type { Client } from "fakepkg/client"',
				'import type { Lib } from "fakelib"',
				"type Row = { id: string }",
				"const mw = createMiddleware((_c, next) => {",
				"\tconst client: Client<Row> = { get: () => ({ id: 'x' }) }",
				"\tconst lib: Lib = { n: 1 }",
				"\tconst when: Date = new Date()",
				"\treturn next({ client, lib, when })",
				"})",
				"export const app = honey<{}>().use(mw)",
			),
		)
		const result = await extractBaseCtx({ entryPath, exportName: "app", outputDir: join(ROOT, "h72/_gen") })
		const mw = result.middlewareType ?? ""
		expect(mw).toContain('client: import("fakepkg/client").Client<{ id: string }>')
		expect(mw).toContain('lib: import("fakelib").Lib')
		expect(mw).toContain("when: Date")
		expect(mw).not.toContain("lib.es5")
		expect(mw).not.toContain("node_modules")
	})
})

describe("structural types are written exactly (H73)", () => {
	it("keeps optional and rest params, generics, precedence, literals, quoted keys, tuple rest", async () => {
		const entryPath = write(
			"h73/app.ts",
			lines(
				'import { createMiddleware, honey } from "@lovrozagar/honey"',
				"class Secret { #hidden = 1; visible = 2 }",
				"const mw = createMiddleware((_c, next) =>",
				"\tnext({",
				"\t\tfns: [] as Array<() => void>,",
				"\t\tid: <T,>(x: T): T => x,",
				"\t\tlog: (msg: string, level?: number, ...tags: string[]): void => {},",
				"\t\tflag: true as const,",
				'\t\tquote: "a\\"b" as const,',
				'\t\thdrs: { "x-request-id": "r" },',
				"\t\ttuple: ['a', 1, 2] as [string, ...number[]],",
				"\t\tsecret: new Secret() as { visible: number },",
				"\t}),",
				")",
				"export const app = honey<{}>().use(mw)",
			),
		)
		const result = await extractBaseCtx({ entryPath, exportName: "app" })
		const mw = result.middlewareType ?? ""
		expect(mw).toContain("fns: (() => void)[]")
		expect(mw).toContain("id: <T>(x: T) => T")
		expect(mw).toContain("log: (msg: string, level?: number, ...tags: string[]) => void")
		expect(mw).toContain("flag: true")
		expect(mw).toContain('quote: "a\\"b"')
		expect(mw).toContain('hdrs: { "x-request-id": string }')
		expect(mw).toContain("tuple: [string, ...number[]]")
		expect(mw).not.toContain("#hidden")
	})

	it("a recursive interface is referenced by name when exported", async () => {
		const entryPath = write(
			"h73r/app.ts",
			lines(
				'import { createMiddleware, honey } from "@lovrozagar/honey"',
				"export interface Tree { children: Tree[]; name: string }",
				"const mw = createMiddleware((_c, next) => next({ tree: { children: [], name: 'r' } as Tree }))",
				"export const app = honey<{}>().use(mw)",
			),
		)
		const result = await extractBaseCtx({ entryPath, exportName: "app" })
		expect(result.middlewareType).toMatch(/tree: import\("[^"]*h73r\/app\.ts"\)\.Tree/)
	})
})

describe("entries", () => {
	it("accepts `export default honey()`", async () => {
		const entryPath = write(
			"default/app.ts",
			lines('import { honey } from "@lovrozagar/honey"', "type Env = { KEY: string }", "export default honey<Env>()"),
		)
		const result = await extractBaseCtx({ entryPath, exportName: "default" })
		expect(result.envType).toContain("KEY")
	})
})
