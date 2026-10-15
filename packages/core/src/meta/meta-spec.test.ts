import { describe, expect, it } from "vitest"
import * as z from "zod"
import {
	compileMetaSpec,
	type MetaSpecConfig,
	normalizeSecurity,
	publishableMetaKeys,
	resolveProfile,
	securitySchemeNames,
} from "./meta-spec.ts"
import { applyMetaSpec } from "./meta-spec-apply.ts"
import { MetaSpecDiagnostics, type SchemaMetaLookup } from "./meta-spec-validate.ts"

/** A schema lookup that finds `region: "schema"` on the output and nothing else. */
const regionOnOutput: SchemaMetaLookup = (source, key) =>
	source === "output" && key === "region" ? { found: true, value: "schema" } : { found: false }

type Run = {
	readonly kind?: "http" | "ws"
	readonly path?: string
	readonly profile?: string
	readonly schemaMeta?: SchemaMetaLookup
}

/** The operation fields `config` writes for one route carrying `meta`, with every diagnostic. */
function apply(config: MetaSpecConfig | null, meta: Record<string, unknown> | null, run: Run = {}) {
	const diagnostics = new MetaSpecDiagnostics()
	const spec = compileMetaSpec(config, diagnostics)
	const { filter, name } = resolveProfile(spec, run.profile, diagnostics)
	const operation: Record<string, unknown> = {}
	applyMetaSpec({
		diagnostics,
		filter,
		kind: run.kind ?? "http",
		meta,
		method: "get",
		operation,
		path: run.path ?? "/a",
		profile: name,
		schemaMeta: run.schemaMeta,
		spec,
	})
	return { codes: diagnostics.list.map(({ code, level }) => `${level} ${code}`), operation }
}

describe("normalizeSecurity: the shorthands, and nothing guessed", () => {
	// v0: 3596cb67e7
	// v0: df392f6d8d
	// v0: a1f55ccab3
	// v0: a98776f551
	// v0: c03ba04087
	// v0: d3eb0a8fe5
	// v0: ee2751530b
	it.each([
		["a name is one requirement", "jwt", [{ jwt: [] }]],
		["[] is explicitly no authentication", [], []],
		["names are alternatives", ["jwt", "key"], [{ jwt: [] }, { key: [] }]],
		["a group is all of its names", [["key", "domain"]], [{ domain: [], key: [] }]],
		["groups are alternatives", [["a", "b"], ["c"]], [{ a: [], b: [] }, { c: [] }]],
		["requirement objects pass through", [{ oauth: ["read"] }], [{ oauth: ["read"] }]],
		["an empty group requires nothing", [[]], [{}]],
	])("%s", (_name, raw, expected) => {
		expect(normalizeSecurity(raw)).toEqual(expected)
	})

	// v0: 0bf3d7c015
	// v0: abeedf9d21
	// v0: a342138899
	// v0: 912d6c3adf
	it("refuses a mix, a non-array, an empty name and a requirement whose scopes are no list", () => {
		for (const raw of [["jwt", ["key"]], [["key"], { jwt: [] }], 42, null, "", [{ jwt: "read" }], [{ "": [] }]]) {
			expect(() => normalizeSecurity(raw), JSON.stringify(raw)).toThrow(TypeError)
		}
	})

	it("names every scheme a security list refers to, once", () => {
		expect([securitySchemeNames([{ a: [], b: [] }, { a: [] }, null]), securitySchemeNames("jwt")]).toEqual([
			["a", "b"],
			[],
		])
	})
})

