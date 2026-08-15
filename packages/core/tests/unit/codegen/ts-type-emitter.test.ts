import { describe, expect, it } from "vitest"
import { schemaToIR } from "../../../src/codegen-ir.ts"
import { jsonSchemaToTS } from "../../../src/codegen.ts"
import { irToTs } from "../../../src/ts-type-emitter.ts"

/**
 * Every assertion proves: irToTs(schemaToIR(input)) === jsonSchemaToTS(input)
 * covering all IRSchema kinds reachable from schemaToIR.
 */
function eq(schema: Record<string, unknown> | undefined): void {
	expect(irToTs(schemaToIR(schema))).toBe(jsonSchemaToTS(schema))
}

describe("irToTs — equivalence with jsonSchemaToTS (Layer A inputs)", () => {
	it("undefined → 'unknown'", () => {
		expect(irToTs(schemaToIR(undefined))).toBe("unknown")
		eq(undefined)
	})

	it("depth > 8 guard → 'unknown'", () => {
		expect(irToTs({ kind: "unknown" }, 9)).toBe("unknown")
	})

	it("{ type: 'string' } → 'string'", () => eq({ type: "string" }))

	it("{ type: 'number' } → 'number'", () => eq({ type: "number" }))

	it("{ type: 'integer' } → 'number'", () => eq({ type: "integer" }))

	it("{ type: 'boolean' } → 'boolean'", () => eq({ type: "boolean" }))

	it("{ type: 'null' } → 'null'", () => eq({ type: "null" }))

	it("{ const: 'hello' } → '\"hello\"'", () => eq({ const: "hello" }))

	it("{ const: 42 } → '42'", () => eq({ const: 42 }))

	it("{ const: true } → 'true'", () => eq({ const: true }))

	it("{ enum: ['a', 'b'] } → '\"a\" | \"b\"'", () => eq({ enum: ["a", "b"] }))

	it("{ enum: ['active', 1] } → '\"active\" | 1' (mixed enum)", () => eq({ enum: ["active", 1] }))

	it("{ enum: [1, 2] } → '1 | 2' (int enum)", () => eq({ enum: [1, 2] }))

	it("{ type: 'array', items: { type: 'string' } } → 'string[]'", () =>
		eq({ items: { type: "string" }, type: "array" }))

	it("{ type: 'array', items: oneOf string|number } → '(string | number)[]'", () =>
		eq({ items: { oneOf: [{ type: "string" }, { type: "number" }] }, type: "array" }))

	it("{ type: 'object' } (no props) → 'Record<string, unknown>'", () => eq({ type: "object" }))

	it("object with required prop 'a: string' → '{ a: string }'", () =>
		eq({ properties: { a: { type: "string" } }, required: ["a"], type: "object" }))

	it("object with optional prop → '{ a?: string }'", () =>
		eq({ properties: { a: { type: "string" } }, type: "object" }))

	it("{ additionalProperties: { type: 'string' } } → 'Record<string, string>'", () =>
		eq({ additionalProperties: { type: "string" }, type: "object" }))

	it("{ oneOf: [string, number] } → 'string | number'", () => eq({ oneOf: [{ type: "string" }, { type: "number" }] }))

	it("{ anyOf: [string, number] } → 'string | number'", () => eq({ anyOf: [{ type: "string" }, { type: "number" }] }))

	it("allOf two objects → contains '&'", () => {
		const input = {
			allOf: [
				{ properties: { a: { type: "string" } }, type: "object" },
				{ properties: { b: { type: "number" } }, type: "object" },
			],
		}
		expect(irToTs(schemaToIR(input))).toContain("&")
		eq(input)
	})

	it("{ $ref: '#/components/schemas/Foo' } → 'Foo'", () => {
		/*
		 * jsonSchemaToTS does not handle $ref — returns "unknown".
		 * schemaToIR correctly resolves $ref → {kind: "ref", name: "Foo"}.
		 * No eq() here: irToTs is strictly better; equivalence only covers
		 * cases where both functions agree on the raw schema input.
		 */
		expect(irToTs(schemaToIR({ $ref: "#/components/schemas/Foo" }))).toBe("Foo")
	})

	it("object keys sorted alphabetically", () => {
		/* Keys intentionally in reverse-alpha order to prove the printer sorts them. */
		const input = {
			properties: { z: { type: "string" }, a: { type: "number" }, m: { type: "boolean" } }, // oxlint-disable-line sort-keys
			required: ["z", "a", "m"],
			type: "object",
		}
		const result = irToTs(schemaToIR(input))
		const aPos = result.indexOf("a:")
		const mPos = result.indexOf("m:")
		const zPos = result.indexOf("z:")
		expect(aPos).toBeLessThan(mPos)
		expect(mPos).toBeLessThan(zPos)
		eq(input)
	})

	it("nested object depth", () => {
		const input = {
			properties: {
				inner: { properties: { x: { type: "string" } }, required: ["x"], type: "object" },
			},
			required: ["inner"],
			type: "object",
		}
		eq(input)
	})

	it("array of objects → '{ ... }[]'", () => {
		const input = {
			items: { properties: { id: { type: "number" } }, required: ["id"], type: "object" },
			type: "array",
		}
		eq(input)
	})

	it("{ type: 'string', format: 'binary' } → 'string' (binary kind falls back to string)", () => {
		const input = { format: "binary", type: "string" }
		/*
		 * schemaToIR converts this to {kind: "binary"}.
		 * jsonSchemaToTS hits effectiveType "string" → returns "string".
		 * irToTs must match: binary kind → "string".
		 */
		expect(irToTs(schemaToIR(input))).toBe("string")
		eq(input)
	})

	it("no-type schema → 'unknown'", () => eq({}))

	it("reserved-word key gets JSON.stringify quoting", () => {
		const input = {
			properties: { "content-type": { type: "string" } },
			required: ["content-type"],
			type: "object",
		}
		const result = irToTs(schemaToIR(input))
		expect(result).toContain('"content-type"')
		eq(input)
	})

	it("object with additional props alongside named fields", () => {
		const input = {
			additionalProperties: { type: "number" },
			properties: { a: { type: "string" } },
			type: "object",
		}
		eq(input)
	})

	it("nullable via anyOf with null variant", () => {
		const input = { anyOf: [{ type: "string" }, { type: "null" }] }
		eq(input)
	})

	it("nullable via oneOf with null variant", () => {
		const input = { oneOf: [{ type: "number" }, { type: "null" }] }
		eq(input)
	})

	it("tuple — array of items schemas", () => {
		const input = { items: [{ type: "string" }, { type: "number" }], type: "array" }
		/*
		 * jsonSchemaToTS currently has a Layer B bug: treats items array as single-item array,
		 * so it emits "unknown[]" rather than "[string, number]".
		 * schemaToIR correctly converts to {kind: "tuple"} → irToTs returns "[string, number]".
		 * The two differ. We assert irToTs behavior only — no eq() call here.
		 */
		expect(irToTs(schemaToIR(input))).toBe("[string, number]")
	})

	it("multi-type [string, number] → 'string | number' (IR amendment)", () => {
		/*
		 * schemaToIR now maps type arrays without null to {kind:"union"}.
		 * jsonSchemaToTS returns "unknown" for this input (not yet ported).
		 * No eq() — irToTs is strictly better; divergence is intentional.
		 */
		expect(irToTs(schemaToIR({ type: ["string", "number"] }))).toBe("string | number")
	})

	it("multi-type [string, number, null] → 'string | number | null' (IR amendment)", () => {
		/* nullable path strips null, multi-type branch emits union, nullable wraps */
		expect(irToTs(schemaToIR({ type: ["string", "number", "null"] }))).toBe("string | number | null")
	})
})
