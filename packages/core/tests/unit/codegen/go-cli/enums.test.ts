import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { generateGoCLI } from "../../../../src/codegen-go-cli.ts"

function loadFixture(name: string): Record<string, unknown> {
	const url = new URL(`../fixtures/go-cli/${name}.json`, import.meta.url)
	return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>
}

/* ── Tier 4: enums ── */

describe("go-cli codegen — Tier 4: enums", () => {
	const enumsSpec = loadFixture("enums")

	it("[#23] enum query param flag usage/help shows \"one of: active, archived\"", () => {
		const result = generateGoCLI(enumsSpec, { binaryName: "acme" })
		const posts = result.files["cmd/posts.go"]
		expect(posts).toMatch(/one of:\s*active,\s*archived/)
	})

	it("[#24] enum query param has PreRunE slices.Contains validation", () => {
		const result = generateGoCLI(enumsSpec, { binaryName: "acme" })
		const posts = result.files["cmd/posts.go"]
		expect(posts).toContain("PreRunE")
		expect(posts).toContain("slices.Contains")
		expect(posts).toContain(`"active"`)
		expect(posts).toContain(`"archived"`)
	})

	it("[#25] enum body field in flat JSON body → same PreRunE slices.Contains validation", () => {
		const result = generateGoCLI(enumsSpec, { binaryName: "acme" })
		const posts = result.files["cmd/posts.go"]
		expect(posts).toContain(`"free"`)
		expect(posts).toContain(`"pro"`)
		expect(posts).toMatch(/slices\.Contains\([^)]*"free"[^)]*"pro"/)
	})

	it("[#26] enum inside nested body (complex) → no codegen validation; allowed values listed in help text only", () => {
		const spec = {
			openapi: "3.1.0",
			info: { title: "T", version: "1.0.0" },
			paths: {
				"/widgets": {
					post: {
						operationId: "widgets.create",
						requestBody: {
							required: true,
							content: {
								"application/json": {
									schema: {
										type: "object",
										required: ["nested"],
										properties: {
											nested: {
												type: "object",
												properties: {
													mode: { type: "string", enum: ["a", "b"] },
												},
											},
										},
									},
								},
							},
						},
						responses: { "200": { description: "OK" } },
					},
				},
			},
		}
		const result = generateGoCLI(spec, { binaryName: "acme" })
		const widgets = result.files["cmd/widgets.go"]
		expect(widgets).not.toMatch(/slices\.Contains\([^)]*"a"[^)]*"b"/)
	})

	it("[#27] empty enum array in spec → no validation emitted; generator does not panic", () => {
		const result = generateGoCLI(enumsSpec, { binaryName: "acme" })
		const posts = result.files["cmd/posts.go"]
		expect(posts).not.toMatch(/slices\.Contains\(\s*\[\]string\{\s*\},\s*tag\s*\)/)
	})
})
