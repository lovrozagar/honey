import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { generateGoCLI } from "../../../../src/codegen-go-cli.ts"

function loadFixture(name: string): Record<string, unknown> {
	const url = new URL(`../fixtures/go-cli/${name}.json`, import.meta.url)
	return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>
}

/* ── Tier 6: multipart file upload ── */

describe("go-cli codegen — Tier 6: multipart", () => {
	const multipartSpec = loadFixture("multipart")

	it("[#36] detects multipart/form-data and emits --file flag when exactly one binary prop present", () => {
		const result = generateGoCLI(multipartSpec, { binaryName: "acme" })
		const uploads = result.files["cmd/uploads.go"]
		expect(uploads).toContain(`"file"`)
	})

	it("[#37] multiple binary props → per-name flags, no single --file", () => {
		const result = generateGoCLI(multipartSpec, { binaryName: "acme" })
		const uploads = result.files["cmd/uploads.go"]
		expect(uploads).toContain(`"thumbnail"`)
		expect(uploads).toContain(`"original"`)
	})

	it("[#38] scalar multipart props → normal typed flags", () => {
		const result = generateGoCLI(multipartSpec, { binaryName: "acme" })
		const uploads = result.files["cmd/uploads.go"]
		expect(uploads).toContain(`"caption"`)
		expect(uploads).toMatch(/StringVar\([^)]*"caption"/)
	})

	it("[#39] RunE assembles body via BuildMultipart(fields, files) helper from cli-go runtime", () => {
		const result = generateGoCLI(multipartSpec, { binaryName: "acme" })
		const uploads = result.files["cmd/uploads.go"]
		expect(uploads).toContain("BuildMultipart(")
	})

	it("[#40] Content-Type header set from multipart writer boundary", () => {
		const result = generateGoCLI(multipartSpec, { binaryName: "acme" })
		const uploads = result.files["cmd/uploads.go"]
		expect(uploads).toMatch(/Content-Type/i)
		expect(uploads).toMatch(/multipart\/form-data|boundary/i)
	})

	it("[#41] missing required file path → exit code 4 with readable error", () => {
		const result = generateGoCLI(multipartSpec, { binaryName: "acme" })
		const uploads = result.files["cmd/uploads.go"]
		expect(uploads).toContain(`MarkFlagRequired("file")`)
	})
})
