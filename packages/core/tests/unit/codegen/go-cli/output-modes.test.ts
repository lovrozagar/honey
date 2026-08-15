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

/* ── Tier 10: output modes ── */

describe("go-cli codegen — Tier 10: output modes", () => {
	const crudSpec = loadFixture("crud")

	it("[#63] default mode is json pretty (2-space indent via json.MarshalIndent)", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const output = pickRuntime(result.files, "output.go")
		expect(output).toContain("MarshalIndent")
		expect(output).toMatch(/"  "|'\s\s'/)
	})

	it("[#64] --output=ndjson → compact single-line json + trailing \\n", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const output = pickRuntime(result.files, "output.go")
		expect(output).toContain("ndjson")
		expect(output).toMatch(/json\.Marshal\(|Encoder/)
	})

	it("[#65] --output=yaml → sigs.k8s.io/yaml marshal", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const output = pickRuntime(result.files, "output.go")
		expect(output).toContain("sigs.k8s.io/yaml")
	})

	it("[#66] --output=table on array-of-objects → text/tabwriter aligned columns", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const output = pickRuntime(result.files, "output.go")
		expect(output).toContain("text/tabwriter")
	})

	it("[#67] --output=table on primitive value → writes raw value", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const output = pickRuntime(result.files, "output.go")
		expect(output).toMatch(/fmt\.Fprint(ln)?\(w\s*,\s*data\s*\)|fmt\.Fprint\(w,\s*v\)/)
	})

	it("[#68] unknown --output=xml → exit code 4 with validation error listing allowed modes", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const output = pickRuntime(result.files, "output.go")
		expect(output).toMatch(/unknown output mode|invalid output|unsupported output/i)
		expect(output).toMatch(/json.*ndjson.*yaml.*table|json,\s*ndjson,\s*yaml,\s*table/)
	})

	it("[#69] 204 No Content responses emit no body and return nil (exit 0)", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const users = result.files["cmd/users.go"]
		expect(users).toMatch(/204|NoContent|StatusNoContent/)
	})
})
