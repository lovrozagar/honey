import { describe, expect, it } from "vitest"
import { schemaToIR } from "../../../src/codegen-ir.ts"
import {
	irRenderTopLevelRust,
	irRenderUseRust,
	renderTopLevelRust,
	renderUseRust,
	type RustRenderUseCtx,
} from "../../../src/rust-type-emitter.ts"

function mkCtx(overrides: Partial<RustRenderUseCtx> = {}): RustRenderUseCtx {
	return {
		circularRefs: new Set<string>(),
		decls: new Map<string, string>(),
		depth: 0,
		fieldName: "value",
		parentName: "T",
		...overrides,
	}
}

function eqUse(schema: Record<string, unknown> | undefined, ctxOverrides: Partial<RustRenderUseCtx> = {}): void {
	const declsA = new Map<string, string>()
	const declsB = new Map<string, string>()
	const ctxA: RustRenderUseCtx = { ...mkCtx(ctxOverrides), decls: declsA }
	const ctxB: RustRenderUseCtx = { ...mkCtx(ctxOverrides), decls: declsB }
	expect(irRenderUseRust(schemaToIR(schema), ctxA)).toBe(renderUseRust(schema, ctxB))
	expect([...declsA.entries()].sort()).toEqual([...declsB.entries()].sort())
}

function eqTop(name: string, schema: Record<string, unknown>): void {
	const declsA = new Map<string, string>()
	const declsB = new Map<string, string>()
	expect(irRenderTopLevelRust(name, schemaToIR(schema), declsA, schema)).toBe(renderTopLevelRust(name, schema, declsB))
	expect([...declsA.entries()].sort()).toEqual([...declsB.entries()].sort())
}

describe("irRenderUseRust equivalence — primitives + scalar", () => {
	it("string type", () => eqUse({ type: "string" }))
	it("integer type", () => eqUse({ type: "integer" }))
	it("number type", () => eqUse({ type: "number" }))
	it("boolean type", () => eqUse({ type: "boolean" }))
	it("null type", () => eqUse({ type: "null" }))
	it("undefined schema", () => eqUse(undefined))
	it("empty schema {}", () => eqUse({}))
})

describe("irRenderUseRust equivalence — const literal (use-position)", () => {
	it("const string", () => eqUse({ const: "admin" }))
	it("const integer", () => eqUse({ const: 42 }))
	it("const bool", () => eqUse({ const: true }))
})

describe("irRenderUseRust equivalence — enums hoisted", () => {
	it("string enum with type — hoists UserStatus", () => eqUse(
		{ enum: ["a", "b"], type: "string" },
		{ fieldName: "status", parentName: "User" },
	))
	it("string enum no type — heuristic hoist", () => eqUse(
		{ enum: ["a", "b"] },
		{ fieldName: "status", parentName: "User" },
	))
	it("int enum with type — hoists PostScore with repr(i64)", () => eqUse(
		{ enum: [1, 2], type: "integer" },
		{ fieldName: "score", parentName: "Post" },
	))
	it("string enum + nullable — Option<UserStatus>", () => eqUse(
		{ enum: ["a", "b"], nullable: true, type: "string" },
		{ fieldName: "status", parentName: "User" },
	))
})

describe("irRenderUseRust equivalence — array / tuple", () => {
	it("array of strings", () => eqUse({ items: { type: "string" }, type: "array" }))
	it("tuple items array — Vec<serde_json::Value>", () => eqUse({ items: [{ type: "string" }, { type: "number" }], type: "array" }))
	it("array of $ref", () => eqUse({ items: { $ref: "#/components/schemas/User" }, type: "array" }))
	it("array of nullable string", () => eqUse({ items: { nullable: true, type: "string" }, type: "array" }))
})

describe("irRenderUseRust equivalence — nullable", () => {
	it("nullable: true on string", () => eqUse({ nullable: true, type: "string" }))
	it("type array with null", () => eqUse({ type: ["string", "null"] }))
	it("multi-type no null — serde_json::Value", () => eqUse({ type: ["string", "number"] }))
	it("multi-type with null — serde_json::Value (union inner)", () => eqUse({ type: ["string", "number", "null"] }))
	it("anyOf with null variant — Option<String>", () => eqUse({ anyOf: [{ type: "string" }, { type: "null" }] }))
})

describe("irRenderUseRust equivalence — oneOf / anyOf use-position", () => {
	it("oneOf two types — serde_json::Value", () => eqUse({ oneOf: [{ type: "string" }, { type: "integer" }] }))
	it("anyOf three with null — serde_json::Value (stripped multi)", () => eqUse({ anyOf: [{ type: "string" }, { type: "integer" }, { type: "null" }] }))
	it("oneOf ref + null — Option<User>", () => eqUse({ oneOf: [{ $ref: "#/components/schemas/User" }, { type: "null" }] }))
	it("mixed enum — serde_json::Value", () => eqUse({ enum: ["active", 1] }))
})

