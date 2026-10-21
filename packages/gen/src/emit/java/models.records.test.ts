/**
 * Java records from an object (bit 16 phase b, B2): `javaTopLevel` declares an object as a `public record` whose
 * components are its fields in code-unit order of the JSON key, each under `@JsonProperty("<wire>")`. The three
 * field states: a required field is its type, primitive for an integer, number or boolean; an optional, non-nullable
 * field is a nullable reference written `NON_NULL`, so absent and null both leave the wire; an optional AND nullable
 * field is `Opt<T>`, `NON_EMPTY`, three states. An open value is `JsonNode`, already tri-state beside `NON_NULL`. A
 * component named like a record member, or a keyword or literal, is claimed `…2`. An allOf is one record of its
 * parts' fields, a key once, its first part's. An object with `additionalProperties` beside its fields keeps every
 * other member in `@JsonAnySetter @JsonAnyGetter Map<String, JsonNode>`, claimed after the fields. Every pinned text
 * is google-java-format's canonical form (the phase's GJF and javac legs record it).
 */
import { describe, expect, it } from "vitest"
import { type OpenApiDocument, toIR } from "../../ir/build.ts"
import { schemaToIR } from "../../ir/schema.ts"
import { javaTopLevel, javaTypeContext } from "./models.ts"

type Json = Record<string, unknown>

/** A top-level row: the component `name` declares `text`, hoisting the names in `decls`. */
type TopRow = {
	title: string
	name: string
	schema: Json
	/** the other components of the document, which the schema may refer to */
	components?: Record<string, Json>
	text: string
	decls?: string[]
}

const STRING = { type: "string" }
const INTEGER = { type: "integer" }
const NULLABLE_STRING = { nullable: true, type: "string" }
const ARRAY = { items: STRING, type: "array" }

/** A minimal OpenAPI 3.1 document holding these components. */
const doc = (schemas: Record<string, Json>): OpenApiDocument => ({
	components: { schemas },
	info: { title: "Records", version: "1" },
	openapi: "3.1.0",
	paths: {},
})

/** An object of `properties`, its `required` keys listed. */
const object = (properties: Json, required: string[] = []): Json => ({ properties, required, type: "object" })

/** A component's declaration text and the names of the declarations it hoisted, its name claimed as `name`. */
function top({ name, schema, components = {} }: Pick<TopRow, "components" | "name" | "schema">) {
	const ctx = javaTypeContext(toIR(doc(components)), ["AnyrowClient"])
	const text = javaTopLevel(name, schemaToIR(schema), ctx)
	return { decls: [...ctx.decls.keys()], text }
}

/** What a top-level row expects: its text and exactly the declarations it hoists. */
const declaredAs = (row: TopRow) => ({ decls: row.decls ?? [], text: row.text })

/** The record `T` of one component `v` of `schema`, required or optional. */
const member = (schema: Json, required: boolean) =>
	top({ name: "T", schema: object({ v: schema }, required ? ["v"] : []) })

/* the record members a record claims: java.lang.Record and Object, and Object's final methods */
const MEMBER_KEYS = ["clone", "equals", "finalize", "getClass", "hash_code", "notify", "notifyAll", "toString", "wait"]

/** The record of every field state at once: a required count and id, an optional display name and extra, an optional nick. */
const USER: TopRow = {
	name: "User",
	schema: object({ count: INTEGER, display_name: STRING, extra: {}, id: STRING, nick: NULLABLE_STRING }, [
		"count",
		"id",
	]),
	text: [
		"public record User(",
		'    @JsonProperty("count") long count,',
		'    @JsonProperty("display_name") @JsonInclude(JsonInclude.Include.NON_NULL) String displayName,',
		'    @JsonProperty("extra") @JsonInclude(JsonInclude.Include.NON_NULL) JsonNode extra,',
		'    @JsonProperty("id") String id,',
		'    @JsonProperty("nick") @JsonInclude(JsonInclude.Include.NON_EMPTY) Opt<String> nick) {}',
	].join("\n"),
	title: "every field state in one record, in key order",
}

/** Code-unit order: B sorts before a, and the second b is claimed b2. */
const ORDER: TopRow = {
	name: "T",
	schema: object({ B: STRING, a: STRING, b: STRING }, ["B", "a", "b"]),
	text: [
		"public record T(",
		'    @JsonProperty("B") String b, @JsonProperty("a") String a, @JsonProperty("b") String b2) {}',
	].join("\n"),
	title: "B before a before b, and the second b is b2",
}

