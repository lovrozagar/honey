import { describe, expect, it } from "vitest"
import {
	assembleRouteTree,
	packInputSchemas,
	packOutputSchemas,
	unpackInputSchemas,
	unpackOutputSchemas,
} from "../../../src/tree.ts"

describe("assembleRouteTree", () => {
	it("builds unique handlers and unique ek Sets from a packed table", () => {
		const tree = assembleRouteTree({
			b: "api_error",
			e: { t: [["unauthorized", "api_error"]], x: [0, 0] },
			s: ["GET /a", "GET /b"],
		})
		const a = tree.handlers?.["GET /a"]
		const b = tree.handlers?.["GET /b"]
		expect(a).toBeDefined()
		expect(b).toBeDefined()
		expect(a).not.toBe(b)
		expect(a?.ek).not.toBe(b?.ek)
		expect([...a!.ek]).toEqual(["unauthorized", "api_error"])
		a!.ek.add("extra")
		expect(b!.ek.has("extra")).toBe(false)
		expect(tree.root.s.a?.m?.GET).toBe(a)
		expect(tree.root.s.b?.m?.GET).toBe(b)
	})

	it("throws on a selector without a method/path split", () => {
		expect(() => assembleRouteTree({ s: ["NOPE"] })).toThrow("Invalid route selector: NOPE")
	})

	it("prepends shared error keys onto per-route extras", () => {
		const tree = assembleRouteTree({
			e: { t: [["taken"], []], x: [0, 1] },
			k: ["unauthorized", "api_error"],
			s: ["GET /a", "GET /b"],
		})
		expect([...tree.handlers!["GET /a"]!.ek]).toEqual(["unauthorized", "api_error", "taken"])
		expect([...tree.handlers!["GET /b"]!.ek]).toEqual(["unauthorized", "api_error"])
		expect(tree.handlers!["GET /a"]!.ek).not.toBe(tree.handlers!["GET /b"]!.ek)
	})

	it("expands packed meta keys from the u dictionary", () => {
		const tree = assembleRouteTree({
			m: [{ "0": "api", "1": "List" }],
			s: ["GET /items"],
			u: ["worker", "summary"],
		})
		expect(tree.handlers!["GET /items"]!.mt).toEqual({ summary: "List", worker: "api" })
		expect(tree.meta["GET /items"]).toEqual({ summary: "List", worker: "api" })
	})

	it("expands packed iv/os and leaves redirect maps alone", () => {
		const tree = assembleRouteTree({
			i: [
				packInputSchemas({
					json: { properties: { type: { type: "string" } }, required: ["type"], type: "object" },
				}),
			],
			o: [
				packOutputSchemas({
					"application/json": { ok: { additionalProperties: false, type: "object" } },
					redirect: { found: true },
				}),
			],
			s: ["POST /x"],
		})
		expect(tree.handlers?.["POST /x"]?.iv).toEqual({
			json: { properties: { type: { type: "string" } }, required: ["type"], type: "object" },
		})
		expect(tree.handlers?.["POST /x"]?.os).toEqual({
			"application/json": { ok: { additionalProperties: false, type: "object" } },
			redirect: { found: true },
		})
	})
})

describe("pack/unpack JSON Schema", () => {
	it("round-trips vocabulary keys without renaming property names", () => {
		const input = {
			json: {
				enum: ["type", "properties"],
				properties: { description: { type: "string" }, type: { type: "number" } },
				required: ["type"],
				type: "object",
			},
		}
		const packed = packInputSchemas(input)
		expect(packed).toEqual({
			j: {
				en: ["type", "properties"],
				p: { description: { t: "s" }, type: { t: "n" } },
				r: ["type"],
				t: "o",
			},
		})
		expect(unpackInputSchemas(packed)).toEqual(input)
	})

	it("round-trips output schemas including redirect", () => {
		const output = {
			"application/json": {
				ok: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
			},
			redirect: { moved_permanently: true },
		}
		const packed = packOutputSchemas(output)
		expect(packed).toEqual({
			j: {
				ok: { p: { id: { t: "s" } }, r: ["id"], t: "o" },
			},
			rd: { moved_permanently: true },
		})
		expect(unpackOutputSchemas(packed)).toEqual(output)
	})

	it("flattens nullable oneOf and restores branch order", () => {
		const input = {
			json: {
				oneOf: [{ maxLength: 8, type: "string" }, { type: "null" }],
			},
		}
		const packed = packInputSchemas(input)
		expect(packed).toEqual({ j: { n1: 1, t: "s", xl: 8 } })
		expect(unpackInputSchemas(packed)).toEqual(input)

		const nullFirst = {
			json: { oneOf: [{ type: "null" }, { type: "integer" }] },
		}
		const packedFirst = packInputSchemas(nullFirst)
		expect(packedFirst).toEqual({ j: { n1: 0, t: "i" } })
		expect(unpackInputSchemas(packedFirst)).toEqual(nullFirst)
	})

	it("packs format values", () => {
		const input = { json: { format: "email", type: "string" } }
		const packed = packInputSchemas(input)
		expect(packed).toEqual({ j: { f: "e", t: "s" } })
		expect(unpackInputSchemas(packed)).toEqual(input)
	})
})
