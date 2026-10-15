import { createRequire } from "node:module"
import { describe, expect, it } from "vitest"
import { toYaml } from "./yaml.ts"

/* a reader, test-only: the emitter itself stays vendor-free */
const jsYaml = createRequire(import.meta.url)("js-yaml") as {
	CORE_SCHEMA: unknown
	load(text: string, options?: { schema?: unknown }): unknown
}

/** `value` as a YAML 1.2 reader reads it back, and as the core schema alone does. */
function readBack(value: unknown): [unknown, unknown] {
	const text = toYaml(value)
	return [jsYaml.load(text), jsYaml.load(text, { schema: jsYaml.CORE_SCHEMA })]
}

/** `value`'s JSON view, twice: what both reads must give. */
function jsonTwice(value: unknown): [unknown, unknown] {
	const json: unknown = JSON.parse(JSON.stringify(value) ?? "null")
	return [json, json]
}

describe("toYaml: the same document as JSON, in YAML", () => {
	// v0: 262933b444
	// v0: 7848edcbce
	// v0: df9bb270c3
	it("writes scalars plain, quotes a string a reader would misread, and writes empty collections inline", () => {
		expect(
			[null, true, 3.14, "hello", "true", "01", "a: b", "", [], {}, undefined].map((value) => toYaml(value)),
		).toEqual([
			"null\n",
			"true\n",
			"3.14\n",
			"hello\n",
			'"true"\n',
			'"01"\n',
			'"a: b"\n',
			'""\n',
			"[]\n",
			"{}\n",
			"null\n",
		])
	})

	// v0: 9b81ec3d10
	it("writes a nested OpenAPI-shaped object by indentation, in its own key order", () => {
		const spec = {
			info: { title: "Demo", version: "1.0.0" },
			openapi: "3.1.0",
			paths: {
				"/api/health": {
					get: {
						responses: {
							"200": { content: { "application/json": { schema: { type: "object" } } }, description: "ok" },
						},
						summary: "Health",
						tags: ["ops"],
					},
				},
			},
		}
		expect(toYaml(spec)).toBe(`info:
  title: Demo
  version: "1.0.0"
openapi: "3.1.0"
paths:
  /api/health:
    get:
      responses:
        "200":
          content:
            application/json:
              schema:
                type: object
          description: ok
      summary: Health
      tags:
        - ops
`)
	})
})

describe("toYaml: nesting, and JSON's normalization", () => {
	it("writes an object inside a list on the dash's line, and a list inside a list compact on its dash", () => {
		expect(toYaml({ list: [{ a: 1, b: [1, [2]] }, []] })).toBe(`list:
  - a: 1
    b:
      - 1
      - - 2
  - []
`)
		expect(readBack({ list: [{ a: 1, b: [1, [2]] }, [], [[]], [{}]] })).toEqual(
			jsonTwice({ list: [{ a: 1, b: [1, [2]] }, [], [[]], [{}]] }),
		)
	})

	// v0: 7a95770991
	// v0: 0399ce37b6
	it("normalizes through JSON: an undefined key is skipped, a Date is its ISO string, NaN and Infinity are null", () => {
		expect([
			toYaml({ a: 1, b: undefined }),
			toYaml({ info: { description: undefined, title: "t" } }),
			toYaml({ d: new Date("2026-01-02T03:04:05.000Z") }),
			toYaml([Number.NaN, Number.POSITIVE_INFINITY]),
		]).toEqual(["a: 1\n", "info:\n  title: t\n", 'd: "2026-01-02T03:04:05.000Z"\n', "- null\n- null\n"])
	})
})

describe("toYaml: what a YAML reader reads back", () => {
	// v0: f960cec7a1
	it("quotes every string a reader could read differently, as a value, a key and a list item", () => {
		const risky = [
			'"leading quote',
			"trailing colon:",
			"~",
			".inf",
			".nan",
			"-.inf",
			"y",
			"n",
			"Yes",
			"OFF",
			"null",
			"1:20",
			"0x1f",
			"0o17",
			"1e3",
			"- dash",
			"? q",
			"a # comment",
			"a: b",
			"tab\there",
			"bell\u0007",
			"del\u007f",
			"c1\u0085\u0090",
			"bom﻿",
			"line sep",
			" lead",
			"trail ",
			"@at",
			"`tick",
			"%pct",
			"!tag",
			"&anchor",
			"*alias",
			"|pipe",
			">fold",
			"{flow",
			"[flow",
			"'single",
			"#hash",
			"",
			"unicode é ✓ 🍯",
		]
		for (const s of risky)
			expect(readBack({ k: s, [s]: "v", list: [s] })).toEqual(jsonTwice({ k: s, [s]: "v", list: [s] }))
	})

	// v0: 406c04dbb2
	it("reads an OpenAPI-shaped document back whole: multi-line text, quotes, # and : included", () => {
		const document = {
			components: { schemas: { User: { properties: { "x-id": { type: "string" } }, type: "object" } } },
			info: { description: "Multi\nline: with # and 'quotes' and \"doubles\"", title: "API: v2" },
			paths: { "/users/{id}": { get: { parameters: [{ in: "path", name: "id" }], responses: {} } } },
		}
		expect(readBack(document)).toEqual(jsonTwice(document))
	})
})
