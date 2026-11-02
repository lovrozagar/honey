/**
 * honey/public-jsdoc: every declaration a package's `exports` reach, and every member a consumer can see on it, carries
 * written JSDoc. Through real oxlint, because the rule reads the rest of the package from disk.
 */
import { describe, expect, it } from "vitest"
import { oxlintReports } from "./rule-harness.ts"
import { SPAWN_TIMEOUT } from "../tests/fixture/spawn-timeout.ts"

const MANIFEST = JSON.stringify({ exports: { ".": { "honey-source": "./src/index.ts" } } })

const missing = (name: string, entry = ".") =>
	`\`${name}\` is public through "${entry}" and has no JSDoc: add a /** */ block that says what a caller needs and the type does not`
const empty = (name: string) =>
	`\`${name}\` is public through "." and its JSDoc is empty: say what a caller needs and the type does not`
const restates = (name: string) =>
	`\`${name}\` is public through "." and its JSDoc only restates the name: say what a caller needs and the type does not`
const internal = (name: string) =>
	`\`${name}\` is public through "." and its JSDoc cites an internal reference, which ships to consumers: say it in their terms`
const inferred = (name: string) =>
	`\`${name}\` is public through "." and its type is inferred, so its shape goes unchecked: write the type out`

function messages(code: string, extra: Record<string, string> = {}): string[] {
	const fixture = { "package.json": MANIFEST, "src/index.ts": code, ...extra }
	return oxlintReports("public-jsdoc", fixture).map((report) => report.message)
}

describe("honey/public-jsdoc: what needs a doc", { timeout: SPAWN_TIMEOUT }, () => {
	it.each([
		["a function", "export function f(): void {}\n", ["f"]],
		["a class", "export class C {}\n", ["C"]],
		["an interface", "export interface I {}\n", ["I"]],
		["a type alias", "export type T = string\n", ["T"]],
		["a constant", "export const c = 1\n", ["c"]],
		["an enum and its member", "export enum E { A }\n", ["E", "E.A"]],
		["a default export", "export default function d(): void {}\n", ["d"]],
		[
			"each overload",
			"export function f(a: string): void\nexport function f(a: number): void\nexport function f(a: unknown): void {}\n",
			["f", "f"],
		],
		["a type member", "/** The shape. */\nexport type T = { a: string }\n", ["T.a"]],
		["a nested member", "/** The shape. */\nexport type T = { /** The inner. */ a: { b: string } }\n", ["T.b"]],
		[
			"a union and intersection member",
			"/** The shape. */\nexport type T = { a: string } & ({ b: string } | { c: string })\n",
			["T.a", "T.b", "T.c"],
		],
		["an interface method", "/** The shape. */\nexport interface I { m(): void }\n", ["I.m"]],
		["a call signature", "/** The shape. */\nexport interface I { (a: string): void }\n", ["I.(call)"]],
		["a construct signature", "/** The shape. */\nexport interface I { new (a: string): I }\n", ["I.(new)"]],
		["an index signature", "/** The shape. */\nexport interface I { [key: string]: unknown }\n", ["I.(index)"]],
		["a member of a parameter's literal", "/** Runs. */\nexport function f(o: { a: string }): void {}\n", ["f.a"]],
		["a class method", "/** The class. */\nexport class C { m(): void {} }\n", ["C.m"]],
		["a class constructor", "/** The class. */\nexport class C { constructor(a: string) {} }\n", ["C.constructor"]],
		["a class property", "/** The class. */\nexport class C { p: string = '' }\n", ["C.p"]],
		["a class accessor", "/** The class. */\nexport class C { get g(): string { return '' } }\n", ["C.g"]],
		[
			"a parameter property",
			"/** The class. */\nexport class C {\n/** Makes it. */\nconstructor(readonly p: string) {} }\n",
			["C.p"],
		],
		[
			"a class method overload",
			"/** The class. */\nexport class C { m(a: string): void\nm(a: number): void\nm(a: unknown): void {} }\n",
			["C.m", "C.m"],
		],
		[
			"a well-known symbol key",
			"/** The class. */\nexport class C { [Symbol.iterator](): Iterator<string> { return [].values() } }\n",
			["C.Symbol.iterator"],
		],
	])("requires it on %s", (_, code, names) => {
		expect(messages(code)).toEqual(names.map((name) => missing(name)))
	})
})

