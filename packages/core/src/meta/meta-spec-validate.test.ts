import { describe, expect, it, vi } from "vitest"
import type { JsonSchema } from "../schema/to-json-schema.ts"
import { compileMetaSpec, type MetaSpecConfig, type MetaSpecSchemaSource } from "./meta-spec.ts"
import { applyMetaSpec } from "./meta-spec-apply.ts"
import { checkTargetKey, MetaSpecDiagnostics, schemaMetaLookup } from "./meta-spec-validate.ts"

type Roots = Partial<Record<MetaSpecSchemaSource, JsonSchema>>

/** The operation `config`'s schema entries write for a route whose schemas are `roots`. */
function fromSchemas(config: MetaSpecConfig, roots: Roots) {
	const diagnostics = new MetaSpecDiagnostics()
	const spec = compileMetaSpec({ strict: "off", ...config }, diagnostics)
	const operation: Record<string, unknown> = {}
	const args = { diagnostics, filter: () => true, kind: "http", meta: null, method: "get", path: "/a" } as const
	applyMetaSpec({ ...args, operation, profile: "default", schemaMeta: schemaMetaLookup(roots), spec })
	return { codes: diagnostics.list.map(({ code }) => code), operation }
}

describe("MetaSpecDiagnostics: collected, never printed", () => {
	// v0: ecc28ae3e7
	it("keeps one of each code and message, and hands warnings back when nothing failed", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const diagnostics = new MetaSpecDiagnostics()
		diagnostics.add("MISSING_ENTRY", "warn", "m")
		diagnostics.add("MISSING_ENTRY", "warn", "m")
		diagnostics.add("UNKNOWN_FIELD", "warn", "m")
		expect(diagnostics.throwIfErrors()).toEqual([
			{ code: "MISSING_ENTRY", level: "warn", message: "m" },
			{ code: "UNKNOWN_FIELD", level: "warn", message: "m" },
		])
		expect(warn).not.toHaveBeenCalled()
		warn.mockRestore()
	})

	it("throws a short list whole", () => {
		const diagnostics = new MetaSpecDiagnostics()
		diagnostics.add("INVALID_VALUE", "error", "bad")
		expect(() => diagnostics.throwIfErrors()).toThrow(
			/^\[honey:metaSpec\] 1 policy error\(s\):\n {2}- INVALID_VALUE: bad$/,
		)
	})

	// v0: 7387b8cccb
	// v0: ab689f33ae
	it("throws every error at once, the first twenty listed and the rest counted", () => {
		const diagnostics = new MetaSpecDiagnostics()
		for (let i = 0; i < 22; i++) diagnostics.add("INVALID_VALUE", "error", `bad ${i}`)
		diagnostics.add("MISSING_ENTRY", "warn", "w")
		expect(() => diagnostics.throwIfErrors()).toThrow(
			/^\[honey:metaSpec\] 22 policy error\(s\):\n {2}- INVALID_VALUE: bad 0\n[\s\S]*- INVALID_VALUE: bad 19\n {2}… and 2 more$/,
		)
	})
})

describe("checkTargetKey: what a policy may write", () => {
	it("takes an x- extension or an allowed standard field, and refuses what the route owns or nobody knows", () => {
		const diagnostics = new MetaSpecDiagnostics()
		const keys = ["x-any", "summary", "externalDocs", "servers", "requestBody", "colour"]
		expect(keys.map((key) => checkTargetKey(key, "meta.a", diagnostics))).toEqual([
			true,
			true,
			true,
			true,
			false,
			false,
		])
		expect(diagnostics.list).toEqual([
			{ code: "RESERVED_FIELD", level: "error", message: 'meta.a targets reserved operation field "requestBody"' },
			{
				code: "UNKNOWN_FIELD",
				level: "error",
				message:
					'meta.a targets "colour", which is neither an "x-" extension nor an allowed standard field ' +
					"(deprecated, description, externalDocs, operationId, security, servers, summary, tags)",
			},
		])
	})
})

const ARTICLE = { properties: { id: { type: "string" } }, "x-entity": { name: "article" }, type: "object" }

describe("schemaMetaLookup: a metadata key on a route's JSON Schema", () => {
	// v0: 1129ba4760
	// v0: c77faa6505
	it("reads the root, reads through one level of items, and prefers the array's own key", () => {
		const lookup = schemaMetaLookup({
			"input.json": { items: ARTICLE, "x-entity": { name: "list" }, type: "array" },
			output: { items: ARTICLE, type: "array" },
		})
		expect([
			lookup("output", "x-entity", "root"),
			lookup("input.json", "x-entity", "root"),
			lookup("input.search", "x-entity", "root"),
			lookup("output", "x-other", "root"),
		]).toEqual([
			{ found: true, value: { name: "article" } },
			{ found: true, value: { name: "list" } },
			{ found: false },
			{ found: false },
		])
	})

	// v0: 5640229457
	// v0: 68dc580ef7
	// v0: 8bc90180d2
	// v0: 9cf1433f18
	// v0: d9c8036451
	it("searches deep only when asked, takes the shallowest hit, and refuses two different ones at one depth", () => {
		const envelope = {
			properties: { articles: { items: ARTICLE, type: "array" }, count: { type: "number" } },
			type: "object",
		}
		const shallow = { ...envelope, properties: { ...envelope.properties, top: { "x-entity": { name: "top" } } } }
		const twice = { anyOf: [ARTICLE, { "x-entity": { name: "other" } }] }
		const same = { anyOf: [ARTICLE, ARTICLE] }
		const lookup = schemaMetaLookup({
			"input.form": same,
			"input.json": twice,
			"input.search": shallow,
			output: envelope,
		})
		expect([
			lookup("output", "x-entity", "root"),
			lookup("output", "x-entity", "deep"),
			lookup("input.search", "x-entity", "deep"),
			lookup("input.json", "x-entity", "deep"),
			lookup("input.form", "x-entity", "deep"),
		]).toEqual([
			{ found: false },
			{ found: true, value: { name: "article" } },
			{ found: true, value: { name: "top" } },
			{ found: "ambiguous", values: [{ name: "article" }, { name: "other" }] },
			{ found: true, value: { name: "article" } },
		])
	})
})

