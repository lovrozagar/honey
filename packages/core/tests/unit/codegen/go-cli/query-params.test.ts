import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { generateGoCLI } from "../../../../src/codegen-go-cli.ts"

function loadFixture(name: string): Record<string, unknown> {
	const url = new URL(`../fixtures/go-cli/${name}.json`, import.meta.url)
	return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>
}

/* ── Tier 3: query params → typed cobra flags ── */

describe("go-cli codegen — Tier 3: query params", () => {
	const querySpec = loadFixture("query-params")

	it("[#15] string query param → StringVar", () => {
		const result = generateGoCLI(querySpec, { binaryName: "acme" })
		const search = result.files["cmd/search.go"]
		expect(search).toContain("StringVar")
		expect(search).toContain(`"q"`)
	})

	it("[#16] integer query param → Int64Var", () => {
		const result = generateGoCLI(querySpec, { binaryName: "acme" })
		const search = result.files["cmd/search.go"]
		expect(search).toContain("Int64Var")
		expect(search).toContain(`"limit"`)
	})

	it("[#17] boolean query param → BoolVar", () => {
		const result = generateGoCLI(querySpec, { binaryName: "acme" })
		const search = result.files["cmd/search.go"]
		expect(search).toContain("BoolVar")
		expect(search).toContain(`"include-archived"`)
	})

	it("[#18] number query param → Float64Var", () => {
		const result = generateGoCLI(querySpec, { binaryName: "acme" })
		const search = result.files["cmd/search.go"]
		expect(search).toContain("Float64Var")
		expect(search).toContain(`"score-min"`)
	})

	it("[#19] array-of-strings → StringSliceVar (repeatable)", () => {
		const result = generateGoCLI(querySpec, { binaryName: "acme" })
		const search = result.files["cmd/search.go"]
		expect(search).toContain("StringSliceVar")
		expect(search).toContain(`"tag"`)
	})

	it("[#20] required query param → MarkFlagRequired", () => {
		const result = generateGoCLI(querySpec, { binaryName: "acme" })
		const search = result.files["cmd/search.go"]
		expect(search).toContain(`MarkFlagRequired("q")`)
	})

	it("[#21] optional param not included in URL unless Flags().Changed(name) is true", () => {
		const result = generateGoCLI(querySpec, { binaryName: "acme" })
		const search = result.files["cmd/search.go"]
		expect(search).toMatch(/Flags\(\)\.Changed\("limit"\)/)
		expect(search).toMatch(/Flags\(\)\.Changed\("tag"\)/)
	})

	it("[#22] OpenAPI schema.default becomes the 3rd argument of *Var call (e.g. limit default 20)", () => {
		const result = generateGoCLI(querySpec, { binaryName: "acme" })
		const search = result.files["cmd/search.go"]
		expect(search).toMatch(/Int64Var\([^)]*"limit"[^)]*,\s*20\b/)
	})
})
