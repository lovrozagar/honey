import { describe, expect, it } from "vitest"
import { HoneyContext } from "../../../src/context.ts"

describe("URL parse optimization", () => {
	it("ctx.search uses pre-parsed URL when provided via urlFn", () => {
		const url = new URL("http://localhost/test?a=1&b=2")
		const ctx = new HoneyContext({
			env: {},
			params: {},
			req: new Request("http://localhost/test?a=1&b=2"),
			urlFn: () => url,
		})

		expect(ctx.search).toEqual({ a: "1", b: "2" })
	})

	it("ctx.search falls back to parsing req.url when no urlFn provided", () => {
		const ctx = new HoneyContext({
			env: {},
			params: {},
			req: new Request("http://localhost/test?x=10"),
		})

		expect(ctx.search).toEqual({ x: "10" })
	})

	it("pre-parsed URL via urlFn is used over req.url", () => {
		/* give different query strings to URL and Request to verify which one wins */
		const url = new URL("http://localhost/test?source=url")
		const ctx = new HoneyContext({
			env: {},
			params: {},
			req: new Request("http://localhost/test?source=request"),
			urlFn: () => url,
		})

		expect(ctx.search.source).toBe("url")
	})
})
