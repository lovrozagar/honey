import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { generateApiRef, type Lang } from "../../../scripts/gen-api-ref.ts"
import { toIR } from "../../../src/codegen-ir.ts"
import type { OpenApiSpecInput } from "../../../src/codegen.ts"

const specPath = fileURLToPath(new URL("../../mock-server/spec.json", import.meta.url))
const spec = JSON.parse(readFileSync(specPath, "utf8")) as OpenApiSpecInput

const LANGS: Lang[] = ["typescript", "python", "go", "rust"]

/** Mirrors the naming rules inside gen-api-ref.ts so we can assert presence. */
function toSnake(s: string): string {
	return s
		.replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replaceAll(/[-.\s]+/g, "_")
		.toLowerCase()
}

function toPascal(s: string): string {
	return s
		.replaceAll(/[-_.\s]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""))
		.replace(/^(.)/, (m) => m.toUpperCase())
}

function expectedName(lang: Lang, operationId: string): string {
	if (lang === "typescript") return operationId
	if (lang === "python" || lang === "rust") return toSnake(operationId)
	return toPascal(operationId)
}

describe("gen-api-ref", () => {
	it("emits one markdown file per lang", () => {
		const out = generateApiRef(spec)
		expect(Object.keys(out).sort()).toEqual([...LANGS].sort())
		for (const lang of LANGS) {
			expect(out[lang].startsWith(`# `)).toBe(true)
			expect(out[lang].length).toBeGreaterThan(200)
		}
	})

	it("covers every operation in the spec", () => {
		const out = generateApiRef(spec)
		const ir = toIR(spec)
		expect(ir.operations.length).toBeGreaterThan(0)
		for (const lang of LANGS) {
			const text = out[lang]
			for (const op of ir.operations) {
				const heading = `### ${expectedName(lang, op.id)}`
				expect(text, `${lang} missing ${heading}`).toContain(heading)
				expect(text, `${lang} missing method+path for ${op.id}`).toContain(
					`\`${op.method} ${op.path}\``,
				)
			}
		}
	})

	it("contains typed error hierarchy section", () => {
		const out = generateApiRef(spec)
		for (const lang of LANGS) {
			const text = out[lang]
			expect(text).toContain("## Typed Errors")
			expect(text).toContain("Unauthorized")
			expect(text).toContain("StatusError")
			expect(text).toContain("NotFound")
		}
	})
})
