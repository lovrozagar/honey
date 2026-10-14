import * as v from "valibot"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { HoneyError } from "../errors/error.ts"
import type { StandardSchemaIssue, StandardSchemaLike } from "./standard-schema.ts"
import {
	issuesToFieldErrors,
	mapNormalizedCode,
	type NormalizedIssue,
	normalizeIssues,
	runSchema,
	shapedRecord,
	shapeOf,
} from "./validate-input.ts"

/** A schema from one vendor that answers `issues`, or the value it was given; async when asked. */
function schemaOf(vendor: string, issues: StandardSchemaIssue[] = [], async = false): StandardSchemaLike {
	const answer = (value: unknown) => (issues.length > 0 ? { issues } : { value: { checked: value } })
	return {
		"~standard": {
			validate: (value: unknown) => (async ? Promise.resolve(answer(value)) : answer(value)),
			vendor,
			version: 1,
		},
	}
}

/** The HoneyError `run` throws or rejects with. */
async function failure(run: () => unknown): Promise<HoneyError> {
	try {
		await run()
	} catch (error) {
		return error as HoneyError
	}
	throw new Error("did not fail")
}

describe("mapNormalizedCode: the field error key for a vendor code", () => {
	// v0: a403f2ac8c
	// v0: 4d21d5f8d5
	// v0: 02314ba508
	// v0: 39af897af3
	// v0: e27b55aa06
	// v0: e879aad664
	// v0: 7debeafb23
	// v0: 776d8b347f
	// v0: 4a4fe9e8b3
	// v0: e6fde932f4
	it.each([
		["invalid_format", "field_invalid_format"],
		["invalid_value", "field_invalid_enum"],
		["not_multiple", "field_not_multiple_of"],
		["required", "field_required"],
		["too_big", "field_too_big"],
		["too_long", "field_too_long"],
		["too_short", "field_too_short"],
		["too_small", "field_too_small"],
		["unrecognized", "field_unrecognized_keys"],
	])("%s is %s", (code, key) => {
		expect(mapNormalizedCode(code)).toBe(key)
	})

	// v0: a59e5b2ed3
	// v0: 2d3f20a531
	it.each(["some_unknown_code", "unknown", "toString", "__proto__", "constructor"])(
		"%s, or any code the table lacks, is field_invalid",
		(code) => {
			expect(mapNormalizedCode(code)).toBe("field_invalid")
		},
	)
})

describe("normalizeIssues: the vendor's code and the issue's path", () => {
	// v0: 901dc24c8d
	// v0: 7fb3c85b81
	// v0: 784f28b7fc
	// v0: 2743e6d090
	// v0: aee8d7681c
	// v0: 6e97333efe
	it.each<[string, StandardSchemaIssue & { code?: unknown; type?: unknown }, string]>([
		["zod", { code: "too_small", message: "Too short", path: ["name"] }, "too_small"],
		["arktype", { code: "invalid_type", message: "Expected string", path: ["age"] }, "invalid_type"],
		["valibot", { message: "Min length", path: ["name"], type: "min_length" }, "min_length"],
		["zod", { message: "Bad value" }, "unknown"],
		["zod", { code: 42, message: "Not a string code" }, "unknown"],
		["valibot", { code: "too_small", message: "valibot reads type, not code" }, "unknown"],
		["custom-lib", { code: "too_small", message: "Error", path: [] }, "unknown"],
	])("%s: %j has code %s", (vendor, issue, code) => {
		expect(normalizeIssues([issue], vendor)[0]?.code).toBe(code)
	})

	// v0: 197c28b9ca
	// v0: 82ee5419be
	// v0: 79eee98eb5
	it("reads a path of keys and { key } segments, and names the field by its last one", () => {
		const issues: StandardSchemaIssue[] = [
			{ message: "a", path: ["items", { key: 0 }, { key: "name" }] },
			{ message: "b", path: [{ key: "user" }, { key: "email" }] },
			{ message: "c" },
		]
		expect(normalizeIssues(issues, "zod").map((issue) => [issue.path, issue.meta.field, issue.message])).toEqual([
			[["items", 0, "name"], "name", "a"],
			[["user", "email"], "email", "b"],
			[[], undefined, "c"],
		])
	})
})

/** A normalized issue with `code` at `path`, its message the code unless given. */
const issue = (code: string, path: PropertyKey[], message = code): NormalizedIssue => ({
	code,
	message,
	meta: {},
	path,
})