/** A keyword, a literal and two members of Object and Record. */
const KEYWORDS: TopRow = {
	name: "T",
	schema: object({ class: STRING, hash_code: STRING, null: STRING, toString: STRING }, [
		"class",
		"hash_code",
		"null",
		"toString",
	]),
	text: [
		"public record T(",
		'    @JsonProperty("class") String class2,',
		'    @JsonProperty("hash_code") String hashCode2,',
		'    @JsonProperty("null") String null2,',
		'    @JsonProperty("toString") String toString2) {}',
	].join("\n"),
	title: "a keyword, a literal and two members of Object and Record",
}

/** Every member java.lang.Record and Object synthesize, each claimed …2. */
const MEMBERS: TopRow = {
	name: "T",
	schema: object(Object.fromEntries(MEMBER_KEYS.map((key) => [key, STRING])), MEMBER_KEYS),
	text: [
		"public record T(",
		'    @JsonProperty("clone") String clone2,',
		'    @JsonProperty("equals") String equals2,',
		'    @JsonProperty("finalize") String finalize2,',
		'    @JsonProperty("getClass") String getClass2,',
		'    @JsonProperty("hash_code") String hashCode2,',
		'    @JsonProperty("notify") String notify2,',
		'    @JsonProperty("notifyAll") String notifyAll2,',
		'    @JsonProperty("toString") String toString2,',
		'    @JsonProperty("wait") String wait2) {}',
	].join("\n"),
	title: "clone, equals, finalize, getClass, hashCode, notify, notifyAll, toString and wait",
}

/** Each field state: its schema, whether it is required, and the record it declares. */
const FIELD_STATES: [title: string, schema: Json, required: boolean, text: string][] = [
	["a required string is its type, the wire key only", STRING, true, 'public record T(@JsonProperty("v") String v) {}'],
	["a required integer is the primitive long", INTEGER, true, 'public record T(@JsonProperty("v") long v) {}'],
	[
		"a required number is the primitive double",
		{ type: "number" },
		true,
		'public record T(@JsonProperty("v") double v) {}',
	],
	[
		"a required boolean is the primitive boolean",
		{ type: "boolean" },
		true,
		'public record T(@JsonProperty("v") boolean v) {}',
	],
	[
		"a required nullable string is String, written even when null",
		NULLABLE_STRING,
		true,
		'public record T(@JsonProperty("v") String v) {}',
	],
	["a required open value is JsonNode", {}, true, 'public record T(@JsonProperty("v") JsonNode v) {}'],
	[
		"a required map is Map<String, String>",
		{ additionalProperties: STRING, type: "object" },
		true,
		'public record T(@JsonProperty("v") Map<String, String> v) {}',
	],
	[
		"an optional string is a nullable reference, NON_NULL: absent and null leave the wire",
		STRING,
		false,
		'public record T(@JsonProperty("v") @JsonInclude(JsonInclude.Include.NON_NULL) String v) {}',
	],
	[
		"an optional nullable string is Opt<String>, NON_EMPTY: absent, null and a value stay apart",
		NULLABLE_STRING,
		false,
		'public record T(@JsonProperty("v") @JsonInclude(JsonInclude.Include.NON_EMPTY) Opt<String> v) {}',
	],
	[
		"an optional nullable integer is Opt<Long>, a reference for the generic",
		{ nullable: true, type: "integer" },
		false,
		'public record T(@JsonProperty("v") @JsonInclude(JsonInclude.Include.NON_EMPTY) Opt<Long> v) {}',
	],
	[
		"an optional open value is JsonNode, NON_NULL: a JSON null is NullNode, absent is null",
		{},
		false,
		'public record T(@JsonProperty("v") @JsonInclude(JsonInclude.Include.NON_NULL) JsonNode v) {}',
	],
	[
		"an optional nullable open value is JsonNode, not Opt, since it holds null itself",
		{ nullable: true },
		false,
		'public record T(@JsonProperty("v") @JsonInclude(JsonInclude.Include.NON_NULL) JsonNode v) {}',
	],
	[
		"an optional array is a nullable List, NON_NULL",
		ARRAY,
		false,
		'public record T(@JsonProperty("v") @JsonInclude(JsonInclude.Include.NON_NULL) List<String> v) {}',
	],
	[
		"an optional nullable array is Opt<List<String>>",
		{ ...ARRAY, nullable: true },
		false,
		'public record T(\n    @JsonProperty("v") @JsonInclude(JsonInclude.Include.NON_EMPTY) Opt<List<String>> v) {}',
	],
] as const

