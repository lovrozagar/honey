import { describe, expect, it } from "vitest"
import { jsonSchemaToTS } from "../../../src/codegen.ts"

const PHASE_I_FIXED = true

/* ═══════════════════════════════════════════════════════════════════
   Layer A — invariants that hold before AND after (always GREEN)
   ═══════════════════════════════════════════════════════════════════ */

describe("jsonSchemaToTS — Layer A invariants", () => {
	it("Layer A: { type: 'string' } -> 'string'", () => {
		expect(jsonSchemaToTS({ type: "string" })).toBe("string")
	})

	it("Layer A: { type: 'number' } -> 'number'", () => {
		expect(jsonSchemaToTS({ type: "number" })).toBe("number")
	})

	it("Layer A: { type: 'integer' } -> 'number'", () => {
		expect(jsonSchemaToTS({ type: "integer" })).toBe("number")
	})

	it("Layer A: { type: 'boolean' } -> 'boolean'", () => {
		expect(jsonSchemaToTS({ type: "boolean" })).toBe("boolean")
	})

	it("Layer A: { type: 'null' } -> 'null'", () => {
		expect(jsonSchemaToTS({ type: "null" })).toBe("null")
	})

	it("Layer A: { const: 'hello' } -> '\"hello\"' (JSON string literal)", () => {
		expect(jsonSchemaToTS({ const: "hello" })).toBe('"hello"')
	})

	it("Layer A: { const: 42 } -> '42'", () => {
		expect(jsonSchemaToTS({ const: 42 })).toBe("42")
	})

	it("Layer A: { enum: ['a', 'b'] } -> '\"a\" | \"b\"'", () => {
		expect(jsonSchemaToTS({ enum: ["a", "b"] })).toBe('"a" | "b"')
	})

	it("Layer A: { type: 'array', items: { type: 'string' } } -> 'string[]'", () => {
		expect(jsonSchemaToTS({ items: { type: "string" }, type: "array" })).toBe("string[]")
	})

	it("Layer A: { type: 'array', items: oneOf string|number } -> '(string | number)[]'", () => {
		expect(
			jsonSchemaToTS({
				items: { oneOf: [{ type: "string" }, { type: "number" }] },
				type: "array",
			}),
		).toBe("(string | number)[]")
	})

	it("Layer A: { type: 'object' } (no props) -> 'Record<string, unknown>'", () => {
		expect(jsonSchemaToTS({ type: "object" })).toBe("Record<string, unknown>")
	})

	it("Layer A: object with required prop 'a: string' -> '{ a: string }'", () => {
		expect(
			jsonSchemaToTS({
				properties: { a: { type: "string" } },
				required: ["a"],
				type: "object",
			}),
		).toBe("{ a: string }")
	})

	it("Layer A: { type: 'object', additionalProperties: { type: 'string' } } -> 'Record<string, string>'", () => {
		expect(
			jsonSchemaToTS({ additionalProperties: { type: "string" }, type: "object" }),
		).toBe("Record<string, string>")
	})

	it("Layer A: { oneOf: [string, number] } -> 'string | number'", () => {
		expect(
			jsonSchemaToTS({ oneOf: [{ type: "string" }, { type: "number" }] }),
		).toBe("string | number")
	})

	it("Layer A: allOf two objects -> result includes '&'", () => {
		const result = jsonSchemaToTS({
			allOf: [
				{ properties: { a: { type: "string" } }, type: "object" },
				{ properties: { b: { type: "number" } }, type: "object" },
			],
		})
		expect(result).toContain("&")
	})

	it("Layer A: depth > 8 returns 'unknown'", () => {
		/* depth param is the second argument; pass 9 to force the guard */
		expect(jsonSchemaToTS({ type: "string" }, 9)).toBe("unknown")
	})

	it("Layer A: undefined schema returns 'unknown'", () => {
		expect(jsonSchemaToTS(undefined)).toBe("unknown")
	})

	it("Layer A: enum with mixed string and number values -> correct union literal", () => {
		expect(jsonSchemaToTS({ enum: ["active", 1] })).toBe('"active" | 1')
	})
})

/* ═══════════════════════════════════════════════════════════════════
   Layer B — pre-fix bug witnesses (GREEN now, SKIPPED when PHASE_I_FIXED=1)
   ═══════════════════════════════════════════════════════════════════ */

