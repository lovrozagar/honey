import { describe, expect, it } from "vitest"
import { toYaml, yamlSiblingPath } from "../../../src/yaml.ts"

describe("yamlSiblingPath", () => {
	it("swaps .json for .yml", () => {
		expect(yamlSiblingPath("src/_gen/openapi.gen.json")).toBe("src/_gen/openapi.gen.yml")
	})

	it("appends .yml when the path has no .json suffix", () => {
		expect(yamlSiblingPath("docs/openapi")).toBe("docs/openapi.yml")
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