describe("irRenderUseRust equivalence — allOf use-position", () => {
	it("allOf first-$ref wins", () => eqUse({ allOf: [{ $ref: "#/components/schemas/Base" }, { properties: { x: { type: "string" } } }] }))
	it("allOf no ref — serde_json::Value", () => eqUse({ allOf: [{ properties: { x: { type: "string" } } }, { properties: { y: { type: "string" } } }] }))
})

describe("irRenderUseRust equivalence — $ref", () => {
	it("bare $ref", () => eqUse({ $ref: "#/components/schemas/User" }))
	it("circular $ref — Box<Comment>", () => eqUse(
		{ $ref: "#/components/schemas/Comment" },
		{ circularRefs: new Set(["Comment"]) },
	))
})

describe("irRenderUseRust equivalence — object use-position", () => {
	it("empty object — HashMap<String, serde_json::Value>", () => eqUse({ type: "object" }))
	it("additionalProperties: false — serde_json::Value", () => eqUse({ additionalProperties: false, type: "object" }))
	it("additionalProperties typed — HashMap<String, i64>", () => eqUse({ additionalProperties: { type: "integer" }, type: "object" }))
	it("object with props — hoists RootInner required", () => eqUse(
		{ properties: { id: { type: "string" } }, required: ["id"], type: "object" },
		{ fieldName: "inner", parentName: "Root" },
	))
	it("object with props — hoists RootInner optional", () => eqUse(
		{ properties: { id: { type: "string" } }, type: "object" },
		{ fieldName: "inner", parentName: "Root" },
	))
})

describe("irRenderUseRust equivalence — depth cap", () => {
	it("depth > 12 — serde_json::Value", () => {
		const ctx = mkCtx({ depth: 13 })
		expect(irRenderUseRust(schemaToIR({ type: "string" }), ctx, 13)).toBe("serde_json::Value")
	})
})

describe("irRenderTopLevelRust equivalence — top-level cases", () => {
	it("top-level string enum Role", () => eqTop("Role", { enum: ["a", "b"], type: "string" }))
	it("top-level int enum Kind", () => eqTop("Kind", { enum: [1, 2], type: "integer" }))
	it("top-level const string — newtype", () => eqTop("Role", { const: "admin" }))
	it("top-level const bool with declared type — bool newtype", () => eqTop("Success", { const: false, type: "boolean" }))
	it("top-level const int with type:number — f64 newtype", () => eqTop("Mag", { const: 42, type: "number" }))
	it("top-level allOf refs + inline props", () => eqTop("Ext", {
		allOf: [
			{ $ref: "#/components/schemas/Base" },
			{ properties: { y: { type: "string" } } },
		],
	}))
	it("top-level discriminated union", () => eqTop("Animal", {
		discriminator: { propertyName: "kind" },
		oneOf: [{ $ref: "#/components/schemas/Dog" }, { $ref: "#/components/schemas/Cat" }],
	}))
	it("top-level untagged union", () => eqTop("AB", {
		oneOf: [{ $ref: "#/components/schemas/A" }, { $ref: "#/components/schemas/B" }],
	}))
	it("top-level object required + optional sorted", () => eqTop("User", {
		properties: { email: { type: "string" }, name: { type: "string" } },
		required: ["email"],
		type: "object",
	}))
	it("top-level pure map", () => eqTop("Attrs", { additionalProperties: { type: "string" }, type: "object" }))
	it("top-level empty-props addl:false — unit struct", () => eqTop("X", { additionalProperties: false, type: "object" }))
	it("top-level empty-props no addl — HashMap alias", () => eqTop("X", { type: "object" }))
	it("top-level object with props + additionalProperties — struct + extra flatten", () => eqTop("Mixed", {
		additionalProperties: { type: "string" },
		properties: { id: { type: "string" } },
		required: ["id"],
		type: "object",
	}))
	it("top-level self-ref circular", () => eqTop("Comment", {
		properties: { parent: { $ref: "#/components/schemas/Comment" } },
		type: "object",
	}))
	it("top-level array alias", () => eqTop("Names", { items: { type: "string" }, type: "array" }))
	it("non-identifier prop key bad-key — serde rename", () => eqTop("Resp", {
		properties: { "bad-key": { type: "string" } },
		required: ["bad-key"],
		type: "object",
	}))
	it("Rust reserved prop key type — type_ ident + serde rename", () => eqTop("Thing", {
		properties: { type: { type: "string" } },
		required: ["type"],
		type: "object",
	}))
})
