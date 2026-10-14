import { describe, expect, it } from "vitest"
import plugin from "./no-module-state.js"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

const rule = plugin.rules["no-module-state"]
const MESSAGE =
	"module-scope state needs `// per-process-constant: <reason>` with an allowlisted reason (raw-body, text-codec, rate-limit-store, i18n-dict, build-id)"

describe("honey/no-module-state", () => {
	it("rejects module-scope let, var and constructed state", () => {
		const fixture = {
			"packages/core/src/a.ts": "let count = 0\nexport function bump() {\n\treturn ++count\n}\n",
			"packages/core/src/b.ts": "export var cache = {}\n",
			"packages/core/src/c.ts":
				"const seen = new Map<string, number>()\nexport const has = (k: string) => seen.has(k)\n",
			"packages/gen/src/d.ts": "export const memo = new WeakMap()\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/a.ts", message: MESSAGE },
			{ file: "packages/core/src/b.ts", message: MESSAGE },
			{ file: "packages/core/src/c.ts", message: MESSAGE },
			{ file: "packages/gen/src/d.ts", message: MESSAGE },
		])
	})

	it("accepts an allowlisted reason on the line or the line above", () => {
		const fixture = {
			"packages/core/src/response/builder.ts":
				"const RAW = new WeakMap<Response, unknown>() // per-process-constant: raw-body — every reader finds the raw body\n",
			"packages/core/src/input/json.ts":
				"// per-process-constant: text-codec\nconst decoder = new TextDecoder()\nexport const decode = (b: Uint8Array) => decoder.decode(b)\n",
			"packages/core/src/build/plugin.ts":
				"let buildId = '' // per-process-constant: build-id\nexport const id = () => buildId\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("rejects a reason that is not on the allowlist, or a bare marker", () => {
		const fixture = {
			"packages/core/src/a.ts": "let n = 0 // per-process-constant: convenient\nexport const get = () => n\n",
			"packages/core/src/b.ts": "// per-process-constant:\nconst m = new Map()\nexport const get = () => m\n",
			"packages/core/src/c.ts": "// raw-body\nconst m = new Map()\nexport const get = () => m\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/a.ts", message: MESSAGE },
			{ file: "packages/core/src/b.ts", message: MESSAGE },
			{ file: "packages/core/src/c.ts", message: MESSAGE },
		])
	})
})

describe("honey/no-module-state: scope", () => {
	it("allows constants, function-scope state, tests and code outside src", () => {
		const fixture = {
			"packages/core/src/a.ts":
				"const LIMIT = 10\nconst NAMES = ['a', 'b'] as const\nexport function f() {\n\tlet i = 0\n\tconst m = new Map()\n\treturn m.size + i + LIMIT + NAMES.length\n}\n",
			"packages/core/src/a.test.ts": "let calls = 0\nconst m = new Map()\n",
			"bench/src/hotpath.ts": "let failed = false\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("fails oxlint through the honey plugin entry", () => {
		const fixture = {
			"packages/core/src/a.ts": "let n = 0\nexport const get = () => n\n",
			"packages/core/src/b.ts":
				"const enc = new TextEncoder() // per-process-constant: text-codec\nexport const e = enc\n",
		}
		expect(oxlintReports("no-module-state", fixture)).toEqual([{ file: "packages/core/src/a.ts", message: MESSAGE }])
	})
})
