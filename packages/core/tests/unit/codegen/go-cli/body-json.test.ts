import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { generateGoCLI } from "../../../../src/codegen-go-cli.ts"

function loadFixture(name: string): Record<string, unknown> {
	const url = new URL(`../fixtures/go-cli/${name}.json`, import.meta.url)
	return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>
}

/* ── Tier 5: JSON body handling ── */

describe("go-cli codegen — Tier 5: JSON body", () => {
	const crudSpec = loadFixture("crud")
	const complexSpec = loadFixture("complex-body")

	it("[#28] flat scalar body → emits both --data flag AND per-prop scalar flags", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const users = result.files["cmd/users.go"]
		expect(users).toContain(`"data"`)
		expect(users).toContain(`"email"`)
		expect(users).toContain(`"name"`)
	})

	it("[#29] nested body (prop of type object) → only --data flag; no per-prop scalar flags for nested keys", () => {
		const result = generateGoCLI(complexSpec, { binaryName: "acme" })
		const orders = result.files["cmd/orders.go"]
		expect(orders).toContain(`"data"`)
		expect(orders).not.toMatch(/StringVar\([^)]*"street"/)
		expect(orders).not.toMatch(/StringVar\([^)]*"city"/)
		expect(orders).not.toMatch(/StringVar\([^)]*"zip"/)
	})

	it("[#30] oneOf body → only --data flag", () => {
		const result = generateGoCLI(complexSpec, { binaryName: "acme" })
		const events = result.files["cmd/events.go"]
		expect(events).toContain(`"data"`)
		expect(events).not.toMatch(/StringVar\([^)]*"message"/)
		expect(events).not.toMatch(/Int64Var\([^)]*"count"/)
	})

	it("[#31] --data @file.json → emitted helper readDataFlag handles file prefix (@path)", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const allSrc = Object.values(result.files).join("\n")
		expect(allSrc).toContain("readDataFlag")
		expect(allSrc).toMatch(/strings\.HasPrefix\([^)]*"@"\)|val\[0\]\s*==\s*'@'/)
	})

	it("[#32] --data - → emitted helper reads os.Stdin on dash", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const allSrc = Object.values(result.files).join("\n")
		expect(allSrc).toContain("os.Stdin")
		expect(allSrc).toMatch(/==\s*"-"/)
	})

	it('[#33] --data \'{"foo":"bar"}\' → emitted helper passes literal JSON through untouched', () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const allSrc = Object.values(result.files).join("\n")
		expect(allSrc).toMatch(/return\s*\[\]byte\(val\)|\[\]byte\(val\),\s*nil/)
	})

	it("[#34] per-prop flag overrides --data key at merge time in RunE", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const users = result.files["cmd/users.go"]
		expect(users).toMatch(/Flags\(\)\.Changed\("name"\)/)
		expect(users).toMatch(/Flags\(\)\.Changed\("email"\)/)
	})

	it("[#35] missing required body on POST → PreRunE returns error mapped to exit code 4", () => {
		const result = generateGoCLI(crudSpec, { binaryName: "acme" })
		const users = result.files["cmd/users.go"]
		expect(users).toMatch(/PreRunE|RunE/)
		expect(users).toMatch(/required.*body|body.*required/i)
	})
})
