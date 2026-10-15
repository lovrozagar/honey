import { describe, expect, it } from "vitest"
import { compileMetaSpec, normalizeSecurity, securitySchemeNames } from "./meta-spec.ts"
import { applyMetaSpec } from "./meta-spec-apply.ts"
import { MetaSpecDiagnostics } from "./meta-spec-validate.ts"

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
