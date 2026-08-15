import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { generateGoCLI } from "../../../../src/codegen-go-cli.ts"

function loadFixture(name: string): Record<string, unknown> {
	const url = new URL(`../fixtures/go-cli/${name}.json`, import.meta.url)
	return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>
}

function pickRuntime(files: Record<string, string>, name: string): string {
	return files[`cli-go/${name}`] ?? files[`internal/cli/${name}`] ?? ""
}

/* ── Tier 12: exit codes ── */

describe("go-cli codegen — Tier 12: exit codes", () => {
	const crudSpec = loadFixture("crud")

	it("[#75] cli-go/errors.go contains ExitFor switch mapping 4xx→1, 5xx→2, ctx→3, auth→4", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const errs = pickRuntime(result.files, "errors.go")
		expect(errs).toContain("func ExitFor(")
		expect(errs).toMatch(/return\s+1/)
		expect(errs).toMatch(/return\s+2/)
		expect(errs).toMatch(/context\.DeadlineExceeded/)
		expect(errs).toContain("ErrMissingAPIKey")
	})

	it("[#76] main.go calls cli.ExitFor(err) + os.Exit on top-level error", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const main = result.files["main.go"]
		expect(main).toContain("ExitFor(")
		expect(main).toContain("os.Exit(")
	})

	it("[#77] ExitFor switch covers 3xx unexpected → exit code 5", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const errs = pickRuntime(result.files, "errors.go")
		expect(errs).toMatch(/return\s+5/)
	})

	it("[#78] nil error → return 0", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const errs = pickRuntime(result.files, "errors.go")
		expect(errs).toMatch(/if\s+err\s*==\s*nil/)
		expect(errs).toMatch(/return\s+0/)
	})

	it("[#79] *sdk.StatusError with Status=0 → exit 3 (network failure category)", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const errs = pickRuntime(result.files, "errors.go")
		expect(errs).toMatch(/Status\s*\(\)\s*==\s*0|status\s*==\s*0/)
		expect(errs).toMatch(/return\s+3/)
	})

	it("[#80] wrapped errors unwrapped via errors.As", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const errs = pickRuntime(result.files, "errors.go")
		expect(errs).toContain("errors.As")
	})
})
