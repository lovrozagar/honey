import { describe, expect, it } from "vitest"
import { schemaToIR } from "../../../src/codegen-ir.ts"
import {
	irRenderTopLevel,
	irRenderUse,
	renderTopLevel,
	renderUse,
	type RenderUseCtx,
} from "../../../src/go-type-emitter.ts"

function mkCtx(overrides: Partial<RenderUseCtx> = {}): RenderUseCtx {
	return {
		decls: new Map<string, string>(),
		fieldName: "Value",
		parentName: "T",
		...overrides,
	}
}

function eqUse(schema: Record<string, unknown> | undefined, ctxOverrides: Partial<RenderUseCtx> = {}): void {
	const declsA = new Map<string, string>()
	const declsB = new Map<string, string>()
	const ctxA: RenderUseCtx = { ...mkCtx(ctxOverrides), decls: declsA }
	const ctxB: RenderUseCtx = { ...mkCtx(ctxOverrides), decls: declsB }
	expect(irRenderUse(schemaToIR(schema), ctxA)).toBe(renderUse(schema, ctxB))
	expect([...declsA.entries()].sort()).toEqual([...declsB.entries()].sort())
}

function eqTop(name: string, schema: Record<string, unknown>): void {
	const declsA = new Map<string, string>()
	const declsB = new Map<string, string>()
	expect(irRenderTopLevel(name, schemaToIR(schema), declsA, schema)).toBe(renderTopLevel(name, schema, declsB))
	expect([...declsA.entries()].sort()).toEqual([...declsB.entries()].sort())
}

describe("irRenderUse equivalence — primitives + scalar", () => {
	it("string type", () => eqUse({ type: "string" }))
	it("integer type", () => eqUse({ type: "integer" }))
	it("number type", () => eqUse({ type: "number" }))
	it("boolean type", () => eqUse({ type: "boolean" }))
	it("null type", () => eqUse({ type: "null" }))
	it("undefined schema", () => eqUse(undefined))
	it("empty schema {}", () => eqUse({}))
})

describe("irRenderUse equivalence — const literal (use-position)", () => {
	it("const string no type", () => eqUse({ const: "admin" }))
	it("const int no type", () => eqUse({ const: 42 }))
	it("const float no type", () => eqUse({ const: 3.14 }))
	it("const bool no type", () => eqUse({ const: true }))
	it("const with type string (scalar path, not const path)", () => eqUse({ const: "admin", type: "string" }))
})

describe("irRenderUse equivalence — enums (hoist + return hoisted name)", () => {
	it("string enum with type", () =>
		eqUse({ enum: ["a", "b"], type: "string" }, { fieldName: "status", parentName: "User" }))
	it("string enum no type (all-string heuristic)", () =>
		eqUse({ enum: ["a", "b"] }, { fieldName: "status", parentName: "User" }))
	it("int enum with type", () => eqUse({ enum: [1, 2], type: "integer" }, { fieldName: "score", parentName: "Post" }))
	it("int enum no type (all-int heuristic)", () => eqUse({ enum: [1, 2] }, { fieldName: "score", parentName: "Post" }))
	it("string enum + nullable:true → *HoistedName", () =>
		eqUse({ enum: ["a", "b"], nullable: true, type: "string" }, { fieldName: "status", parentName: "User" }))
	it("string enum + type:[string,null] → *HoistedName", () =>
		eqUse({ enum: ["a", "b"], type: ["string", "null"] }, { fieldName: "status", parentName: "User" }))
	it("mixed enum → json.RawMessage", () => eqUse({ enum: ["active", 1] }, { fieldName: "v", parentName: "T" }))
})

describe("irRenderUse equivalence — array / tuple", () => {
	it("array of string", () => eqUse({ items: { type: "string" }, type: "array" }))
	it("array of integer", () => eqUse({ items: { type: "integer" }, type: "array" }))
	it("tuple items array → [N]interface{}", () =>
		eqUse({ items: [{ type: "string" }, { type: "number" }], type: "array" }))
	it("array of $ref", () => eqUse({ items: { $ref: "#/components/schemas/User" }, type: "array" }))
	it("array of nullable string", () => eqUse({ items: { nullable: true, type: "string" }, type: "array" }))
	it("array no items → []json.RawMessage", () => eqUse({ type: "array" }))
})

describe("irRenderUse equivalence — nullable / type arrays", () => {
	it("nullable:true string", () => eqUse({ nullable: true, type: "string" }))
	it("type array [string,null]", () => eqUse({ type: ["string", "null"] }))
	it("multi-type no-null → json.RawMessage", () => eqUse({ type: ["string", "number"] }))
	it("multi-type with null → json.RawMessage (no pointer)", () => eqUse({ type: ["string", "number", "null"] }))
})

describe("irRenderUse equivalence — oneOf / anyOf", () => {
	it("oneOf no discriminator → json.RawMessage", () => eqUse({ oneOf: [{ type: "string" }, { type: "integer" }] }))
	it("anyOf with null → *string", () => eqUse({ anyOf: [{ type: "string" }, { type: "null" }] }))
	it("anyOf multi + null → json.RawMessage", () =>
		eqUse({ anyOf: [{ type: "string" }, { type: "integer" }, { type: "null" }] }))
	it("oneOf ref + null → *User", () => eqUse({ oneOf: [{ $ref: "#/components/schemas/User" }, { type: "null" }] }))
})

