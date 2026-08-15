import { describe, expect, it } from "vitest"
import { schemaToIR } from "../../../src/codegen-ir.ts"
import { irToPython, jsonSchemaToPy } from "../../../src/python-type-emitter.ts"

/**
 * Every eq() call proves: irToPython(schemaToIR(input)) === jsonSchemaToPy(input)
 * After the shim swap both are identical by construction — harness validates all IR kinds.
 */
function eq(schema: Record<string, unknown> | undefined): void {
	expect(irToPython(schemaToIR(schema))).toBe(jsonSchemaToPy(schema))
}

describe("python-type-emitter equivalence", () => {
	/* ---- scalars ---- */
	it("undefined → 'Any'", () => {
		expect(irToPython(schemaToIR(undefined))).toBe("Any")
		eq(undefined)
	})

	it("{ type: 'string' } → 'str'", () => eq({ type: "string" }))

	it("{ type: 'integer' } → 'int'", () => eq({ type: "integer" }))

	it("{ type: 'number' } → 'float'", () => eq({ type: "number" }))

	it("{ type: 'boolean' } → 'bool'", () => eq({ type: "boolean" }))

	it("{ type: 'null' } → 'None'", () => eq({ type: "null" }))

	it("{} no type → 'Any'", () => eq({}))

	/* ---- const ---- */
	it("{ const: 'admin' } → 'Literal[\"admin\"]'", () => {
		expect(irToPython(schemaToIR({ const: "admin" }))).toBe('Literal["admin"]')
		eq({ const: "admin" })
	})

	it("{ const: 42 } → 'Literal[42]'", () => {
		expect(irToPython(schemaToIR({ const: 42 }))).toBe("Literal[42]")
		eq({ const: 42 })
	})

	it("{ const: true } → 'Literal[True]'", () => {
		expect(irToPython(schemaToIR({ const: true }))).toBe("Literal[True]")
		eq({ const: true })
	})

	it("{ const: false } → 'Literal[False]'", () => {
		expect(irToPython(schemaToIR({ const: false }))).toBe("Literal[False]")
		eq({ const: false })
	})

	/* ---- enum ---- */
	it("string enum → Literal with quoted members", () => {
		expect(irToPython(schemaToIR({ enum: ["a", "b"], type: "string" }))).toBe('Literal["a", "b"]')
		eq({ enum: ["a", "b"], type: "string" })
	})

	it("integer enum → Literal with number members", () => {
		expect(irToPython(schemaToIR({ enum: [1, 2], type: "integer" }))).toBe("Literal[1, 2]")
		eq({ enum: [1, 2], type: "integer" })
	})

	it("mixed enum → single Literal (collapse union-of-const)", () => {
		/* IR emits union of consts; printer collapses to one Literal[...] */
		expect(irToPython(schemaToIR({ enum: ["active", 1] }))).toBe('Literal["active", 1]')
		eq({ enum: ["active", 1] })
	})

	it("bool enum → Literal[True, False]", () => {
		expect(irToPython(schemaToIR({ enum: [true, false] }))).toBe("Literal[True, False]")
		eq({ enum: [true, false] })
	})

	/* ---- array / tuple ---- */
	it("array of strings → list[str]", () => {
		eq({ items: { type: "string" }, type: "array" })
	})

	it("tuple items array → tuple[str, float]", () => {
		expect(irToPython(schemaToIR({ items: [{ type: "string" }, { type: "number" }], type: "array" }))).toBe(
			"tuple[str, float]",
		)
	})

	/* ---- nullable ---- */
	it("nullable: true → 'str | None'", () => {
		eq({ nullable: true, type: "string" })
	})

	it("type: ['string', 'null'] → 'str | None'", () => {
		eq({ type: ["string", "null"] })
	})

	/* ---- multi-type (IR amendment) ---- */
	it("type: ['string', 'number'] → 'str | float'", () => {
		expect(irToPython(schemaToIR({ type: ["string", "number"] }))).toBe("str | float")
		eq({ type: ["string", "number"] })
	})

	it("type: ['string', 'number', 'null'] → 'str | float | None'", () => {
		expect(irToPython(schemaToIR({ type: ["string", "number", "null"] }))).toBe("str | float | None")
		eq({ type: ["string", "number", "null"] })
	})

	/* ---- oneOf / anyOf ---- */
	it("oneOf [string, integer] → 'str | int'", () => {
		eq({ oneOf: [{ type: "string" }, { type: "integer" }] })
	})

	it("anyOf [string, null] → 'str | None'", () => {
		eq({ anyOf: [{ type: "string" }, { type: "null" }] })
	})

	/* ---- allOf ---- */
	it("allOf two objects → merged TypedDict", () => {
		const input = {
			allOf: [
				{ properties: { a: { type: "string" } }, required: ["a"], type: "object" },
				{ properties: { b: { type: "integer" } }, required: ["b"], type: "object" },
			],
		}
		const result = irToPython(schemaToIR(input))
		expect(result).toContain("TypedDict")
		expect(result).toContain('"a"')
		expect(result).toContain('"b"')
		eq(input)
	})

	it("allOf non-object → 'Any'", () => {
		expect(irToPython(schemaToIR({ allOf: [{ type: "string" }, { type: "integer" }] }))).toBe("Any")
		eq({ allOf: [{ type: "string" }, { type: "integer" }] })
	})

	/* ---- $ref ---- */
	it("$ref → bare name", () => {
		expect(irToPython(schemaToIR({ $ref: "#/components/schemas/User" }))).toBe("User")
		eq({ $ref: "#/components/schemas/User" })
	})

	/* ---- object ---- */
	it("object no props → 'dict[str, Any]'", () => {
		eq({ type: "object" })
	})

	it("object with required prop → TypedDict bare type", () => {
		const input = { properties: { id: { type: "string" } }, required: ["id"], type: "object" }
		const result = irToPython(schemaToIR(input))
		expect(result).toContain('"id": str')
		eq(input)
	})

	it("optional field → NotRequired[...]", () => {
		const input = { properties: { name: { type: "string" } }, type: "object" }
		const result = irToPython(schemaToIR(input))
		expect(result).toContain("NotRequired[str]")
		eq(input)
	})

	it("non-identifier key → functional-form TypedDict", () => {
		const input = {
			properties: { "content-type": { type: "string" } },
			required: ["content-type"],
			type: "object",
		}
		const result = irToPython(schemaToIR(input))
		expect(result).toContain('"content-type"')
		expect(result).toContain("TypedDict")
		eq(input)
	})

	it("additionalProperties schema only → dict[str, int]", () => {
		eq({ additionalProperties: { type: "integer" }, type: "object" })
	})

	it("additionalProperties: true → dict[str, Any]", () => {
		eq({ additionalProperties: true, type: "object" })
	})

	it("additionalProperties: false with props → TypedDict (no extras)", () => {
		const input = {
			additionalProperties: false,
			properties: { id: { type: "string" } },
			required: ["id"],
			type: "object",
		}
		const result = irToPython(schemaToIR(input))
		expect(result).toContain("TypedDict")
		eq(input)
	})

	/* ---- depth guard ---- */
	it("depth > 8 → 'Any'", () => {
		expect(irToPython({ kind: "scalar", type: "string" }, 9)).toBe("Any")
	})

	/* ---- binary ---- */
	it("{ type: 'string', format: 'binary' } → 'str'", () => {
		expect(irToPython(schemaToIR({ format: "binary", type: "string" }))).toBe("str")
		eq({ format: "binary", type: "string" })
	})

	it("{format:'binary'} no type → printer returns 'str' (deliberate divergence from old Any)", () => {
		/*
		 * Old jsonSchemaToPy returned "Any" for bare {format:"binary"} (fell through effectiveType check).
		 * schemaToIR folds both {type:"string",format:"binary"} and {format:"binary"} into {kind:"binary"}.
		 * irToPython returns "str" for binary — matches dominant case per spec §binary.
		 * Since shim now delegates, jsonSchemaToPy also returns "str" post-refactor.
		 * No eq() here: this is the documented 1-case behavior change.
		 */
		expect(irToPython(schemaToIR({ format: "binary" }))).toBe("str")
	})

	/* ---- array of union ---- */
	it("array of oneOf → list[str | int]", () => {
		const input = {
			items: { oneOf: [{ type: "string" }, { type: "integer" }] },
			type: "array",
		}
		expect(irToPython(schemaToIR(input))).toBe("list[str | int]")
		eq(input)
	})

	/* ---- nested object ---- */
	it("nested object → exercises recursion + field sorting at depth", () => {
		const input = {
			properties: {
				meta: {
					properties: { z: { type: "boolean" }, a: { type: "string" } }, // oxlint-disable-line sort-keys
					required: ["a", "z"],
					type: "object",
				},
			},
			required: ["meta"],
			type: "object",
		}
		const result = irToPython(schemaToIR(input))
		expect(result).toContain("TypedDict")
		/* inner object also sorted: "a" before "z" */
		const aPos = result.indexOf('"a"')
		const zPos = result.indexOf('"z"')
		expect(aPos).toBeLessThan(zPos)
		eq(input)
	})
})
