import { createRequire } from "node:module"
import { describe, expect, it } from "vitest"
import { toYaml, yamlSiblingPath } from "../../../src/yaml.ts"

const jsYaml = createRequire(import.meta.url)("js-yaml") as {
	CORE_SCHEMA: unknown
	load(text: string, opts?: { schema?: unknown }): unknown
}

/** Round-trip through a YAML parser and compare with the JSON view of the input. */
function expectRoundTrip(value: unknown): void {
	const json: unknown = JSON.parse(JSON.stringify(value) ?? "null")
	expect(jsYaml.load(toYaml(value))).toEqual(json)
	expect(jsYaml.load(toYaml(value), { schema: jsYaml.CORE_SCHEMA })).toEqual(json)
}

describe("yamlSiblingPath", () => {
	it("swaps .json for .yaml", () => {
		expect(yamlSiblingPath("src/_gen/openapi.gen.json")).toBe("src/_gen/openapi.gen.yaml")
	})

	it("appends .yaml when the path has no .json suffix", () => {
		expect(yamlSiblingPath("docs/openapi")).toBe("docs/openapi.yaml")
	})

	it("normalizes a .yml sibling to .yaml", () => {
		expect(yamlSiblingPath("src/_gen/openapi.gen.yml")).toBe("src/_gen/openapi.gen.yaml")
	})
})

describe("toYaml", () => {
	it("emits scalars", () => {
		expect(toYaml(null)).toBe("null\n")
		expect(toYaml(true)).toBe("true\n")
		expect(toYaml(3.14)).toBe("3.14\n")
		expect(toYaml("hello")).toBe("hello\n")
	})

	it("quotes strings that would be misread", () => {
		expect(toYaml("true")).toBe('"true"\n')
		expect(toYaml("01")).toBe('"01"\n')
		expect(toYaml("a: b")).toBe('"a: b"\n')
		expect(toYaml("")).toBe('""\n')
	})

	it("emits empty collections", () => {
		expect(toYaml([])).toBe("[]\n")
		expect(toYaml({})).toBe("{}\n")
	})

	it("emits nested OpenAPI-shaped objects", () => {
		const spec = {
			info: { title: "Demo", version: "1.0.0" },
			openapi: "3.1.0",
			paths: {
				"/api/health": {
					get: {
						responses: {
							"200": {
								content: {
									"application/json": {
										schema: { type: "object" },
									},
								},
								description: "ok",
							},
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

describe("toYaml — JSON equivalence", () => {
	// regression: M (src/yaml.ts:15,33-42)
	it("skips undefined keys instead of emitting null", () => {
		expect(toYaml({ a: 1, b: undefined })).toBe("a: 1\n")
		expect(toYaml({ info: { description: undefined, title: "t" } })).toBe("info:\n  title: t\n")
	})

	// regression: M (src/yaml.ts:15,33-42)
	it("Date becomes its ISO string; NaN and Infinity become null", () => {
		const date = new Date("2026-01-02T03:04:05.000Z")
		expect(toYaml({ d: date })).toBe('d: "2026-01-02T03:04:05.000Z"\n')
		expect(toYaml([Number.NaN, Number.POSITIVE_INFINITY])).toBe("- null\n- null\n")
	})

	// regression: M (src/yaml.ts:15,33-42)
	it("quotes every string a parser could read differently", () => {
		for (const s of [
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
			"bom\ufeff",
			"line\u2028sep",
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
		]) {
			expectRoundTrip({ k: s, [s]: "v", list: [s] })
		}
	})

	it("round-trips an OpenAPI-shaped document", () => {
		expectRoundTrip({
			components: { schemas: { User: { properties: { "x-id": { type: "string" } }, type: "object" } } },
			info: { description: "Multi\nline: with # and 'quotes' and \"doubles\"", title: "API: v2" },
			paths: { "/users/{id}": { get: { parameters: [{ in: "path", name: "id" }], responses: {} } } },
		})
	})
})
