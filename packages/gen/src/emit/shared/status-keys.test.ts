import { describe, expect, it } from "vitest"
import { STATUS_KEYS, statusKeyOf } from "./status-keys.ts"

describe("statusKeyOf: a status code by honey's name for it", () => {
	it("names every 2xx–5xx code in the vocabulary and nothing else", () => {
		expect([statusKeyOf(200), statusKeyOf(201), statusKeyOf(422), statusKeyOf(101), statusKeyOf(299)]).toEqual([
			"ok",
			"created",
			"unprocessable_entity",
			undefined,
			undefined,
		])
		expect(Object.keys(STATUS_KEYS).every((code) => Number(code) >= 200 && Number(code) < 600)).toBe(true)
	})
})