describe("issuesToFieldErrors: field errors keyed by field", () => {
	// v0: e23272e385
	// v0: 12cc903f7e
	// v0: 104dda42d0
	it("groups each issue under its field, with its key, message and full path", () => {
		const fields = issuesToFieldErrors(
			[
				issue("required", ["email"], "Email is required"),
				issue("too_small", ["name"]),
				issue("invalid_format", ["name"]),
			],
			"json",
		)
		expect({ ...fields }).toEqual({
			email: [{ error_key: "field_required", message: "Email is required", path: "json.email" }],
			name: [
				{ error_key: "field_too_small", message: "too_small", path: "json.name" },
				{ error_key: "field_invalid_format", message: "invalid_format", path: "json.name" },
			],
		})
	})

	// v0: 258a9751be
	// v0: 0e3486c0f1
	// v0: 3d818d0bd8
	it("keys a nested issue by its last segment with the whole path, and a pathless one as unknown", () => {
		const fields = issuesToFieldErrors([issue("required", ["user", "address", "zip"]), issue("required", [])], "json")
		expect([fields.zip?.[0]?.path, fields.unknown?.[0]?.path]).toEqual(["json.user.address.zip", "json."])
	})

	// v0: 1942e04d85
	it("keys fields on a record with no prototype, a prototype-named field a plain key", () => {
		const fields = issuesToFieldErrors([issue("invalid_type", ["toString"]), issue("required", ["__proto__"])], "json")
		expect([Object.getPrototypeOf(fields), fields.toString?.length, Object.keys(fields)]).toEqual([
			null,
			1,
			["toString", "__proto__"],
		])
	})
})

describe("runSchema: a validator's answer, synchronous when the validator is", () => {
	it("a sync validator's value comes back at once, not as a promise", () => {
		const value = runSchema(schemaOf("zod"), { a: 1 }, "json")
		expect([value instanceof Promise, value]).toEqual([false, { checked: { a: 1 } }])
	})

	it("an async validator's value comes back as a promise of it", async () => {
		const value = runSchema(schemaOf("zod", [], true), { a: 1 }, "json")
		expect([value instanceof Promise, await value]).toEqual([true, { checked: { a: 1 } }])
	})

	it.each([false, true])("issues are a 400 validation_failed with field errors (async: %s)", async (async) => {
		const schema = schemaOf(
			"zod",
			[{ code: "too_small", message: "Too short", path: ["name"] } as StandardSchemaIssue],
			async,
		)
		const error = await failure(() => runSchema(schema, {}, "search"))
		expect([error instanceof HoneyError, error.status, error.errorKey, { ...error.fields }]).toEqual([
			true,
			400,
			"validation_failed",
			{ name: [{ error_key: "field_too_small", message: "Too short", path: "search.name" }] },
		])
	})

	it("a sync validator's issues throw synchronously, before any promise", () => {
		const schema = schemaOf("zod", [{ message: "bad", path: ["a"] }])
		expect(() => runSchema(schema, {}, "params")).toThrow(HoneyError)
	})
})

/** `?query` as the key/value pairs a source collects, in request order. */
const pairs = (query: string): [string, string][] => [...new URLSearchParams(query)]

/** A schema that describes itself through Standard JSON Schema, as arktype and zod ≥ 4.2 do. */
function describing(properties: Record<string, object>, $defs: Record<string, object> = {}): StandardSchemaLike {
	return {
		"~standard": {
			jsonSchema: { input: () => ({ $defs, properties, type: "object" }) },
			validate: (value: unknown) => ({ value }),
			vendor: "arktype",
			version: 1,
		},
	} as StandardSchemaLike
}

describe("shapedRecord: one policy for repeated keys, in search and form", () => {
	// v0: 5f2ebb8e8a
	// v0: e840afdede
	it("zod: an array key always gets an array, a scalar key its first value, a union one or many", () => {
		const schema = z.object({
			ids: z.array(z.string()),
			page: z.coerce.number().optional(),
			u: z.union([z.string(), z.array(z.string())]),
		})
		expect([
			{ ...shapedRecord(pairs("ids=1&page=2&page=9&u=a"), shapeOf(schema)) },
			{ ...shapedRecord(pairs("ids=1&ids=2&u=a&u=b"), shapeOf(schema)) },
		]).toEqual([
			{ ids: ["1"], page: "2", u: "a" },
			{ ids: ["1", "2"], u: ["a", "b"] },
		])
	})

	// v0: e7196ec493
	it("a schema that describes itself as arktype does gets the same policy, through $defs and nullable types", () => {
		const schema = describing(
			{ ids: { $ref: "#/$defs/Ids" }, role: { type: "string" }, tag: { type: ["string", "null"] } },
			{ Ids: { type: "array" } },
		)
		expect({ ...shapedRecord(pairs("ids=1&role=user&role=admin&tag=a&tag=b"), shapeOf(schema)) }).toEqual({
			ids: ["1"],
			role: "user",
			tag: "a",
		})
	})

	// v0: 371882dde5
	// v0: 0ab54f4842
	it("valibot, or a schema that cannot describe itself: one value is a scalar, repeats an array", () => {
		const schema = v.object({ ids: v.union([v.string(), v.array(v.string())]) })
		expect([
			{ ...shapedRecord(pairs("ids=1"), shapeOf(schema)) },
			{ ...shapedRecord(pairs("ids=1&ids=2"), null) },
		]).toEqual([{ ids: "1" }, { ids: ["1", "2"] }])
	})

	it("drops __proto__, constructor and prototype, keeps a key that only contains one, on a record with no prototype", () => {
		const record = shapedRecord(pairs("__proto__=a&constructor=b&prototype=c&my__proto__field=d&ok=e"), null)
		expect([Object.getPrototypeOf(record), Object.keys(record), ({} as Record<string, unknown>).a]).toEqual([
			null,
			["my__proto__field", "ok"],
			undefined,
		])
	})
})

