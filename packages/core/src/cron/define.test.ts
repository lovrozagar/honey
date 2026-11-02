import { describe, expect, it } from "vitest"
import { defineCron } from "./define.ts"

type Env = { readonly name: string }

describe("defineCron", () => {
	it("refuses a definition that could never run, naming the expression", () => {
		const define = (schedules: Parameters<typeof defineCron<Env>>[0]["schedules"]) => () =>
			defineCron<Env>({ schedules })
		expect(define({})).toThrow("schedule")
		expect(define({ "* * * * *": {} })).toThrow('"* * * * *"')
		expect(define({ "* * * * *": { job: "nope" as never } })).toThrow('"* * * * *"')
		expect(define({ "61 * * * *": { job: async () => {} } })).toThrow('"61 * * * *"')
	})
})