describe("built-in policy: what reaches an operation without a metaSpec", () => {
	const meta = {
		deprecated: true,
		description: "d",
		extensions: { "x-rate": 5 },
		internal: false,
		invalidate: ["a", "b", "a"],
		mcp: true,
		operationId: "users.get",
		security: "jwt",
		summary: "s",
		tags: "Users",
	}

	it("maps the eight built-in keys in their order, hides internal, and passes extensions through", () => {
		const { codes, operation } = apply(null, meta)
		expect(codes).toEqual([])
		expect(Object.entries(operation)).toEqual([
			["summary", "s"],
			["description", "d"],
			["tags", ["Users"]],
			["deprecated", true],
			["operationId", "users.get"],
			["security", [{ jwt: [] }]],
			["x-invalidate", ["a", "b"]],
			["x-mcp", true],
			["x-rate", 5],
		])
	})

	it("gives a WebSocket operation only summary, description, tags and operationId, and checks no totality", () => {
		expect(apply(null, { ...meta, custom: 1 }, { kind: "ws" }).operation).toEqual({
			description: "d",
			operationId: "users.get",
			summary: "s",
			tags: ["Users"],
			"x-rate": 5,
		})
	})

	it("leaves out a falsy value, an empty invalidate and an mcp that is not true, and keeps a tag list as it is", () => {
		const falsy = { deprecated: false, invalidate: [], mcp: "yes", security: "", summary: "", tags: "" }
		expect([apply(null, falsy).operation, apply(null, { tags: ["a", "b"] }).operation]).toEqual([
			{},
			{ tags: ["a", "b"] },
		])
	})
})

describe("entry forms: verbatim, mapped, fanned out, per target", () => {
	it("writes a verbatim key, a mapped value, a standard field, and nothing where a map answers undefined", () => {
		const config: MetaSpecConfig = {
			meta: {
				area: "x-area",
				cost: { key: "x-cost", map: (value) => (value === 0 ? undefined : `${String(value)}¢`) },
				owner: { key: "summary", map: (value) => `owned by ${String(value)}` },
			},
		}
		expect([
			apply(config, { area: "eu", cost: 3, owner: "me" }).operation,
			apply(config, { cost: 0 }).operation,
		]).toEqual([{ summary: "owned by me", "x-area": "eu", "x-cost": "3¢" }, {}])
	})

	it("limits an entry to HTTP or WebSocket operations with `on`", () => {
		const config: MetaSpecConfig = { meta: { a: { key: "x-a", on: "http" }, b: { key: "x-b", on: "ws" } } }
		const meta = { a: 1, b: 2 }
		expect([apply(config, meta).operation, apply(config, meta, { kind: "ws" }).operation]).toEqual([
			{ "x-a": 1 },
			{ "x-b": 2 },
		])
	})

	it("fans one value out with expand, dropping an undefined key and an undefined answer", () => {
		const config: MetaSpecConfig = {
			meta: {
				plan: { expand: (value) => (value === "none" ? undefined : { "x-plan": value, "x-tier": undefined }) },
			},
		}
		expect([apply(config, { plan: "pro" }).operation, apply(config, { plan: "none" }).operation]).toEqual([
			{ "x-plan": "pro" },
			{},
		])
	})

	it("refuses an expand key the route owns, and two expands writing one key", () => {
		const bad: MetaSpecConfig = { meta: { a: { expand: () => ({ responses: {}, "x-ok": 1 }) } } }
		const twice: MetaSpecConfig = { meta: { a: { expand: () => ({ "x-k": 1 }) }, b: { expand: () => ({ "x-k": 2 }) } } }
		expect([apply(bad, { a: 1 }), apply(twice, { a: 1, b: 1 }).codes]).toEqual([
			{ codes: ["error RESERVED_FIELD"], operation: { "x-ok": 1 } },
			["error DUPLICATE_TARGET"],
		])
	})
})

describe("meta.extensions: the escape hatch", () => {
	it("passes x- keys through above every entry, skips undefined, refuses another key, and ignores a non-object", () => {
		const config: MetaSpecConfig = { meta: { a: "x-a" } }
		expect([
			apply(config, { a: 1, extensions: { "x-a": 2, "x-b": undefined } }),
			apply(config, { extensions: { summary: "s" } }),
			apply(config, { extensions: ["x-a"] }),
		]).toEqual([
			{ codes: [], operation: { "x-a": 2 } },
			{ codes: ["error UNKNOWN_FIELD"], operation: {} },
			{ codes: [], operation: {} },
		])
	})
})