describe("honey/public-jsdoc: where a report lands", { timeout: SPAWN_TIMEOUT }, () => {
	it("finds a re-exported declaration and an unexported reachable type where they are defined", () => {
		const fixture = {
			"package.json": MANIFEST,
			"src/index.ts": 'export { cors as allow } from "./cors.ts"\n',
			"src/cors.ts": "type Options = { origin: string }\nexport function cors(options: Options): void {}\n",
		}
		expect(oxlintReports("public-jsdoc", fixture)).toEqual([
			{ file: "src/cors.ts", message: missing("Options") },
			{ file: "src/cors.ts", message: missing("Options.origin") },
			{ file: "src/cors.ts", message: missing("cors") },
		])
	})
})

describe("honey/public-jsdoc: what passes", { timeout: SPAWN_TIMEOUT }, () => {
	it.each([
		["a documented function", "/** Runs it. */\nexport function f(): void {}\n"],
		["a documented constant", "/** How many fit. */\nexport const c = 1\n"],
		["a doc above a line comment", "/** Runs it. */\n// oxlint-disable-next-line\nexport function f(): void {}\n"],
		[
			"overloads, implementation bare",
			"/** By name. */\nexport function f(a: string): void\n/** By id. */\nexport function f(a: number): void\nexport function f(a: unknown): void {}\n",
		],
		[
			"a class overload implementation",
			"/** The class. */\nexport class C {\n/** By name. */\nm(a: string): void\n/** By id. */\nm(a: number): void\nm(a: unknown): void {} }\n",
		],
		[
			"a setter beside its documented getter",
			"/** The class. */\nexport class C {\n/** The size. */\nget g(): string { return '' }\nset g(v: string) {} }\n",
		],
		[
			"private, protected and # members",
			"/** The class. */\nexport class C { private a = new Set(); protected b(): void {} #c = 1; #d(): void {} }\n",
		],
		[
			"a private parameter property",
			"/** The class. */\nexport class C {\n/** Makes it. */\nconstructor(private p: string) {} }\n",
		],
		[
			"a plain identifier computed key",
			"const SELF = Symbol()\n/** The class. */\nexport class C { [SELF]: string = '' }\n",
		],
		["a conditional's extends pattern", "/** Picks. */\nexport type P<T> = T extends { a: infer U } ? U : never\n"],
		["a method's parameter default", "/** The class. */\nexport class C {\n/** Runs. */\nm(a = { b: 1 }): void {} }\n"],
		[
			"a function's body",
			"/** Runs. */\nexport function f(): void { type T = { a: string }; const x: T = { a: '' }; void x }\n",
		],
		["an export no entry reaches", 'export { a } from "./a.ts"\n'],
	])("accepts %s", (_, code) => {
		const a = "/** The first letter. */\nexport const a = 1\nexport const unreached = 2\n"
		expect(messages(code, { "src/a.ts": a })).toEqual([])
	})

	it("stays out of a package without the source condition", () => {
		const fixture = { "package.json": '{"exports":{".":"./src/index.ts"}}', "src/index.ts": "export const a = 1\n" }
		expect(oxlintReports("public-jsdoc", fixture)).toEqual([])
	})

	it("stays out of a file no entry reaches", () => {
		const fixture = { "package.json": MANIFEST, "src/index.ts": "export {}\n", "src/other.ts": "export const a = 1\n" }
		expect(oxlintReports("public-jsdoc", fixture)).toEqual([])
	})
})

