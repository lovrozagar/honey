import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { Project, ts } from "ts-morph"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { extract, type FixtureProject, fixtureProject, lines, SLOW, shown } from "./__fixtures__/project.ts"
import { Serializer } from "./serialize.ts"

/** The serialized type of each `declare const name: …` in `source`, by name. */
function serialized(source: string): Record<string, string> {
	const project = new Project({
		compilerOptions: { lib: ["lib.es2022.d.ts"], strict: true, target: ts.ScriptTarget.ES2022 },
		useInMemoryFileSystem: true,
	})
	/* a module: a script's top-level types would be globals, written by name */
	const file = project.createSourceFile("/m.ts", `export {}\n${source}`)
	const checker = project.getTypeChecker().compilerObject
	const serializer = new Serializer(checker, ts)
	return Object.fromEntries(
		file
			.getDescendantsOfKind(ts.SyntaxKind.VariableDeclaration)
			.map((v) => [v.getName(), serializer.serialize(checker.getTypeAtLocation(v.compilerNode))]),
	)
}

describe("types: keywords, literals, arrays and tuples", () => {
	it("keywords, literals and template literals", () => {
		expect(
			serialized(
				[
					"declare const keywords: [string, number, boolean, bigint, symbol, void, undefined, null, never, unknown, any, object]",
					"declare const u: unique symbol",
					"declare const unique: typeof u",
					"declare const literals: [-1n, 10n, 1.5, 'q\"', true, false]",
					"declare const template: `a${string}`",
				].join("\n"),
			),
		).toMatchObject({
			keywords: "[string, number, boolean, bigint, symbol, void, undefined, null, never, unknown, unknown, object]",
			literals: '[-1n, 10n, 1.5, "q\\"", true, false]',
			template: "string",
			unique: "symbol",
		})
	})

	it("arrays, readonly arrays and tuples with optional, rest and readonly elements", () => {
		expect(
			serialized(
				[
					"declare const list: ReadonlyArray<number>",
					"declare const nested: (readonly string[])[]",
					"declare const tuple: readonly [a: string, b?: number, ...c: boolean[]]",
				].join("\n"),
			),
		).toEqual({
			list: "readonly number[]",
			nested: "(readonly string[])[]",
			tuple: "readonly [string, number?, ...boolean[]]",
		})
	})
})

describe("types: signatures and deferred generic forms", () => {
	it("signatures: overloads, generics and their constraints, callable objects, a type parameter outside its signature", () => {
		expect(
			serialized(
				[
					"declare const over: { (a: string): void; (a: number): void }",
					"declare const generic: <T extends string, U>(x: T, ...rest: U[]) => [T, ...U[]]",
					"declare const callable: { n: number; (a: string): boolean }",
					"function make<T extends number, U>(t: T, u: U) {",
					"\tconst outside = { t }",
					"\tconst unconstrained = { u }",
					"\treturn [outside, unconstrained]",
					"}",
					"declare const variadic: <T extends unknown[]>(x: [string, ...T]) => void",
				].join("\n"),
			),
		).toEqual({
			callable: "{ n: number; (a: string): boolean }",
			generic: "<T extends string, U>(x: T, ...rest: U[]) => [T, ...U[]]",
			outside: "{ t: number }",
			over: "((a: string) => void) & ((a: number) => void)",
			unconstrained: "{ u: unknown }",
			variadic: "<T extends unknown[]>(x: [string, ...T]) => void",
		})
	})

	it("deferred generic forms are written as their bound: conditional, indexed and keyof as unknown, string mappings as string", () => {
		expect(
			serialized(
				"declare const deferred: <T>(x: T, k: keyof T, u: Uppercase<T & string>) => T extends string ? T[keyof T] : never",
			),
		).toEqual({ deferred: "<T>(x: T, k: unknown, u: string) => unknown" })
	})
})

