import { describe, expect, it } from "vitest"
import { cronFires, parseCron } from "./expression.ts"

const at = (iso: string) => new Date(`${iso}Z`)
const fires = (expression: string, iso: string) => cronFires(parseCron(expression), at(iso))

describe("parseCron: what it takes", () => {
	it.each([
		["* * * * *", "2026-11-02T03:07:00"],
		["*/15 * * * *", "2026-11-02T03:45:00"],
		["0,30 9-17 * * *", "2026-11-02T12:30:00"],
		["10-50/20 * * * *", "2026-11-02T03:30:00"],
		["0 0 * JAN *", "2026-01-05T00:00:00"],
		["0 0 1 jan-mar *", "2026-02-01T00:00:00"],
		["0 9 * * MON-FRI", "2026-11-02T09:00:00"],
		["0 9 * * sat,SUN", "2026-11-01T09:00:00"],
		["0 0 29 2 *", "2028-02-29T00:00:00"],
		["0 0 31 1,4 *", "2026-01-31T00:00:00"],
		["*/60 * * * *", "2026-11-02T03:00:00"],
	])("%s fires at %s", (expression, iso) => {
		expect(fires(expression, iso)).toBe(true)
	})

	it.each([
		["*/15 * * * *", "2026-11-02T03:46:00"],
		["0,30 9-17 * * *", "2026-11-02T18:30:00"],
		["10-50/20 * * * *", "2026-11-02T03:40:00"],
		["0 0 * JAN *", "2026-02-05T00:00:00"],
		["0 9 * * MON-FRI", "2026-11-01T09:00:00"],
		["*/60 * * * *", "2026-11-02T03:30:00"],
	])("%s stays quiet at %s", (expression, iso) => {
		expect(fires(expression, iso)).toBe(false)
	})

	it("reads the clock in UTC across a month, a leap day and a year", () => {
		expect([
			fires("0 0 1 3 *", "2028-03-01T00:00:00"),
			fires("0 0 29 2 *", "2027-03-01T00:00:00"),
			fires("0 0 1 1 *", "2027-01-01T00:00:00"),
			fires("59 23 31 12 *", "2026-12-31T23:59:00"),
			cronFires(parseCron("0 0 1 1 *"), new Date("2026-12-31T19:00:00-05:00")),
		]).toEqual([true, false, true, true, true])
	})
})

describe("parseCron: what it refuses", () => {
	it.each([
		["six fields", "0 * * * * *"],
		["four fields", "* * * *"],
		["a doubled space", "*  * * * *"],
		["a leading space", " * * * * *"],
		["an empty list item", "1,,2 * * * *"],
		["a minute past the end", "60 * * * *"],
		["an hour past the end", "* 24 * * *"],
		["day zero", "* * 0 * *"],
		["month thirteen", "* * * 13 *"],
		["a step of zero", "*/0 * * * *"],
		["a step with no number", "*/ * * * *"],
		["a step on one value", "5/10 * * * *"],
		["a reversed range", "50-10 * * * *"],
		["a range of three", "1-2-3 * * * *"],
		["two steps", "*/2/3 * * * *"],
		["a reversed weekday range", "* * * * FRI-MON"],
		["a numeric weekday", "* * * * 1"],
		["a numeric weekday range", "* * * * 1-5"],
		["a weekday step on a number", "* * * * */2"],
		["a last-day token", "* * L * *"],
		["a weekday token", "* * 15W * *"],
		["an nth weekday", "* * * * MON#2"],
		["a name that is no month", "* * * FOO *"],
		["a month name in the minute field", "JAN * * * *"],
		["a date that never occurs", "0 0 30 2 *"],
		["a date no listed month holds", "0 0 31 4,6 *"],
		["both day fields", "0 0 1 * MON"],
		["both day fields, one a full step", "0 0 */1 * MON"],
		["an empty expression", ""],
	])("%s", (_label, expression) => {
		expect(() => parseCron(expression)).toThrow(`"${expression}"`)
	})

	it("says why a numeric weekday is refused", () => {
		expect(() => parseCron("* * * * 1")).toThrow("MON")
	})
})