/** A schema whose Standard JSON Schema is `document`, or whose `input` answers `input` instead. */
function publishing(document: unknown, input?: () => unknown): StandardSchemaLike {
	return {
		"~standard": {
			jsonSchema: { input: input ?? (() => document) },
			validate: (value: unknown) => ({ value }),
			vendor: "test",
			version: 1,
		},
	} as StandardSchemaLike
}

/** The shape `shapeOf` reads off a schema whose only property `k` is `node`. */
const shapeOfKey = (node: object, root: object = {}) =>
	shapeOf(publishing({ ...root, properties: { k: node } }))?.get("k")

describe("shapeOf: each key's shape from a schema's Standard JSON Schema", () => {
	it.each<[string, object, string]>([
		["an array", { type: "array" }, "array"],
		["a string", { type: "string" }, "scalar"],
		["a nullable string", { type: ["string", "null"] }, "scalar"],
		["a nullable array", { type: ["array", "null"] }, "array"],
		["only null", { type: ["null"] }, "natural"],
		["a string or an array", { type: ["string", "array"] }, "natural"],
		["anyOf arrays", { anyOf: [{ type: "array" }, { type: "array" }] }, "array"],
		["oneOf scalars and null", { oneOf: [{ type: "string" }, { type: "number" }, { type: "null" }] }, "scalar"],
		["anyOf a scalar and an array", { anyOf: [{ type: "string" }, { type: "array" }] }, "natural"],
		["anyOf only null", { anyOf: [{ type: "null" }] }, "natural"],
		["allOf with an array part", { allOf: [{}, { type: "array" }] }, "array"],
		["allOf with a scalar part", { allOf: [{ type: "string" }, {}] }, "scalar"],
		["allOf with untyped parts", { allOf: [{}] }, "natural"],
		["untyped", {}, "natural"],
	])("%s is %s", (_label, node, shape) => {
		expect(shapeOfKey(node)).toBe(shape)
	})
})

describe("shapeOf: references, intersections, and schemas that cannot describe themselves", () => {
	it("follows $ref into $defs and definitions; a ref it cannot follow is untyped", () => {
		const root = { $defs: { A: { type: "array" } }, definitions: { S: { type: "string" } } }
		expect([
			shapeOfKey({ $ref: "#/$defs/A" }, root),
			shapeOfKey({ $ref: "#/definitions/S" }, root),
			shapeOfKey({ $ref: "#/$defs/Missing" }, root),
			shapeOfKey({ $ref: "#/definitions/S" }, {}),
			shapeOfKey({ $ref: "https://example.com/other" }, root),
		]).toEqual(["array", "scalar", "natural", "natural", "natural"])
	})

	it("reads properties through allOf, the first naming of a key kept, and stops on a self-reference", () => {
		const merged = shapeOf(
			publishing({
				allOf: [
					{ properties: { a: { type: "array" } } },
					{ properties: { a: { type: "string" }, b: { type: "string" } } },
				],
			}),
		)
		const cyclic = {
			$defs: { Loop: { allOf: [{ $ref: "#/$defs/Loop" }], properties: { x: { type: "string" } } } },
			$ref: "#/$defs/Loop",
		}
		expect([
			merged?.get("a"),
			merged?.get("b"),
			shapeOf(publishing(cyclic))?.get("x"),
			shapeOfKey({ $ref: "#/$defs/L" }, { $defs: { L: { allOf: [{ $ref: "#/$defs/L" }] } } }),
		]).toEqual(["array", "scalar", "scalar", "natural"])
	})

	it("is null for a schema that publishes nothing, publishes no object, or throws while describing itself", () => {
		const throwing = publishing(null, () => {
			throw new Error("unrepresentable")
		})
		expect([
			shapeOf(schemaOf("zod")),
			shapeOf(publishing("not an object")),
			shapeOf(publishing(null)),
			shapeOf(throwing),
		]).toEqual([null, null, null, null])
	})
})