describe("honey/public-jsdoc: docs that say nothing", { timeout: SPAWN_TIMEOUT }, () => {
	it("rejects an empty doc", () => {
		expect(messages("/** */\nexport const size = 1\n")).toEqual([empty("size")])
	})

	it("rejects a doc with tags and no text", () => {
		expect(messages("/** @deprecated */\nexport const size = 1\n")).toEqual([empty("size")])
	})

	it("rejects a plain block comment", () => {
		expect(messages("/* The most that fits. */\nexport const size = 1\n")).toEqual([missing("size")])
	})

	it.each([
		["the name", "/** maxAge */\nexport const maxAge = 1\n", "maxAge"],
		["the name's words", "/** The max age. */\nexport const maxAge = 1\n", "maxAge"],
		["the name and stopwords", "/** This is the value of the max age option. */\nexport const maxAge = 1\n", "maxAge"],
		["a member's name", "/** The shape. */\nexport type T = {\n/** Origin. */\norigin: string }\n", "T.origin"],
	])("rejects a doc that restates %s", (_, code, name) => {
		expect(messages(code)).toEqual([restates(name)])
	})

	it("accepts a doc that adds a word to the name", () => {
		expect(messages("/** The max age, in seconds. */\nexport const maxAge = 1\n")).toEqual([])
	})

	it.each([
		["a bit number", "/** The size (bit 19). */\nexport const size = 1\n"],
		["a capitalized bit number", "/** Bit 19: the size. */\nexport const size = 1\n"],
		["a rule id", "/** The size, per H19.3. */\nexport const size = 1\n"],
		["the blueprint", "/** The size the blueprint names. */\nexport const size = 1\n"],
		["a tag's text", "/** The most that fits.\n * @see bit 19\n */\nexport const size = 1\n"],
	])("rejects %s", (_, code) => {
		expect(messages(code)).toEqual([internal("size")])
	})

	it("accepts words that only look internal", () => {
		expect(messages("/** The 64-bit size, over HTTP/2, in bits 1 to 8. */\nexport const size = 1\n")).toEqual([])
	})
})

describe("honey/public-jsdoc: inferred shapes", { timeout: SPAWN_TIMEOUT }, () => {
	it.each([
		["a function's return", "/** Runs. */\nexport function f() { return { a: 1 } }\n", "f"],
		[
			"a constant from a call",
			"/** The table. */\nexport const c = make()\nfunction make(): number { return 1 }\n",
			"c",
		],
		["a constant from an object", "/** The table. */\nexport const c = { a: 1 }\n", "c"],
		["a method's return", "/** The class. */\nexport class C {\n/** Runs. */\nm() { return 1 } }\n", "C.m"],
		["a getter's return", "/** The class. */\nexport class C {\n/** Runs. */\nget g() { return 1 } }\n", "C.g"],
		[
			"a class property from a call",
			"/** The class. */\nexport class C {\n/** The seen keys. */\nreadonly p = new Set<string>() }\n",
			"C.p",
		],
		["an arrow's return", "/** Runs. */\nexport const f = (a: string) => a\n", "f"],
	])("rejects %s", (_, code, name) => {
		expect(messages(code)).toEqual([inferred(name)])
	})

	it.each([
		["a string literal", '/** The name. */\nexport const c = "a"\n'],
		["a negative number", "/** The floor. */\nexport const c = -1\n"],
		["a boolean", "/** The switch. */\nexport const c = true\n"],
		["arithmetic on numbers", "/** The ceiling. */\nexport const c = 128 * 1024 * 1024\n"],
		["as const", '/** The list. */\nexport const c = ["a", "b"] as const\n'],
		["as const with satisfies", '/** The list. */\nexport const c = ["a"] as const satisfies readonly string[]\n'],
		["an annotation", "/** The list. */\nexport const c: string[] = []\n"],
		["an explicit cast", "/** The list. */\nexport const c = [] as string[]\n"],
		["a typed arrow", "/** Runs. */\nexport const f = (a: string): string => a\n"],
		[
			"a constructor and a setter",
			"/** The class. */\nexport class C {\n/** Makes it. */\nconstructor() {}\n/** Sets it. */\nset s(v: string) {} }\n",
		],
		["a class literal", "/** The class. */\nexport class C {\n/** The size. */\nreadonly p = 1 }\n"],
	])("accepts %s", (_, code) => {
		expect(messages(code)).toEqual([])
	})
})

describe("honey/public-jsdoc: failing closed", { timeout: SPAWN_TIMEOUT }, () => {
	it("reports a form the surface cannot follow, on the file that has it", () => {
		const reports = oxlintReports("public-jsdoc", {
			"package.json": MANIFEST,
			"src/index.ts": "export namespace N { export const a = 1 }\n",
		})
		expect(reports).toEqual([
			{
				file: "src/index.ts",
				message:
					"honey/public-jsdoc cannot follow TSModuleDeclaration here, so what it exposes goes unchecked: write it as a plain export",
			},
		])
	})
})
