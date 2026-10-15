import { describe, expect, it } from "vitest"
import * as z from "zod"
import { compileMetaSpec, type MetaSpecConfig, publishableMetaKeys, resolveProfile } from "./meta-spec.ts"
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

	// v0: 001b3f8cab
	// v0: 1a621f1cc8
	// v0: 3bdae03f95
	// v0: 5b6a98538e
	// v0: 651204e065
	// v0: 6a9e7db589
	// v0: 94d4b1a23e
	// v0: 964ef4435d
	// v0: d46e65f666
	// v0: f288b9d733
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
})

describe("built-in policy: what is left out", () => {
	// v0: 58272980cd
	// v0: e4a255626d
	// v0: f2bfba1b62
	it("leaves out a falsy value, an empty invalidate and an mcp that is not true, and keeps a tag list as it is", () => {
		const falsy = { deprecated: false, invalidate: [], mcp: "yes", security: "", summary: "", tags: "" }
		expect([
			apply(null, falsy).operation,
			apply(null, { tags: ["a", "b"] }).operation,
			apply(null, { invalidate: null, summary: "s" }).operation,
		]).toEqual([{}, { tags: ["a", "b"] }, { summary: "s" }])
	})
})

describe("entry forms: verbatim, mapped, fanned out, per target", () => {
	// v0: 868952155a
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

	// v0: 835fb52200
	it("limits an entry to HTTP or WebSocket operations with `on`", () => {
		const config: MetaSpecConfig = { meta: { a: { key: "x-a", on: "http" }, b: { key: "x-b", on: "ws" } } }
		const meta = { a: 1, b: 2 }
		expect([apply(config, meta).operation, apply(config, meta, { kind: "ws" }).operation]).toEqual([
			{ "x-a": 1 },
			{ "x-b": 2 },
		])
	})

	// v0: e20edc0dbe
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

	// v0: 390472e5b2
	// v0: 49726217ca
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
	// v0: 04dc37f44b
	// v0: 4d938de6f2
	// v0: 60542cac6d
	// v0: 6136968bb5
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

	// v0: 0452211373
	// v0: 7b58ae28bc
	// v0: 97a18d1f88
	// v0: b7b9f17474
	// v0: ccbd175b21
	// v0: f4b5d9cebc
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
		/* include is default-deny: an extension the allowlist does not name stays out too */
		expect(apply(config, { ...meta, extensions: { "x-raw": 1 } }, { profile: "public" }).operation).toEqual({
			summary: "s",
			"x-plan": "pro",
		})
	})

	// v0: b9b2b4acdd
	it("refuses a profile the policy does not declare, and reads an undeclared default as no filter", () => {
		expect([apply(config, meta, { profile: "nope" }).codes, apply({ meta: {} }, { summary: "s" }).operation]).toEqual([
			["error UNKNOWN_PROFILE"],
			{ summary: "s" },
		])
	})
})

describe("precedence and emitted-value checks", () => {
	// v0: 1864cb6729
	// v0: 7bf16a3c75
	// v0: 9a51a70c4c
	// v0: a212bf87b2
	// v0: c23f37acfc
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

	// v0: 54f70166cb
	// v0: 5af6f559bb
	// v0: 839e66acac
	// v0: 8d862be62a
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

describe("totality: every meta key has an entry once a policy is declared", () => {
	// v0: 0c054d5b1d
	// v0: bcc25b6db2
	// v0: e57d2b35db
	it("is an error by default, a warning under warn, silent under off, and silent without a policy", () => {
		const meta = { custom: 1 }
		expect([
			apply({ meta: {} }, meta).codes,
			apply({ meta: {}, strict: "warn" }, meta).codes,
			apply({ meta: {}, strict: "off" }, meta).codes,
			apply(null, meta).codes,
		]).toEqual([["error MISSING_ENTRY"], ["warn MISSING_ENTRY"], [], []])
	})

	// v0: 53f9bf48b1
	// v0: ca4c899051
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
	// v0: 45360d3a8c
	// v0: 5c836f241a
	// v0: f74e46440c
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
	// v0: 3b3dc3bb38
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
