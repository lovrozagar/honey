import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { buildInventory, casesOf, classify, FEATURES, unaccounted, type V0Case } from "./v0-inventory.ts"

const REPO = resolve(import.meta.dirname, "../../../..")

const SOURCE = [
	'import { describe, expect, it } from "vitest"',
	'describe("cookies", () => {',
	'\tit("signs", () => {})',
	'\tdescribe.each([1, 2])("pair %i", () => {',
	'\t\tit.skipIf(true)("skips on ci", () => {})',
	"\t})",
	"\tfor (const n of [1, 2]) it(`loops ${n}`, () => {})",
	"})",
	'it.todo("later")',
	'test("plain", () => {})',
	'it("signs", () => {})',
	"",
].join("\n")

describe("casesOf", () => {
	it("names every case by its describe path, through each / skipIf / todo / loops", () => {
		expect(casesOf("_v0/tests/unit/cookie/c.test.ts", SOURCE).map((c) => c.name)).toEqual([
			"cookies > signs",
			"cookies > pair %i > skips on ci",
			"cookies > loops ${n}",
			"later",
			"plain",
			"signs",
		])
	})

	it("gives each case a stable short id, distinct for repeated names", () => {
		const first = casesOf("_v0/tests/unit/cookie/c.test.ts", SOURCE)
		const again = casesOf("_v0/tests/unit/cookie/c.test.ts", SOURCE)
		expect(first.map((c) => c.id)).toEqual(again.map((c) => c.id))
		expect(new Set(first.map((c) => c.id)).size).toBe(first.length)
		expect(first[0]?.id).toMatch(/^[0-9a-f]{10}$/)
		const other = casesOf("_v0/tests/unit/cookie/d.test.ts", SOURCE)
		expect(other[0]?.id).not.toBe(first[0]?.id)
	})
})

describe("classify", () => {
	it("homes a case with the bit that owns its feature", () => {
		expect(classify("_v0/tests/unit/codegen/codegen-mcp.test.ts", "tools > input schema")).toBe("18-mcp")
		expect(classify("_v0/tests/unit/codegen/go-cli/basic-crud.test.ts", "generates commands")).toBe(
			"17-cli-gold-standard",
		)
		expect(classify("_v0/tests/integration/sdk-harness/rust-harness.test.ts", "compiles")).toBe("13-rust-sdk")
		expect(classify("_v0/tests/unit/client/sse.test.ts", "parses events")).toBe("11-ts-client")
		expect(classify("_v0/tests/unit/cors/preflight.test.ts", "preflight")).toBe("07-security-middleware")
		expect(classify("_v0/tests/unit/cookie/cookie.test.ts", "round trips")).toBe("02-finalize-middleware")
		expect(classify("_v0/tests/unit/request/client-ip.test.ts", "trusted hops")).toBe("03-request-trust-adapters")
		expect(classify("_v0/tests/unit/realtime/server.test.ts", "publishes")).toBe("06-realtime")
		expect(classify("_v0/tests/unit/core/core.test.ts", "matches a param route")).toBe("01-core-route-model")
	})

	it("reads the titles of a session-dump file to find its feature", () => {
		expect(classify("_v0/tests/integration/bug-hunt-7.test.ts", "SSE stream > closes on abort")).toBe(
			"05-streaming-sse-range",
		)
		expect(classify("_v0/tests/integration/bug-hunt-7.test.ts", "validation > rejects bad json")).toBe("08-io")
		expect(classify("_v0/tests/unit/core/edge-cases-3.test.ts", "openapi > emits tags")).toBe("10-openapi-emit")
	})

	it("only names features a bit owns", () => {
		const bits = FEATURES.map((f) => f.slice(0, 2))
		expect(bits).toEqual([...bits].toSorted())
		expect(new Set(bits).size).toBe(bits.length)
	})
})

describe("unaccounted", () => {
	const cases: V0Case[] = [
		{ feature: "01-core-route-model", file: "a", id: "aaaaaaaaaa", name: "x" },
		{ feature: "01-core-route-model", file: "a", id: "bbbbbbbbbb", name: "y" },
		{ feature: "08-io", file: "b", id: "cccccccccc", name: "z" },
	]

	it("needs nothing before a feature's bit completes", () => {
		expect(unaccounted(cases, { complete: 0, ported: new Set(), retired: {} })).toEqual([])
	})

	it("lists the completed features' cases that are neither ported nor retired", () => {
		const ported = new Set(["aaaaaaaaaa"])
		expect(unaccounted(cases, { complete: 1, ported, retired: {} })).toEqual(["01-core-route-model bbbbbbbbbb y"])
		expect(unaccounted(cases, { complete: 1, ported, retired: { bbbbbbbbbb: "runtime removed" } })).toEqual([])
		expect(unaccounted(cases, { complete: 8, ported, retired: {} })).toEqual([
			"01-core-route-model bbbbbbbbbb y",
			"08-io cccccccccc z",
		])
	})

	it("follows a case a bit owner reassigned to another feature", () => {
		const reassigned = { bbbbbbbbbb: "08-io" } as const
		expect(unaccounted(cases, { complete: 1, ported: new Set(["aaaaaaaaaa"]), reassigned, retired: {} })).toEqual([])
		expect(unaccounted(cases, { complete: 8, ported: new Set(["aaaaaaaaaa"]), reassigned, retired: {} })).toEqual([
			"08-io bbbbbbbbbb y",
			"08-io cccccccccc z",
		])
	})
})

describe("the committed inventory", () => {
	it("matches what the frozen v0 suite holds now", () => {
		const committed = JSON.parse(readFileSync(join(REPO, "blueprint/baselines/v0-cases.json"), "utf8")) as {
			cases: V0Case[]
		}
		expect(buildInventory(REPO).cases).toEqual(committed.cases)
	})
})