describe("profiles: one app, several documents", () => {
	const config: MetaSpecConfig = {
		meta: { cost: "x-cost", plan: "x-plan", team: { key: "x-team", profiles: ["internal"] } },
		profiles: {
			both: { exclude: ["x-plan"], include: ["x-plan", "x-cost"] },
			internal: {},
			lean: { exclude: ["x-cost", "summary"] },
			public: { include: ["x-plan"] },
		},
	}
	const meta = { cost: 1, plan: "pro", summary: "s", team: "core" }

	it("filters nothing by default, drops what exclude lists, and allowlists x- keys with include", () => {
		expect(
			[undefined, "lean", "public", "both", "internal"].map((profile) => apply(config, meta, { profile }).operation),
		).toEqual([
			{ summary: "s", "x-cost": 1, "x-plan": "pro" },
			{ "x-plan": "pro" },
			{ summary: "s", "x-plan": "pro" },
			{ summary: "s", "x-cost": 1 },
			{ summary: "s", "x-cost": 1, "x-plan": "pro", "x-team": "core" },
		])
	})

	it("refuses a profile the policy does not declare, and reads an undeclared default as no filter", () => {
		expect([apply(config, meta, { profile: "nope" }).codes, apply({ meta: {} }, { summary: "s" }).operation]).toEqual([
			["error UNKNOWN_PROFILE"],
			{ summary: "s" },
		])
	})
})

describe("precedence and emitted-value checks", () => {
	it("lets route meta beat a schema-derived value, keeps first-write key order, and replaces a built-in", () => {
		const config: MetaSpecConfig = {
			meta: { region: "x-region", summary: { key: "summary", map: (value) => `S: ${String(value)}` } },
			schema: { region: { key: "x-region" } },
		}
		const { operation } = apply(config, { region: "meta", summary: "s" }, { schemaMeta: regionOnOutput })
		expect(Object.entries(operation)).toEqual([
			["summary", "S: s"],
			["x-region", "meta"],
		])
	})

	it("emits a value its schema accepts, and refuses an invalid one, an async schema, and a whole bad expand", () => {
		const asyncSchema = { "~standard": { validate: async () => ({ value: 1 }), vendor: "t", version: 1 as const } }
		const config: MetaSpecConfig = {
			meta: {
				a: { key: "x-a", schema: z.number() },
				b: { key: "x-b", schema: asyncSchema },
				c: { expand: (value) => ({ "x-c": value }), schema: z.object({ "x-c": z.string() }) },
			},
		}
		expect([apply(config, { a: 1 }), apply(config, { a: "1" }).codes, apply(config, { b: 1 }).codes]).toEqual([
			{ codes: [], operation: { "x-a": 1 } },
			["error INVALID_VALUE"],
			["error ASYNC_VALIDATION"],
		])
		expect([apply(config, { c: "ok" }).operation, apply(config, { c: 1 }).codes]).toEqual([
			{ "x-c": "ok" },
			["error INVALID_VALUE"],
		])
	})
})

describe("policy errors, collected rather than thrown", () => {
	it("refuses a reserved field, an unknown field and two entries writing one key at one rank", () => {
		const diagnostics = new MetaSpecDiagnostics()
		compileMetaSpec({ meta: { a: "responses", b: "colour", c: "x-k", d: { key: "x-k" } } }, diagnostics)
		expect(diagnostics.list.map(({ code }) => code)).toEqual(["RESERVED_FIELD", "UNKNOWN_FIELD", "DUPLICATE_TARGET"])
	})

	it("reports a map that throws, once however many routes repeat it, and keeps the rest of the operation", () => {
		const diagnostics = new MetaSpecDiagnostics()
		const spec = compileMetaSpec(
			{
				meta: {
					a: {
						key: "x-a",
						map: () => {
							throw new Error("boom")
						},
					},
					b: "x-b",
				},
			},
			diagnostics,
		)
		const operation: Record<string, unknown> = {}
		for (let i = 0; i < 3; i++) {
			applyMetaSpec({
				diagnostics,
				filter: () => true,
				kind: "http",
				meta: { a: 1, b: 2 },
				method: "get",
				operation,
				path: "/a",
				profile: "default",
				spec,
			})
		}
		expect([operation, diagnostics.list]).toEqual([
			{ "x-b": 2 },
			[{ code: "MAP_THREW", level: "error", message: 'get /a — meta."a" threw: boom' }],
		])
	})
})