describe("schemaMetaLookup: how deep a search goes", () => {
	it("stops a deep search six levels down", () => {
		let schema: JsonSchema = { "x-k": 1 }
		for (let i = 0; i < 7; i++) schema = { items: schema }
		expect(schemaMetaLookup({ output: schema })("output", "x-k", "deep")).toEqual({ found: false })
	})
})

describe("schema entries: reading a descriptor off the route's schemas", () => {
	// v0: 1976f15140
	// v0: 833df127c6
	// v0: fc5800aa5f
	it("searches the sources in order, reads another key with read, and leaves a route without the key alone", () => {
		const config: MetaSpecConfig = {
			schema: { entity: { key: "x-entity", read: "x-entity" }, query: { from: ["input.search"], key: "x-query" } },
		}
		const query = { query: { sort: ["name"] }, type: "object" }
		expect([
			fromSchemas(config, { "input.json": { "x-entity": "body" }, output: { "x-entity": "out" } }),
			fromSchemas(config, { "input.json": { "x-entity": "body" }, "input.search": query }),
			fromSchemas(config, {}),
		]).toEqual([
			{ codes: [], operation: { "x-entity": "out" } },
			{ codes: [], operation: { "x-entity": "body", "x-query": { sort: ["name"] } } },
			{ codes: [], operation: {} },
		])
	})

	// v0: 04be870b97
	// v0: 19c8e5937c
	// v0: 4e705cf05f
	it("emits a stamped null, omits what an expand maps to undefined, and refuses an ambiguous deep hit", () => {
		const config: MetaSpecConfig = {
			schema: {
				entity: {
					expand: (e: { searchable: null }) => ({ "x-omitted": e.searchable ?? undefined, "x-raw": e.searchable }),
					from: ["output"],
				},
				many: { from: ["output"], key: "x-many", search: "deep" },
			},
		}
		const output = { anyOf: [{ many: 1 }, { many: 2 }], entity: { searchable: null } }
		expect(fromSchemas(config, { output })).toEqual({ codes: ["AMBIGUOUS_SCHEMA_KEY"], operation: { "x-raw": null } })
	})
})

/** A policy whose one entry refuses a descriptor past version 1 of `field`. */
function guarded(field?: string): MetaSpecConfig {
	return { schema: { entity: { key: "x-entity", read: "x-comb", version: { field, max: 1 } } } }
}

describe("schema entries: one reserved key, several kinds, versioned", () => {
	const config: MetaSpecConfig = {
		schema: {
			entity: { key: "x-entity", map: (d: { table: string }) => d.table, match: { kind: "entity" }, read: "x-comb" },
			query: { key: "x-query", map: (d: { sort: string[] }) => d.sort, match: { kind: "query" }, read: "x-comb" },
		},
	}
	const entity = { "x-comb": { kind: "entity", table: "users", v: 1 } }
	const query = { "x-comb": { kind: "query", sort: ["name"], v: 1 } }

	// v0: 6a5c42389a
	// v0: f3f993f6b5
	it("lets each entry claim its own kind from one key on different sources, skipping the other kind", () => {
		expect(fromSchemas(config, { "input.search": query, output: entity })).toEqual({
			codes: [],
			operation: { "x-entity": "users", "x-query": ["name"] },
		})
	})

	// v0: 13b8ce8425
	it("refuses a descriptor no entry claims", () => {
		expect(fromSchemas(config, { output: { "x-comb": { kind: "job" } } }).codes).toEqual([
			"DESCRIPTOR_MISMATCH",
			"DESCRIPTOR_MISMATCH",
		])
	})

	// v0: 1ba062a79d
	// v0: 310b7c427c
	// v0: 84ffa6b4ff
	it("refuses a descriptor newer than the entry handles, or with no version, under a guard; honors a named field", () => {
		expect([
			fromSchemas(guarded(), { output: { "x-comb": { v: 2 } } }).codes,
			fromSchemas(guarded(), { output: { "x-comb": { kind: "entity" } } }).codes,
			fromSchemas(guarded(), { output: { "x-comb": "not an object" } }).codes,
			fromSchemas(guarded("rev"), { output: { "x-comb": { rev: 1 } } }),
		]).toEqual([
			["UNSUPPORTED_VERSION"],
			["UNSUPPORTED_VERSION"],
			["UNSUPPORTED_VERSION"],
			{ codes: [], operation: { "x-entity": { rev: 1 } } },
		])
	})
})
