import { describe, expect, it } from "vitest"
import * as z from "zod"
import { parseCookieHeader } from "../context/cookie.ts"
import type { HoneyError } from "../errors/error.ts"
import { cookiesInput } from "./cookies.ts"

/** The error `run` throws. */
function thrown(run: () => unknown): HoneyError {
	try {
		run()
	} catch (error) {
		return error as HoneyError
	}
	throw new Error("did not throw")
}

const session = z.object({ session: z.string().min(3), theme: z.enum(["dark", "light"]) })

describe("cookiesInput: the Cookie header, validated", () => {
	// v0: b805d0a175
	// v0: cfbe24cde5
	// v0: 95608bc273
	it("hands the schema every cookie, the first of a repeated name", () => {
		expect(cookiesInput(session, parseCookieHeader("session=abc; theme=dark; theme=light"))).toEqual({
			session: "abc",
			theme: "dark",
		})
	})

	// v0: 7e14c5dd5b
	// v0: 28e3dd9d18
	it("an invalid or missing cookie is a 400 naming cookies.<name>", () => {
		const invalid = thrown(() => cookiesInput(session, parseCookieHeader("session=ab; theme=dark")))
		const missing = thrown(() => cookiesInput(session, parseCookieHeader("theme=dark")))
		expect([invalid.status, Object.keys(invalid.fields), missing.status, missing.fields.session?.[0]?.path]).toEqual([
			400,
			["session"],
			400,
			"cookies.session",
		])
	})

	it("without a schema (a readableStream entry) the cookies pass as they are", () => {
		const cookies = parseCookieHeader("a=1")
		expect(cookiesInput(null, cookies)).toBe(cookies)
	})
})
