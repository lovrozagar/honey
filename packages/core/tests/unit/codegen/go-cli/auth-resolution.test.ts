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

/* ── Tier 9: auth + config resolution ──
 * Assertions target emitted STATIC Go source from cli-go/ runtime dir.
 * Source-level `contains` checks — actual Go behavior covered by compile.test.ts.
 */

describe("go-cli codegen — Tier 9: auth resolution", () => {
	const crudSpec = loadFixture("crud")

	it("[#55] cli-go/config.go contains precedence-order comment documenting steps 1-5", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const config = pickRuntime(result.files, "config.go")
		expect(config).toMatch(/1\.\s*--?api[-_]?key|flag.*first/i)
		expect(config).toMatch(/XDG_CONFIG_HOME/i)
	})

	it("[#56] LoadConfig reads --api-key first: source contains `if flags.Changed(\"api-key\")`", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const config = pickRuntime(result.files, "config.go")
		expect(config).toContain(`flags.Changed("api-key")`)
	})

	it("[#57] env-var fallback uses envPrefix+\"_API_KEY\" via os.Getenv", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const config = pickRuntime(result.files, "config.go")
		expect(config).toMatch(/os\.Getenv\([^)]*envPrefix[^)]*"_API_KEY"/)
	})

	it("[#58] TOML file path derived from os.UserConfigDir() + configName", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const config = pickRuntime(result.files, "config.go")
		expect(config).toContain("os.UserConfigDir()")
		expect(config).toContain("configName")
	})

	it("[#59] XDG_CONFIG_HOME env var is checked before os.UserConfigDir()", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const config = pickRuntime(result.files, "config.go")
		const xdgIdx = config.indexOf("XDG_CONFIG_HOME")
		const userCfgIdx = config.indexOf("os.UserConfigDir()")
		expect(xdgIdx).toBeGreaterThanOrEqual(0)
		expect(userCfgIdx).toBeGreaterThanOrEqual(0)
		expect(xdgIdx).toBeLessThan(userCfgIdx)
	})

	it("[#60] missing api-key returns sentinel ErrMissingAPIKey", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const auth = pickRuntime(result.files, "auth.go")
		expect(auth).toContain("ErrMissingAPIKey")
		expect(auth).toMatch(/var\s+ErrMissingAPIKey\s*=\s*errors\.New\(|errors\.New\(/)
	})

	it("[#61] --config flag overrides all other config paths", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const config = pickRuntime(result.files, "config.go")
		expect(config).toContain(`flags.Changed("config")`)
	})

	it("[#62] empty-string env var treated as unset (falls through)", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const config = pickRuntime(result.files, "config.go")
		expect(config).toMatch(/!=\s*""|len\([^)]+\)\s*>\s*0/)
	})
})