describe("javaTopLevel: the three field states (B2)", () => {
	it.each(FIELD_STATES)("%s", (_title, schema, required, text) => {
		expect(member(schema, required).text).toBe(text)
	})
})
describe("javaTopLevel: a record of several fields (B2)", () => {
	it("declares every field in code-unit order of its key, each state of its own, with an open value JsonNode", () => {
		expect(top(USER)).toEqual(declaredAs(USER))
	})

	it("keys the components by code unit: an uppercase key sorts before a lowercase one, and a repeat takes …2", () => {
		expect(top(ORDER)).toEqual(declaredAs(ORDER))
	})

	it("claims a component named like a keyword, a literal or a record member …2, and keeps the wire key", () => {
		expect(top(KEYWORDS)).toEqual(declaredAs(KEYWORDS))
	})

	it("claims every member java.lang.Record and Object synthesize …2, since a component named so would override it", () => {
		expect(top(MEMBERS)).toEqual(declaredAs(MEMBERS))
	})
})

describe("javaTopLevel: additionalProperties and allOf (B2)", () => {
	it("declares an object with no fields, closed to every property, as an empty record", () => {
		const row: TopRow = {
			name: "T",
			schema: { additionalProperties: false, type: "object" },
			text: "public record T() {}",
			title: "no field and no extra member",
		}
		expect(top(row)).toEqual(declaredAs(row))
	})

	it("keeps the other members beside declared fields in a JsonNode map, claimed after them: extra2 beside a field extra", () => {
		const row: TopRow = {
			name: "T",
			schema: object({ extra: STRING, id: STRING }, ["extra", "id"]),
			text: [
				"public record T(",
				'    @JsonProperty("extra") String extra,',
				'    @JsonProperty("id") String id,',
				"    @JsonAnySetter @JsonAnyGetter Map<String, JsonNode> extra2) {}",
			].join("\n"),
			title: "a field named extra, then the map named extra2",
		}
		expect(top({ ...row, schema: { ...row.schema, additionalProperties: STRING } })).toEqual(declaredAs(row))
	})

	it("declares the map of a plain object beside its one field as @JsonAnySetter and @JsonAnyGetter, Map<String, JsonNode>", () => {
		const row: TopRow = {
			name: "Bag",
			schema: { ...object({ id: STRING }, ["id"]), additionalProperties: STRING },
			text: [
				"public record Bag(",
				'    @JsonProperty("id") String id, @JsonAnySetter @JsonAnyGetter Map<String, JsonNode> extra) {}',
			].join("\n"),
			title: "one field and the map",
		}
		expect(top(row)).toEqual(declaredAs(row))
	})

	it("declares an allOf as one record of its parts' fields, a key once, its first part's", () => {
		const row: TopRow = {
			name: "T",
			components: { A: object({ id: STRING }, ["id"]) },
			schema: { allOf: [{ $ref: "#/components/schemas/A" }, object({ id: STRING, n: INTEGER }, ["n"])] },
			text: 'public record T(@JsonProperty("id") String id, @JsonProperty("n") long n) {}',
			title: "id from A, once; n from the second part",
		}
		expect(top(row)).toEqual(declaredAs(row))
	})
})

describe("javaTopLevel: an inline object hoists as <Parent><Field> (B2)", () => {
	it("declares the parent with its field typed by the hoisted record, which is declared beside it", () => {
		const row: TopRow = {
			decls: ["OwnerAddress"],
			name: "Owner",
			schema: object({ address: object({ city: STRING }, ["city"]) }, ["address"]),
			text: 'public record Owner(@JsonProperty("address") OwnerAddress address) {}',
			title: "Owner.address is OwnerAddress",
		}
		expect(top(row)).toEqual(declaredAs(row))
	})
})

describe("javaTopLevel: component names from a key (B2)", () => {
	it("names a key that starts with a digit _<key>, and an empty key value", () => {
		const row: TopRow = {
			name: "T",
			schema: object({ "2fa": STRING, "": STRING }, ["2fa", ""]),
			text: 'public record T(@JsonProperty("") String value, @JsonProperty("2fa") String _2fa) {}',
			title: "a digit-first key and the empty key",
		}
		expect(top(row)).toEqual(declaredAs(row))
	})
})