describe("irRenderUse equivalence — allOf", () => {
	it("allOf with $ref → first ref name", () =>
		eqUse({
			allOf: [{ $ref: "#/components/schemas/Base" }, { properties: { x: { type: "string" } } }],
		}))
	it("allOf no ref → json.RawMessage", () =>
		eqUse({
			allOf: [{ properties: { x: { type: "string" } } }, { properties: { y: { type: "string" } } }],
		}))
})

describe("irRenderUse equivalence — $ref", () => {
	it("bare ref → PascalCase name", () => eqUse({ $ref: "#/components/schemas/User" }))
	it("circular ref → *Name", () =>
		eqUse({ $ref: "#/components/schemas/Comment" }, { circularRefs: new Set(["Comment"]) }))
})

describe("irRenderUse equivalence — object (use-position)", () => {
	it("object with required prop → anon struct bare", () =>
		eqUse({
			properties: { id: { type: "string" } },
			required: ["id"],
			type: "object",
		}))
	it("object no props → map[string]interface{}", () => eqUse({ type: "object" }))
	it("object additionalProperties:false no props → struct{}", () =>
		eqUse({ additionalProperties: false, type: "object" }))
	it("object additionalProperties:integer no props → map[string]int64", () =>
		eqUse({
			additionalProperties: { type: "integer" },
			type: "object",
		}))
	it("object with props + addl:false → anon struct (addl ignored at use-pos)", () =>
		eqUse({
			additionalProperties: false,
			properties: { id: { type: "string" } },
			required: ["id"],
			type: "object",
		}))
})

describe("irRenderUse equivalence — depth cap", () => {
	it("depth > 12 → json.RawMessage", () => {
		const ctx = mkCtx()
		expect(irRenderUse(schemaToIR({ type: "string" }), ctx, 13)).toBe("json.RawMessage")
	})
})

describe("irRenderTopLevel equivalence", () => {
	it("top-level string enum", () => eqTop("Role", { enum: ["a", "b"], type: "string" }))
	it("top-level int enum", () => eqTop("Status", { enum: [1, 2], type: "integer" }))
	it("top-level const string no type", () => eqTop("Role", { const: "admin" }))
	it("top-level const bool with type", () => eqTop("Success", { const: false, type: "boolean" }))
	it("top-level allOf refs + inline", () =>
		eqTop("Ext", {
			allOf: [{ $ref: "#/components/schemas/Base" }, { properties: { y: { type: "string" } }, type: "object" }],
		}))
	it("top-level discriminated union", () =>
		eqTop("Animal", {
			discriminator: { propertyName: "kind" },
			oneOf: [{ $ref: "#/components/schemas/Dog" }, { $ref: "#/components/schemas/Cat" }],
		}))
	it("top-level object required+optional sorted", () =>
		eqTop("User", {
			properties: { email: { type: "string" }, name: { type: "string" } },
			required: ["email"],
			type: "object",
		}))
	it("top-level pure map", () =>
		eqTop("Attrs", {
			additionalProperties: { type: "string" },
			type: "object",
		}))
	it("top-level empty-props addl:false → struct{}", () =>
		eqTop("X", {
			additionalProperties: false,
			type: "object",
		}))
	it("top-level empty-props no addl → map[string]interface{}", () =>
		eqTop("X", {
			type: "object",
		}))
	it("top-level object with props AND additionalProperties → Extra + Marshal/Unmarshal", () =>
		eqTop("Config", {
			additionalProperties: { type: "string" },
			properties: { id: { type: "string" } },
			required: ["id"],
			type: "object",
		}))
	it("top-level circular self-ref → *Comment pointer field", () =>
		eqTop("Comment", {
			properties: { parent: { $ref: "#/components/schemas/Comment" } },
			type: "object",
		}))
	it("top-level array alias (fallback)", () =>
		eqTop("Names", {
			items: { type: "string" },
			type: "array",
		}))
	it("non-identifier prop key kebab", () =>
		eqTop("X", {
			properties: { "bad-key": { type: "string" } },
			type: "object",
		}))
	it("top-level enum decls side-effect: decls empty (enum handled inline)", () => {
		const declsA = new Map<string, string>()
		const declsB = new Map<string, string>()
		const schema = { enum: ["x", "y", "z"], type: "string" }
		irRenderTopLevel("Role", schemaToIR(schema), declsA, schema)
		renderTopLevel("Role", schema, declsB)
		expect(declsA.size).toBe(0)
		expect(declsB.size).toBe(0)
	})
	it("use-position nested enum field hoisted to decls", () =>
		eqTop("User", {
			properties: { status: { enum: ["a", "b"], type: "string" } },
			required: ["status"],
			type: "object",
		}))
})

describe("binary kind — documented divergence", () => {
	/*
	 * Bare {format:"binary"} (no type): pre-IR raw path returned "json.RawMessage";
	 * IR maps it to kind:"binary" → "string". Deliberate 1-case divergence. Spec §binary.
	 */
	it("{type:string, format:binary} → string (eqUse matches)", () => eqUse({ format: "binary", type: "string" }))
	it("bare {format:binary} no type → string (IR diverges from old raw path)", () => {
		const ctx = mkCtx()
		const ir = schemaToIR({ format: "binary" })
		expect(irRenderUse(ir, ctx)).toBe("string")
		expect(renderUse({ format: "binary" }, mkCtx())).toBe("string")
	})
})
