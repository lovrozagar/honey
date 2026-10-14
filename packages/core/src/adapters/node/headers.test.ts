import { afterEach, describe, expect, it } from "vitest"
import { httpParser } from "./__fixtures__/parsed.ts"
import { NodeHeaders } from "./headers.ts"

const parser = httpParser()
afterEach(() => parser.close())

/** The view over the headers node:http parsed from these lines. */
async function viewOf(headers: readonly (readonly [string, string])[]): Promise<NodeHeaders> {
	return new NodeHeaders(await parser.parse({ headers }))
}

const repeated = [
	["Host", "h"],
	["Authorization", "a"],
	["authorization", "b"],
	["X-Multi", "1"],
	["x-multi", "2"],
] as const

describe("NodeHeaders: reading Node's parsed headers", () => {
	// v0: bbbebf177f
	// v0: 62b3c50f48
	it("reports every value of a repeated header, the same before and after iteration", async () => {
		const view = await viewOf(repeated)
		const read = () => [view.get("authorization"), view.get("X-MULTI"), view.get("missing")]
		const before = read()
		expect([...view]).toEqual([
			["authorization", "a, b"],
			["host", "h"],
			["x-multi", "1, 2"],
		])
		expect([before, read()]).toEqual([
			["a, b", "1, 2", null],
			["a, b", "1, 2", null],
		])
	})

	it("answers has() from the parsed map, then from the built Headers", async () => {
		const view = await viewOf(repeated)
		expect([view.has("Host"), view.has("nope")]).toEqual([true, false])
		view.delete("host")
		expect([view.has("host"), view.get("host")]).toEqual([false, null])
	})
})

describe("NodeHeaders: a full Headers once something writes", () => {
	it("set, append, getSetCookie, forEach, keys, values and entries all read one Headers", async () => {
		const view = await viewOf([["Host", "h"]])
		view.set("x-one", "1")
		view.append("set-cookie", "a=1")
		view.append("set-cookie", "b=2")
		const seen: string[] = []
		view.forEach((value, key) => seen.push(`${key}=${value}`))
		expect({
			cookies: view.getSetCookie(),
			entries: [...view.entries()].length,
			keys: [...view.keys()],
			seen,
			tag: Object.prototype.toString.call(view),
			values: [...view.values()],
		}).toEqual({
			cookies: ["a=1", "b=2"],
			entries: 4,
			keys: ["host", "set-cookie", "set-cookie", "x-one"],
			seen: ["host=h", "set-cookie=a=1", "set-cookie=b=2", "x-one=1"],
			tag: "[object Headers]",
			values: ["h", "a=1", "b=2", "1"],
		})
	})
})
