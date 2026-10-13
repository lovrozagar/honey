import { describe, expect, expectTypeOf, it } from "vitest"
import { generateOpenApi } from "../../../src/codegen.ts"
import { honey } from "../../../src/index.ts"
import type { OpenApiMeta } from "../../../src/types.ts"

/* T2 — Meta → x-mcp serializer. Mirrors invalidate-meta.test.ts structure.
 * RED until codegen.ts emits `x-mcp: true` when meta.mcp === true and
 * OpenApiMeta gains `mcp?: boolean` field. */

/* ---- T2.1 meta.mcp: true → operation["x-mcp"] === true ---- */
describe('T2.1 meta.mcp: true → operation["x-mcp"] === true', () => {
	it("emits x-mcp: true on OpenAPI operation when meta.mcp === true", async () => {
		const app = honey()
			.post("/x")
			.meta({ mcp: true })
			.handler((c) => c.res.text("ok", "ok"))

		const spec = await generateOpenApi(app, {
			info: { title: "Test", version: "1" },
		})
		const operation = spec.paths["/x"].post as Record<string, unknown>
		expect(operation["x-mcp"]).toBe(true)
	})
})

/* ---- T2.2 meta without mcp → no x-mcp key ---- */
describe("T2.2 meta without mcp → no x-mcp key", () => {
	it("does NOT emit x-mcp when meta has no mcp field", async () => {
		const app = honey()
			.post("/x")
			.meta({ summary: "Create" })
			.handler((c) => c.res.text("ok", "ok"))

		const spec = await generateOpenApi(app, {
			info: { title: "Test", version: "1" },
		})
		const operation = spec.paths["/x"].post as Record<string, unknown>
		expect("x-mcp" in operation).toBe(false)
	})
})

/* ---- T2.3 meta.mcp: false → no x-mcp key ---- */
describe("T2.3 meta.mcp: false → no x-mcp key", () => {
	it("explicit false omits x-mcp entirely (not x-mcp: false)", async () => {
		const app = honey()
			.post("/x")
			.meta({ mcp: false })
			.handler((c) => c.res.text("ok", "ok"))

		const spec = await generateOpenApi(app, {
			info: { title: "Test", version: "1" },
		})
		const operation = spec.paths["/x"].post as Record<string, unknown>
		expect("x-mcp" in operation).toBe(false)
	})
})

/* ---- T2.4 OpenApiMeta accepts mcp field ---- */
describe("T2.4 OpenApiMeta accepts mcp field", () => {
	it("OpenApiMeta has mcp property typed as boolean | undefined", () => {
		expectTypeOf<OpenApiMeta>().toHaveProperty("mcp")
		expectTypeOf<OpenApiMeta["mcp"]>().toEqualTypeOf<boolean | undefined>()
	})
})
