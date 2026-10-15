import { describe, expect, it } from "vitest"
import { schemaToIR } from "../../ir/model.ts"
import { irToTs } from "./type-emitter.ts"

type Json = Record<string, unknown>

const STRING: Json = { type: "string" }
const NULLABLE: Json = { anyOf: [STRING, { type: "null" }] }

/** An object of `properties`, every one required unless `required` names fewer. */
function object(properties: Record<string, Json>, required: readonly string[] = Object.keys(properties)): Json {
	return { properties, required, type: "object" }
}

/*
 * The v0 per-vendor type cases, F7: a vendor schema becomes the JSON Schema core's jsonSchemaOf
 * gives for it (pinned in core's src/schema tests), then the IR, then TypeScript. Types are the
 * wire's: a Date is a string and a bigint a number. v1 quotes a property key only when it is no
 * identifier, where v0 also quoted reserved words; the types are the same.
 */
const CASES: readonly (readonly [name: string, schema: Json, type: string])[] = [
	// v0: 9d964524aa
	// v0: d990cf913b
	// v0: bab7d903dd
	// v0: 4a7706cc3d
	// v0: 5f96a6d178
	// v0: ab5017e614
	// v0: c9f277c258
	// v0: b878cebf5e
	// v0: ebb8f65bc9
	// v0: a4fae41871
	// v0: 74b0e1558a
	// v0: ba1b370818
	// v0: ab2b32c863
	// v0: 52c5a76af2
	// v0: d2714d0694
	// v0: d1f25437a7
	// v0: 7d96cae34a
	// v0: 443d9244e0
	["a string", { type: "string" }, "string"],
	// v0: 97d768e758
	// v0: 7e13992caf
	// v0: 963be46c50
	// v0: 2abcef5adb
	// v0: 08626a552a
	// v0: 092e6c0b53
	// v0: df04dccddf
	// v0: 8dc1b9ecd8
	["a number, an integer among them", { type: "number" }, "number"],
	// v0: 5529c3d630
	// v0: 314d0b857d
	// v0: 0124980842
	// v0: 3b1422d901
	// v0: 2715eea5bb
	// v0: bd73910a12
	// v0: 7b3481eb03
	["a boolean", { type: "boolean" }, "boolean"],
	// v0: 7b5467fdd0
	// v0: 6236e62a89
	// v0: b428b922fa
	// v0: 34d776bb3f
	// v0: 4d152d8bf7
	["null", { type: "null" }, "null"],
	// v0: ecc0163f5d
	// v0: a21b6370b8
	// v0: ffa808fdf8
	// v0: 4fb0e3438d
	// v0: 82a4889d19
	// v0: 106317e8ae
	// v0: 4d2f895c99
	["anything, or a vendor nothing converts", {}, "unknown"],
	// v0: 09da16942d
	// v0: da3e87cfc9
	// v0: 8789609141
	["a Date, as the string it crosses the wire as", { format: "date-time", type: "string" }, "string"],
	// v0: 487548028d
	// v0: e4c0224c39
	// v0: 7937b53c7a
	["a bigint, as the int64 number it crosses the wire as", { format: "int64", type: "integer" }, "number"],
	// v0: a71a6f82c9
	[
		"Effect's bigint, which Effect encodes as a string",
		{ description: "a string to be decoded into a bigint", type: "string" },
		"string",
	],
	// v0: 8e52da72e4
	// v0: 16b2894b6c
	// v0: 20a29f258f
	// v0: 79b0a4315f
	["arktype's Date and bigint, which arktype writes no JSON Schema for (reported)", {}, "unknown"],
	// v0: 2619477484
	// v0: 43a0bfd5f5
	// v0: 0186951df2
	// v0: f4a689d719
	// v0: 33f0a99353
	["a string literal", { const: "hello" }, '"hello"'],
	// v0: e25afe974c
	// v0: 9bffa9c752
	// v0: 23eecc4550
	// v0: 2fa8d4610e
	// v0: d9da9f1cca
	// v0: a614b53089
	["a number literal", { const: 42 }, "42"],
	// v0: 082664813a
	// v0: 5ed800af5d
	// v0: 4542ff99a9
	// v0: bc2f3e5761
	// v0: 4e92eacc4d
	["a boolean literal", { const: true }, "true"],
	// v0: 057efbcfa4
	// v0: 6a0e642373
	// v0: ef6a65bd97
	// v0: b5df7124bc
	// v0: 0976018a4e
	// v0: ea0562d68c
	// v0: 77da299e67
	["a string enum", { enum: ["a", "b"] }, '"a" | "b"'],
	// v0: 1e61c02d31
	// v0: 7bcc174070
	// v0: 961e21c688
	// v0: 1446ed0234
	// v0: 44647cb085
	// v0: d2385d5999
	// v0: eb2b7b5c33
	["a flat object", object({ id: STRING, name: STRING }), "{ id: string; name: string }"],
	// v0: 03d1b918cf
	// v0: 9780b57145
	// v0: 79b3e3306c
	// v0: d8ffafad22
	// v0: 182786c48e
	// v0: fcea5718d0
	["a nested object", object({ user: object({ id: STRING }) }), "{ user: { id: string } }"],
	// v0: 995c678001
	// v0: 0495b5af56
	// v0: 6c02b58c47
	// v0: d9f5e8cdc6
	// v0: 43a6f626e5
	// v0: 94d3e4662f
	["an empty object", { type: "object" }, "Record<string, unknown>"],
	// v0: ed2e6f9005
	[
		"Effect's empty struct: any object or array",
		{ anyOf: [{ type: "object" }, { type: "array" }] },
		"Record<string, unknown> | unknown[]",
	],
	// v0: f9be553001
	// v0: 931e43b851
	// v0: 6913bd0ed5
	// v0: 6f900fe477
	// v0: d3595b0543
	// v0: 13de328479
	// v0: 5705b00f00
	[
		"an optional property, a defaulted one going in among them",
		object({ id: STRING, note: STRING }, ["id"]),
		"{ id: string; note?: string }",
	],
	// v0: 6343b34759
	// v0: c24a0fd981
	// v0: 21b6b806d7
	["a nullable required property, never optional", object({ note: NULLABLE }), "{ note: string | null }"],
	// v0: a7375bbd3f
	// v0: 99fda2fec4
	// v0: f5b29df222
	["a nullable optional property", object({ note: NULLABLE }, []), "{ note?: string | null }"],
	// v0: 59429fa4c7
	// v0: b28d788143
	[
		"required, optional and nullable together",
		object({ a: STRING, b: STRING, c: NULLABLE, d: NULLABLE }, ["a", "c"]),
		"{ a: string; b?: string; c: string | null; d?: string | null }",
	],
	// v0: 22eac6cf47
	// v0: 710e529f3a
	// v0: b247eec297
	// v0: 1006fcecb8
	// v0: aeb1ef2245
	// v0: 7517dd7e1f
	// v0: 30d8badf45
	["a string array", { items: STRING, type: "array" }, "string[]"],
	// v0: 8c99840984
	["an array of numbers", { items: { type: "number" }, type: "array" }, "number[]"],
	// v0: f7d38a861d
	// v0: 516c32b2a1
	// v0: bbfa5cd14c
	// v0: 00ff2fdbad
	// v0: 4d8af0736d
	// v0: f716fccd9a
	["an object array", { items: object({ id: STRING }), type: "array" }, "{ id: string }[]"],
	// v0: 3e422cc683
	[
		"an array of objects with an optional property",
		{ items: object({ id: STRING, tag: STRING }, ["id"]), type: "array" },
		"{ id: string; tag?: string }[]",
	],
	// v0: 600014a001
	["an array of arrays", { items: { items: STRING, type: "array" }, type: "array" }, "string[][]"],
	// v0: f5519ac382
	[
		"objects, arrays and objects nested in them",
		object({
			items: { items: object({ tags: { items: { items: STRING, type: "array" }, type: "array" } }), type: "array" },
		}),
		"{ items: { tags: string[][] }[] }",
	],
	// v0: 11a1630264
	// v0: 7373a8a7dc
	// v0: 874397c512
	// v0: 98011da6c2
	// v0: de1f71a543
	// v0: d4c6e494f7
	// v0: 004930fb09
	["a nullable value", { anyOf: [STRING, { type: "null" }] }, "string | null"],
	// v0: e3e7cf54fd
	["a nullable object", { anyOf: [object({ id: STRING }), { type: "null" }] }, "{ id: string } | null"],
	// v0: d20401296d
	// v0: 3ab13a8868
	// v0: 932fabf899
	// v0: 47bb612c6e
	// v0: ce472d5d36
	["a union", { anyOf: [STRING, { type: "number" }] }, "string | number"],
	// v0: 8cece10e0e
	[
		"a union with null, in arktype's order",
		{ anyOf: [{ type: "number" }, STRING, { type: "null" }] },
		"number | string | null",
	],
	// v0: 7bc5ec9b08
	[
		"a discriminated union",
		{ oneOf: [object({ kind: { const: "a" } }), object({ kind: { const: "b" } })] },
		'{ kind: "a" } | { kind: "b" }',
	],
	// v0: af7a68eceb
	// v0: 7b4a7d3ced
	// v0: 1b36d59c65
	[
		"an intersection",
		{ allOf: [object({ a: STRING }), object({ b: { type: "number" } })] },
		"{ a: string } & { b: number }",
	],
	// v0: 63c524964d
	// v0: fdd95e7fae
	// v0: 254d88ee26
	// v0: 6ad9d66d93
	["a record", { additionalProperties: { type: "number" }, type: "object" }, "Record<string, number>"],
	// v0: ccea6782bf
	[
		"a record of arrays",
		{ additionalProperties: { items: STRING, type: "array" }, type: "object" },
		"Record<string, string[]>",
	],
	// v0: 75a894afc6
	// v0: 0905712bcb
	// v0: b0c6425308
	// v0: 1cd101d8e6
	// v0: ff13d41875
	["a tuple", { items: false, prefixItems: [STRING, { type: "number" }], type: "array" }, "[string, number]"],
	// v0: cbe0cdc80d
	[
		"a tuple whose last element may be left out",
		{ items: false, maxItems: 2, minItems: 1, prefixItems: [STRING, { type: "number" }], type: "array" },
		"[string, number?]",
	],
]

describe("irToTs: each validator's schema, typed as it crosses the wire", () => {
	it.each(CASES)("%s", (_name, schema, type) => {
		expect(irToTs(schemaToIR(schema))).toBe(type)
	})
})
