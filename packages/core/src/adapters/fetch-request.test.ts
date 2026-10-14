import { describe, expect, it } from "vitest"
import { TO_FETCH_REQUEST, toFetchRequest } from "./fetch-request.ts"

describe("toFetchRequest: the Fetch Request behind ctx.req", () => {
	it("is the request itself on Bun and Workers, where ctx.req already is one", () => {
		const req = new Request("http://h/a")
		expect(toFetchRequest(req)).toBe(req)
	})

	it("asks a request view (the Node adapter's) for its Request, called on the view", () => {
		const real = new Request("http://h/a", { method: "POST" })
		const view = {
			[TO_FETCH_REQUEST](this: unknown) {
				return this === view ? real : new Request("http://wrong/")
			},
		}
		expect(toFetchRequest(view as unknown as Request)).toBe(real)
	})

	it("ignores a non-function under the key", () => {
		const view = { [TO_FETCH_REQUEST]: "nope" } as unknown as Request
		expect(toFetchRequest(view)).toBe(view)
	})
})
