import { describe, expect, it } from "vitest"
import { REPLACE_BODY, TO_FETCH_REQUEST, toFetchRequest, withBody } from "./fetch-request.ts"

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

/** A body stream carrying `text`. */
function stream(text: string): ReadableStream<Uint8Array> {
	return new Response(text).body as ReadableStream<Uint8Array>
}

describe("withBody: the request with another body in place of its own", () => {
	it("a Fetch Request becomes one new Request: same method, URL, headers and signal, the new body", async () => {
		const controller = new AbortController()
		const req = new Request("http://h/a?q=1", {
			body: "old",
			headers: { authorization: "Bearer t", "content-type": "text/plain" },
			method: "PUT",
			signal: controller.signal,
		})
		const next = withBody(req, stream("new"))
		controller.abort()
		expect([
			next === req,
			next.method,
			next.url,
			next.headers.get("authorization"),
			next.headers.get("content-type"),
			next.signal.aborted,
			await next.text(),
		]).toEqual([false, "PUT", "http://h/a?q=1", "Bearer t", "text/plain", true, "new"])
	})

	it("a request view swaps the body in place and stays the same object: no Request is built from it", () => {
		const swapped: unknown[] = []
		const body = stream("new")
		const view = {
			[REPLACE_BODY](this: unknown, next: ReadableStream<Uint8Array>) {
				swapped.push(this === view, next)
			},
		} as unknown as Request
		expect([withBody(view, body) === view, swapped]).toEqual([true, [true, body]])
	})
})
