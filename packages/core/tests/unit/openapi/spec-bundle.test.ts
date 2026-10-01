import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../../src")

describe("openapi spec isolate graph", () => {
	it("spec.ts and document.ts do not import codegen", () => {
		const spec = readFileSync(join(SRC, "openapi/spec.ts"), "utf8")
		const document = readFileSync(join(SRC, "openapi/document.ts"), "utf8")
		expect(spec).not.toMatch(/codegen/)
		expect(document).not.toMatch(/codegen/)
	})

	it("bundled spec entry excludes codegen converters", async () => {
		const { build } = await import("esbuild")
		const result = await build({
			bundle: true,
			entryPoints: [join(SRC, "openapi/spec.ts")],
			format: "esm",
			logLevel: "silent",
			platform: "neutral",
			write: false,
		})
		const text = result.outputFiles.map((file) => file.text).join("\n")
		expect(text).toContain("generateOpenApiFromTree")
		expect(text).not.toContain("valibotToJsonSchema")
		expect(text).not.toContain("generateSDK")
		expect(text).not.toContain("[honey:codegen]")
	})
})
