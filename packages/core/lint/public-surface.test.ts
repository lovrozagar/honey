/**
 * The graph behind honey/public-jsdoc: what a package's `exports` map reaches, by name or through a type position,
 * read from a real package on disk because the graph crosses files.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { findPackageRoot, publicSurface } from "./public-surface.js"

const roots: string[] = []

function packageOf(entries: Record<string, string>, files: Record<string, string>): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "honey-surface-")))
	roots.push(root)
	const exports = Object.fromEntries(Object.entries(entries).map(([key, file]) => [key, { "honey-source": file }]))
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ exports: { ...exports, "./package.json": "./package.json" } }),
	)
	for (const [file, code] of Object.entries(files)) {
		mkdirSync(dirname(join(root, file)), { recursive: true })
		writeFileSync(join(root, file), code)
	}
	return root
}

function namesIn(root: string): Record<string, string[]> {
	const out: Record<string, string[]> = {}
	for (const [file, names] of publicSurface(root).names) out[file.slice(root.length + 1)] = [...names.keys()].sort()
	return out
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

describe("publicSurface: reach", () => {
	it("follows every re-export form from an entry to the file that declares the name", () => {
		const root = packageOf(
			{ ".": "./src/index.ts" },
			{
				"src/index.ts": [
					'export { a, b as renamed } from "./named.ts"',
					'export * from "./star.ts"',
					'export * as space from "./space.ts"',
					'import { imported } from "./imported.ts"',
					"export { imported }",
					'export { default as fallback } from "./fallback.ts"',
					"export function own(): void {}",
				].join("\n"),
				"src/named.ts": "export const a = 1\nexport const b = 2\nexport const hidden = 3\n",
				"src/star.ts": 'export const s = 1\nexport * from "./deep.ts"\n',
				"src/deep.ts": "export type Deep = string\n",
				"src/space.ts": "export const inSpace = 1\n",
				"src/imported.ts": "export const imported = 1\n",
				"src/fallback.ts": "export default function chosen(): void {}\n",
			},
		)
		expect(namesIn(root)).toEqual({
			"src/deep.ts": ["Deep"],
			"src/fallback.ts": ["chosen"],
			"src/imported.ts": ["imported"],
			"src/index.ts": ["own"],
			"src/named.ts": ["a", "b"],
			"src/space.ts": ["inSpace"],
			"src/star.ts": ["s"],
		})
	})
})

describe("publicSurface: type positions", () => {
	it("reaches an unexported type through each type position", () => {
		const root = packageOf(
			{ ".": "./src/index.ts" },
			{
				"src/index.ts": [
					'import type { Param, Returned, Base, Shape } from "./types.ts"',
					"type Local = { a: string }",
					"const thing = 1",
					"export function f(p: Param): Returned { return p as never }",
					"export class C extends Base {}",
					"export type K = Shape | Local | typeof thing",
					'export type I = import("./types.ts").Imported',
				].join("\n"),
				"src/types.ts": [
					"export type Param = string",
					"export type Returned = number",
					"export class Base {}",
					"export type Shape = boolean",
					"export type Imported = string",
					"export type Unreached = string",
				].join("\n"),
			},
		)
		expect(namesIn(root)).toEqual({
			"src/index.ts": ["C", "I", "K", "Local", "f", "thing"],
			"src/types.ts": ["Base", "Imported", "Param", "Returned", "Shape"],
		})
	})
})

describe("publicSurface: types", () => {
	it("reaches a member of a namespace import by its qualified name", () => {
		const root = packageOf(
			{ ".": "./src/index.ts" },
			{
				"src/index.ts": 'import type * as NS from "./types.ts"\nexport type U = NS.Picked\n',
				"src/types.ts": "export type Picked = string\nexport type Other = string\n",
			},
		)
		expect(namesIn(root)).toEqual({ "src/index.ts": ["U"], "src/types.ts": ["Picked"] })
	})
})

describe("publicSurface: cycles", () => {
	it("ends on a cycle of types", () => {
		const root = packageOf(
			{ ".": "./src/a.ts" },
			{
				"src/a.ts": 'import type { B } from "./b.ts"\nexport type A = { b: B }\n',
				"src/b.ts": 'import type { A } from "./a.ts"\nexport type B = { a: A }\n',
			},
		)
		expect(namesIn(root)).toEqual({ "src/a.ts": ["A"], "src/b.ts": ["B"] })
	})
})

describe("publicSurface: limits", () => {
	it("leaves out an export no entry reaches, a body-only reference and a private member's type", () => {
		const root = packageOf(
			{ ".": "./src/index.ts" },
			{
				"src/index.ts": [
					'import { helper, type BodyOnly, type Hidden } from "./inner.ts"',
					"export function f(): void { const x: BodyOnly = helper(); void x }",
					"export class C { private secret: Hidden = 1 as never; #other: Hidden = 1 as never }",
				].join("\n"),
				"src/inner.ts": [
					"export function helper(): string { return '' }",
					"export type BodyOnly = string",
					"export type Hidden = number",
				].join("\n"),
			},
		)
		expect(namesIn(root)).toEqual({ "src/index.ts": ["C", "f"] })
	})

	it("does not take a type parameter for the declaration it shadows", () => {
		const root = packageOf(
			{ ".": "./src/index.ts" },
			{ "src/index.ts": "type T = string\nexport type Box<T> = { value: T }\nexport type Unused = number\n" },
		)
		expect(namesIn(root)).toEqual({ "src/index.ts": ["Box", "Unused"] })
	})

	it("carries the first entry key that reaches each name", () => {
		const root = packageOf(
			{ ".": "./src/index.ts", "./cors": "./src/cors.ts" },
			{
				"src/index.ts": 'export { shared } from "./cors.ts"\n',
				"src/cors.ts": "export const shared = 1\nexport const only = 2\n",
			},
		)
		const names = publicSurface(root).names.get(join(root, "src/cors.ts"))
		expect(names?.get("shared")).toBe(".")
		expect(names?.get("only")).toBe("./cors")
	})

	it("ignores packages outside the graph", () => {
		const root = packageOf(
			{ ".": "./src/index.ts" },
			{ "src/index.ts": 'import type { Z } from "zod"\nexport type A = Z\n' },
		)
		expect(publicSurface(root).unknown).toEqual([])
		expect(namesIn(root)).toEqual({ "src/index.ts": ["A"] })
	})
})

describe("publicSurface: failing closed", () => {
	it.each([
		["export =", "const a = 1\nexport = a\n", "TSExportAssignment"],
		["a namespace", "export namespace N { export const a = 1 }\n", "TSModuleDeclaration"],
		["a destructured export", "const o = { a: 1 }\nexport const { a } = o\n", "ObjectPattern"],
		["an export of an expression", "export default 1 + 1\n", "BinaryExpression"],
		["a re-export of a name nobody declares", 'export { gone } from "./other.ts"\n', "gone"],
		["a re-export of a file that is not there", 'export { a } from "./missing.ts"\n', "./missing.ts"],
	])("fails closed on %s at an entry", (_, code, form) => {
		const root = packageOf({ ".": "./src/index.ts" }, { "src/index.ts": code, "src/other.ts": "export {}\n" })
		const { unknown } = publicSurface(root)
		expect(unknown).toHaveLength(1)
		expect(unknown[0]?.file).toBe(join(root, "src/index.ts"))
		expect(unknown[0]?.form).toContain(form)
	})

	it("fails closed on an entry that names no file", () => {
		const root = packageOf({ ".": "./src/gone.ts" }, {})
		expect(publicSurface(root).unknown.map((entry) => entry.form)).toEqual(["./src/gone.ts"])
	})

	it("reads a package once", () => {
		const root = packageOf({ ".": "./src/index.ts" }, { "src/index.ts": "export const a = 1\n" })
		expect(publicSurface(root)).toBe(publicSurface(root))
	})
})

describe("findPackageRoot", () => {
	it("finds the nearest package whose exports use the honey-source condition", () => {
		const root = packageOf({ ".": "./src/index.ts" }, { "src/deep/file.ts": "export {}\n" })
		expect(findPackageRoot(join(root, "src/deep/file.ts"))).toBe(root)
	})

	it("passes over a package without the condition", () => {
		const root = packageOf({ ".": "./src/index.ts" }, { "src/plain/package.json": '{"exports":{".":"./a.js"}}\n' })
		expect(findPackageRoot(join(root, "src/plain/a.ts"))).toBe(root)
	})

	it("is null outside any such package", () => {
		expect(findPackageRoot(join(tmpdir(), "nowhere", "a.ts"))).toBeNull()
	})
})
