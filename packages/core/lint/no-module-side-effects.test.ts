import { describe, expect, it } from "vitest"
import plugin from "./no-module-side-effects.js"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

const rule = plugin.rules["no-module-side-effects"]
const MESSAGE = "module scope runs no code: mark a pure call /* @__PURE__ */ or move it into a function"

describe("honey/no-module-side-effects", () => {
	it("rejects top-level statements that run code", () => {
		const fixture = {
			"packages/core/src/a.ts": "register()\n",
			"packages/core/src/b.ts": "globalThis.honey = 1\n",
			"packages/core/src/c.ts": "if (globalThis.x) {\n\tthrow new Error('x')\n}\n",
			"packages/gen/src/d.ts": "for (const k of []) {\n}\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/a.ts", message: MESSAGE },
			{ file: "packages/core/src/b.ts", message: MESSAGE },
			{ file: "packages/core/src/c.ts", message: MESSAGE },
			{ file: "packages/gen/src/d.ts", message: MESSAGE },
		])
	})

	it("rejects an initializer that runs code, however deep, unless it is marked pure", () => {
		const fixture = {
			"packages/core/src/a.ts": "export const id = Symbol.for('honey.id')\n",
			"packages/core/src/b.ts": "const table = { a: [build()] }\nexport default table\n",
			"packages/core/src/c.ts": "export default setup()\n",
			"packages/core/src/d.ts": "const t = tag`x`\nconst n = (globalThis.count = 1)\nexport { t, n }\n",
			"packages/core/src/e.ts": "export const enc = /* @__PURE__ */ new TextEncoder()\n",
			"packages/core/src/f.ts": "export const m = /* #__PURE__ */ Object.freeze({ a: 1 })\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/a.ts", message: MESSAGE },
			{ file: "packages/core/src/b.ts", message: MESSAGE },
			{ file: "packages/core/src/c.ts", message: MESSAGE },
			{ file: "packages/core/src/d.ts", message: MESSAGE },
			{ file: "packages/core/src/d.ts", message: MESSAGE },
		])
	})
})

describe("honey/no-module-side-effects: optional feature entries", () => {
	it("accepts a call statement marked `// feature-entry: <name>`, on its line or the line above", () => {
		const fixture = {
			"packages/core/src/trust/trust.ts": "// feature-entry: trust\nregisterFeature('trust', { compileTrust })\n",
			"packages/core/src/proxy/proxy.ts": "registerFeature('proxy', {}) // feature-entry: proxy\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("exempts nothing but a marked call statement, and needs a feature name", () => {
		const fixture = {
			"packages/core/src/a.ts": "// feature-entry: a\nglobalThis.flag = 1\n",
			"packages/core/src/b.ts": "// feature-entry:\nregisterFeature('b', {})\n",
			"packages/core/src/c.ts": "// feature-entry: c\nconst slot = registerFeature('c', {})\n",
			"packages/core/src/d.ts": "// feature-entry: d\nregisterFeature('d', {})\nsetup()\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/a.ts", message: MESSAGE },
			{ file: "packages/core/src/b.ts", message: MESSAGE },
			{ file: "packages/core/src/c.ts", message: MESSAGE },
			{ file: "packages/core/src/d.ts", message: MESSAGE },
		])
	})
})

describe("honey/no-module-side-effects: scope", () => {
	it("allows declarations, literals, functions and types", () => {
		const fixture = {
			"packages/core/src/a.ts": [
				'"use strict"',
				'import { x } from "./x.ts"',
				'export { y } from "./y.ts"',
				"export type T = { a: number }",
				"interface I {\n\tb: string\n}",
				"export const LIMIT = 10",
				"export const NAMES = ['a', `b${LIMIT}`] as const",
				"export const pick = () => compute()",
				"export function run(i: I) {\n\treturn register(i)\n}",
				"export class Box {\n\tvalue = make()\n}",
				"export default { x }",
				"",
			].join("\n"),
			"packages/core/src/a.test.ts": "register()\n",
			"bench/src/hotpath.ts": "await run()\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("fails oxlint through the honey plugin entry", () => {
		const fixture = {
			"packages/core/src/a.ts": "register()\n",
			"packages/core/src/b.ts": "export const id = /* @__PURE__ */ Symbol.for('x')\n",
		}
		expect(oxlintReports("no-module-side-effects", fixture)).toEqual([
			{ file: "packages/core/src/a.ts", message: MESSAGE },
		])
	})
})
