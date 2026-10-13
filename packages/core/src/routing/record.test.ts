import { describe, expect, it } from "vitest"
import { copyRecord, type RouteRecord } from "./record.ts"

describe("copyRecord", () => {
	it("gives another graph its own record with the same route", () => {
		const record: RouteRecord = { id: "GET /a", mt: Object.freeze({ k: 1 }), rp: "/a" }
		const copy = copyRecord(record)
		expect(copy).toEqual(record)
		expect(copy).not.toBe(record)
		copy.mt = null
		expect(record.mt).toEqual({ k: 1 })
	})
})