describe("types: objects, lib types, enums and cycles", () => {
	it("objects: quoted keys, readonly and optional members, index signatures; private and protected members left out", () => {
		expect(
			serialized(
				[
					"class C { private hidden = 1; protected guarded = 2; #field = 3; readonly shown = 4 }",
					"declare const object: { 'a-b': 1; ok?: string; nil?: string | null; readonly r: number }",
					"declare const record: { [k: string]: number }",
					"declare const mixed: { a: 1; [k: string]: number }",
					"declare const instance: C",
					"declare const empty: {}",
					"declare const mapped: Record<'a' | 'b', number>",
					"declare const vague: { u?: unknown }",
				].join("\n"),
			),
		).toEqual({
			empty: "{}",
			mapped: "{ a: number; b: number }",
			vague: "{ u?: unknown }",
			instance: "{ readonly shown: 4 }",
			mixed: "{ a: 1; [key: string]: number }",
			object: '{ "a-b": 1; ok?: string; nil?: null | string; readonly r: number }',
			record: "Record<string, number>",
		})
	})

	it("lib types by name with their arguments; an enum no module exports by its values; a type met again while written is unknown", () => {
		expect(
			serialized(
				[
					"enum E { A, B }",
					"type L = { next: L | null; n: number }",
					"declare const lib: [Map<string, Date>, Promise<number>, Set<RegExp>]",
					"declare const local: E",
					"declare const loop: L",
					"declare const reflect: typeof Reflect",
				].join("\n"),
			),
		).toEqual({
			lib: "[Map<string, Date>, Promise<number>, Set<RegExp>]",
			local: "0 | 1",
			loop: "{ next: null | unknown; n: number }",
			/* a namespace is no type name: written out */
			reflect: expect.stringMatching(/^\{ apply: /),
		})
	})
})

describe("types: references by import()", () => {
	it("references a type a module exports by import(), with its arguments; a local one, an ambient module's and a value's are written out", () => {
		const project = new Project({ compilerOptions: { strict: true }, useInMemoryFileSystem: true })
		project.createSourceFile(
			"/types.ts",
			"export interface Box<T> { v: T }\nexport enum Color { Red, Green }\nexport class K { a = 1 }",
		)
		project.createSourceFile("/ambient.d.ts", 'declare module "virtual" { export interface V { v: 1 } }')
		project.createSourceFile("/fns.d.ts", "export declare function fn(): void")
		const file = project.createSourceFile(
			"/m.ts",
			[
				'import type { Box, Color, K } from "./types"',
				'import type { V } from "virtual"',
				'import type { fn } from "./fns"',
				"declare const box: Box<{ x: 1 }>",
				"declare const color: Color",
				"declare const k: K",
				"type Local = { l: 1 }",
				"declare const local: Local",
				"declare const ambient: V",
				"declare const value: typeof fn",
			].join("\n"),
		)
		const checker = project.getTypeChecker().compilerObject
		const serializer = new Serializer(checker, ts)
		const out = Object.fromEntries(
			file.getVariableDeclarations().map((v) => {
				const type = checker.getTypeAtLocation(v.compilerNode)
				return [v.getName(), serializer.asRef(type) ?? serializer.serialize(type)]
			}),
		)
		expect(out).toEqual({
			box: 'import("/types.ts").Box<{ x: 1 }>',
			color: 'import("/types.ts").Color',
			k: 'import("/types.ts").K',
			local: "{ l: 1 }",
			ambient: "{ v: 1 }",
			value: "() => void",
		})
	})
})

describe("an app's types: written exactly (H73)", () => {
	let project: FixtureProject
	beforeAll(() => {
		project = fixtureProject()
	})
	afterAll(() => project.dispose())

	it(
		"keeps optional and rest params, generics, precedence, literals, quoted keys and tuple rest; hides private fields",
		() => {
			// v0: 174e95c0fc
			const entryPath = project.write(
				"h73/app.ts",
				lines(
					'import { createMiddleware, honey } from "@lovrozagar/honey"',
					"class Secret { #hidden = 1; visible = 2 }",
					"const mw = createMiddleware((_c, next) =>",
					"\tnext({",
					"\t\tfns: [] as Array<() => void>,",
					"\t\tid: <T,>(x: T): T => x,",
					"\t\tlogTo: (msg: string, level?: number, ...tags: string[]): void => {},",
					"\t\tflag: true as const,",
					'\t\tquote: "a\\"b" as const,',
					'\t\thdrs: { "x-request-id": "r" },',
					"\t\ttuple: ['a', 1, 2] as [string, ...number[]],",
					"\t\tsecret: new Secret(),",
					"\t}),",
					")",
					"export const app = honey<{}>().use(mw)",
				),
			)
			expect(shown(extract(entryPath).types.middleware)).toEqual([
				"fns: (() => void)[]",
				"id: <T>(x: T) => T",
				"logTo: (msg: string, level?: number, ...tags: string[]) => void",
				"flag: true",
				'quote: "a\\"b"',
				'hdrs: { "x-request-id": string }',
				"tuple: [string, ...number[]]",
				"secret: { visible: number }",
			])
		},
		SLOW,
	)
})

describe("an app's types: recursive and generic", () => {
	let project: FixtureProject
	beforeAll(() => {
		project = fixtureProject()
	})
	afterAll(() => project.dispose())

	it(
		"references a recursive exported interface by name, and a generic method keeps its type parameter",
		() => {
			// v0: d77ffd16aa
			// v0: 7647acbb75
			const entryPath = project.write(
				"h73r/app.ts",
				lines(
					'import { createMiddleware, honey } from "@lovrozagar/honey"',
					"export interface Tree { children: Tree[]; name: string }",
					"const mw = createMiddleware((_c, next) =>",
					"\tnext({",
					"\t\tstore: { read: <T,>(key: string): Promise<T[]> => Promise.resolve([] as T[]) },",
					"\t\ttree: { children: [], name: 'r' } as Tree,",
					"\t}),",
					")",
					"export const app = honey<{}>().use(mw)",
				),
			)
			expect(shown(extract(entryPath).types.middleware)).toEqual([
				"store: { read: <T>(key: string) => Promise<T[]> }",
				`tree: import("${join(project.root, "h73r/app.ts")}").Tree`,
			])
		},
		SLOW,
	)
})

/** What a strict consumer (no skipLibCheck) reports compiling `files`: the extracted type must hold up there. */
function strictErrors(files: readonly string[]): string[] {
	const consumer = new Project({
		compilerOptions: {
			lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			noEmit: true,
			skipLibCheck: false,
			strict: true,
			target: ts.ScriptTarget.ES2022,
			types: [],
		},
		skipAddingFilesFromTsConfig: true,
	})
	for (const file of files) consumer.addSourceFileAtPath(file)
	return consumer
		.getPreEmitDiagnostics()
		.map((d) => ts.flattenDiagnosticMessageText(d.compilerObject.messageText, "\n"))
}

describe("global types: an ambient namespace's", () => {
	it(
		"writes an ambient type by its global name: Cloudflare.Env stays assignable to R2Bucket under a strict consumer",
		() => {
			// v0: 25080c8dd7
			const ambient = fixtureProject({ types: ["./worker-configuration.d.ts"] })
			try {
				ambient.write(
					"worker-configuration.d.ts",
					readFileSync(resolve(import.meta.dirname, "__fixtures__/ambient-env/worker-configuration.d.ts"), "utf8"),
				)
				const entryPath = ambient.write(
					"app.ts",
					lines('import { honey } from "@lovrozagar/honey"', "export const app = honey<Cloudflare.Env>()"),
				)
				const { env } = extract(entryPath, { outputDir: ambient.root }).types
				ambient.write("gen.d.ts", `export type Env = ${env}\n`)
				const usePath = ambient.write(
					"use.ts",
					lines(
						'import type { Env } from "./gen"',
						"export function bucket(env: Env): R2Bucket {",
						"\treturn env.BUCKET",
						"}",
					),
				)
				expect([env, strictErrors([join(ambient.root, "worker-configuration.d.ts"), usePath])]).toEqual([
					"Cloudflare.Env",
					[],
				])
			} finally {
				ambient.dispose()
			}
		},
		SLOW,
	)
})

describe("global types: a `declare global` interface", () => {
	it(
		"writes a `declare global` type by name, neither imported nor inlined",
		() => {
			// v0: a0ff9b24c9
			const global = fixtureProject({ types: ["./globals.d.ts"] })
			try {
				global.write(
					"globals.d.ts",
					lines(
						"export {}",
						"declare global {",
						"\tinterface AppBindings { DB: { query(sql: string): Promise<unknown> } }",
						"}",
					),
				)
				const entryPath = global.write(
					"app.ts",
					lines('import { honey } from "@lovrozagar/honey"', "export const app = honey<AppBindings>()"),
				)
				expect(extract(entryPath).types.env).toBe("AppBindings")
			} finally {
				global.dispose()
			}
		},
		SLOW,
	)
})