describe("totality: every meta key has an entry once a policy is declared", () => {
	it("is an error by default, a warning under warn, silent under off, and silent without a policy", () => {
		const meta = { custom: 1 }
		expect([
			apply({ meta: {} }, meta).codes,
			apply({ meta: {}, strict: "warn" }, meta).codes,
			apply({ meta: {}, strict: "off" }, meta).codes,
			apply(null, meta).codes,
		]).toEqual([["error MISSING_ENTRY"], ["warn MISSING_ENTRY"], [], []])
	})

	it("names the key and the first route, suggests false, and reports a key once across routes", () => {
		const diagnostics = new MetaSpecDiagnostics()
		const spec = compileMetaSpec({ meta: {} }, diagnostics)
		for (const path of ["/a", "/b"]) {
			applyMetaSpec({
				diagnostics,
				filter: () => true,
				kind: "http",
				meta: { custom: 1 },
				method: "get",
				operation: {},
				path,
				profile: "default",
				spec,
			})
		}
		expect(diagnostics.list).toEqual([
			{
				code: "MISSING_ENTRY",
				level: "error",
				message:
					'meta key "custom" (first seen on get /a) has no metaSpec entry — map it to an operation key or set it to `false` to hide it',
			},
		])
	})
})

describe("hidden keys", () => {
	it("keeps a false key out of every document and the published manifest, beside internal and extensions", () => {
		const config: MetaSpecConfig = { meta: { secret: false, summary: false, team: "x-team" } }
		const publishable = publishableMetaKeys(config)
		expect(apply(config, { internal: true, secret: "s", summary: "s", team: "t" })).toEqual({
			codes: [],
			operation: { "x-team": "t" },
		})
		expect(["secret", "summary", "team", "tags", "internal", "extensions", "other"].map(publishable)).toEqual([
			false,
			false,
			true,
			true,
			false,
			false,
			false,
		])
	})
})

/** The codes compiling a policy of `meta` entries reports. */
function compiledCodes(meta: MetaSpecConfig["meta"]) {
	const diagnostics = new MetaSpecDiagnostics()
	compileMetaSpec({ meta }, diagnostics)
	return diagnostics.list.map(({ code }) => code)
}

describe("duplicates only where two entries meet one operation", () => {
	it("lets HTTP-only and WebSocket-only entries, or entries of disjoint profiles, share a key", () => {
		expect([
			compiledCodes({ a: { key: "x-k", on: "http" }, b: { key: "x-k", on: "ws" } }),
			compiledCodes({ a: { key: "x-k", on: "ws" }, b: { key: "x-k", on: "http" } }),
			compiledCodes({ a: { key: "x-k", profiles: ["one"] }, b: { key: "x-k", profiles: ["two"] } }),
			compiledCodes({ a: { key: "x-k", profiles: ["one"] }, b: { key: "x-k", profiles: ["two", "one"] } }),
			compiledCodes({ a: { key: "responses" } }),
		]).toEqual([[], [], [], ["DUPLICATE_TARGET"], ["RESERVED_FIELD"]])
	})

	it("omits a verbatim key whose value is undefined, an expand whose every key is, and a schema entry without a lookup", () => {
		const config: MetaSpecConfig = {
			meta: { a: "x-a", b: { expand: () => ({ "x-b": undefined }) } },
			schema: { c: { key: "x-c" } },
		}
		expect(apply(config, { a: undefined, b: 1 })).toEqual({ codes: [], operation: {} })
		expect(publishableMetaKeys(null)("summary")).toBe(true)
	})

	it("reports a thrown value that is no Error by its text", () => {
		const config: MetaSpecConfig = {
			meta: {
				a: {
					key: "x-a",
					map: () => {
						throw "nope"
					},
				},
			},
		}
		expect(apply(config, { a: 1 }).codes).toEqual(["error MAP_THREW"])
	})
})