describe.skipIf(PHASE_I_FIXED)("jsonSchemaToTS — Layer B bug witness", () => {
	it("Layer B pre-fix: { type: 'string', nullable: true } -> 'string' (missing | null)", () => {
		expect(jsonSchemaToTS({ nullable: true, type: "string" })).toBe("string")
	})

	it("Layer B pre-fix: { type: ['string', 'null'] } -> 'unknown' (type array not handled)", () => {
		expect(jsonSchemaToTS({ type: ["string", "null"] })).toBe("unknown")
	})

	it("Layer B pre-fix: tuple items array -> contains '[]' but NOT '[string, number]'", () => {
		const result = jsonSchemaToTS({
			items: [{ type: "string" }, { type: "number" }],
			type: "array",
		})
		expect(result).toContain("[]")
		expect(result).not.toContain("[string, number]")
	})

	it("Layer B pre-fix: addlProps with sibling props -> does NOT contain '[k: string]' index sig", () => {
		const result = jsonSchemaToTS({
			additionalProperties: { type: "number" },
			properties: { a: { type: "string" } },
		})
		expect(result).not.toContain("[k: string]")
		expect(result).toContain("a?:")
	})

	it("Layer B pre-fix: { type: 'number', nullable: true } -> 'number' (missing | null)", () => {
		expect(jsonSchemaToTS({ nullable: true, type: "number" })).toBe("number")
	})

	it("Layer B pre-fix: { type: 'boolean', nullable: true } -> 'boolean' (missing | null)", () => {
		expect(jsonSchemaToTS({ nullable: true, type: "boolean" })).toBe("boolean")
	})

	it("Layer B pre-fix: { nullable: true } (no type) -> 'unknown' (fallback, no null appended)", () => {
		expect(jsonSchemaToTS({ nullable: true })).toBe("unknown")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   Layer B' — post-fix regression (SKIPPED now, GREEN when PHASE_I_FIXED=1)
   ═══════════════════════════════════════════════════════════════════ */

describe.runIf(PHASE_I_FIXED)("jsonSchemaToTS — Layer B' regression", () => {
	it("Layer B' post-fix: { type: 'string', nullable: true } -> 'string | null'", () => {
		expect(jsonSchemaToTS({ nullable: true, type: "string" })).toBe("string | null")
	})

	it("Layer B' post-fix: { type: ['string', 'null'] } -> 'string | null'", () => {
		expect(jsonSchemaToTS({ type: ["string", "null"] })).toBe("string | null")
	})

	it("Layer B' post-fix: { type: 'array', items: [string, number] } -> '[string, number]'", () => {
		expect(
			jsonSchemaToTS({
				items: [{ type: "string" }, { type: "number" }],
				type: "array",
			}),
		).toBe("[string, number]")
	})

	it("Layer B' post-fix: addlProps with sibling props -> '{ a?: string; [k: string]: number }'", () => {
		const result = jsonSchemaToTS({
			additionalProperties: { type: "number" },
			properties: { a: { type: "string" } },
		})
		expect(result).toContain("a?: string")
		expect(result).toContain("[k: string]: number")
	})

	it("Layer B' post-fix: { type: 'array', items: [string, number], nullable: true } -> '[string, number] | null'", () => {
		expect(
			jsonSchemaToTS({
				items: [{ type: "string" }, { type: "number" }],
				nullable: true,
				type: "array",
			}),
		).toBe("[string, number] | null")
	})

	it("Layer B' post-fix: { type: 'object', additionalProperties: string, nullable: true } -> 'Record<string, string> | null'", () => {
		expect(
			jsonSchemaToTS({ additionalProperties: { type: "string" }, nullable: true, type: "object" }),
		).toBe("Record<string, string> | null")
	})

	it("Layer B' post-fix: { type: 'null' } stays 'null' (no double null appended)", () => {
		expect(jsonSchemaToTS({ type: "null" })).toBe("null")
	})

	it("Layer B' post-fix: { nullable: true } (no type) -> 'unknown | null'", () => {
		expect(jsonSchemaToTS({ nullable: true })).toBe("unknown | null")
	})

	it("Layer B' post-fix: { type: ['number', 'string', 'null'] } -> 'number | string | null'", () => {
		expect(jsonSchemaToTS({ type: ["number", "string", "null"] })).toBe("number | string | null")
	})

	it("Layer B' post-fix: { type: 'number', nullable: true } -> 'number | null'", () => {
		expect(jsonSchemaToTS({ nullable: true, type: "number" })).toBe("number | null")
	})

	it("Layer B' post-fix: { type: 'boolean', nullable: true } -> 'boolean | null'", () => {
		expect(jsonSchemaToTS({ nullable: true, type: "boolean" })).toBe("boolean | null")
	})
})
