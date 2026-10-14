import { describe, expect, it } from "vitest"
import { formatLine } from "./log-format.ts"

const TIME = Date.UTC(2026, 9, 14, 6, 55, 1, 234)

describe("formatLine: json", () => {
	it("is the record as one JSON line", () => {
		expect(formatLine("json", { level: 30, msg: "hi", n: 1, time: TIME })).toBe(
			`{"level":30,"msg":"hi","n":1,"time":${TIME}}`,
		)
	})

	it("never fails on what JSON cannot hold: a BigInt is its digits, a cycle is [Circular]", () => {
		const cycle: Record<string, unknown> = { a: 1 }
		cycle.self = cycle
		expect(JSON.parse(formatLine("json", { big: 2n ** 64n, cycle, level: 30, msg: "", time: TIME }))).toEqual({
			big: "18446744073709551616",
			cycle: { a: 1, self: "[Circular]" },
			level: 30,
			msg: "",
			time: TIME,
		})
	})

	it("an object that appears twice but not inside itself is written both times", () => {
		const shared = { x: 1 }
		expect(JSON.parse(formatLine("json", { a: shared, b: shared, level: 30, msg: "", time: TIME }))).toMatchObject({
			a: { x: 1 },
			b: { x: 1 },
		})
	})
})

describe("formatLine: pretty", () => {
	it.each([
		["a bare message", { level: 30, msg: "listening", time: TIME }, "06:55:01.234 INFO  listening"],
		["fields after it", { level: 40, msg: "slow", ms: 812, time: TIME }, '06:55:01.234 WARN  slow {"ms":812}'],
		["an unknown level as its number", { level: 35, msg: "x", time: TIME }, "06:55:01.234 35    x"],
	])("%s", (_name, record, line) => {
		expect(formatLine("pretty", record)).toBe(line)
	})

	it("an error field's stack follows on its own lines", () => {
		const err = { message: "boom", name: "Error", stack: "Error: boom\n    at handler (app.ts:1:1)" }
		expect(formatLine("pretty", { err, level: 50, msg: "failed", time: TIME })).toBe(
			`06:55:01.234 ERROR failed ${JSON.stringify({ err })}\nError: boom\n    at handler (app.ts:1:1)`,
		)
	})
})
