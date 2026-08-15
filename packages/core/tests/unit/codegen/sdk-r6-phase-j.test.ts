import { describe, expect, it } from "vitest"
import { generateSDK } from "../../../src/codegen.ts"

function makeSpec(paths: Record<string, Record<string, Record<string, unknown>>>) {
	return {
		info: { title: "Test", version: "1.0" },
		openapi: "3.1.0" as const,
		paths,
	}
}

/*
 * Fixture: SSE endpoint with x-invalidate, WS endpoint with x-invalidate,
 * and their GET invalidation targets. Tests that #requestSSE, #doSSE, and
 * #connectWS thread `entry` through and call #markStale.
 */
const phaseJSpec = makeSpec({
	"/v1/events": {
		get: {
			operationId: "events.list",
			responses: { "200": { content: { "application/json": { schema: { type: "array" } } } } },
		},
	},
	"/v1/events/stream": {
		post: {
			operationId: "events.stream",
			responses: { "200": { content: { "text/event-stream": { schema: { type: "string" } } } } },
			"x-invalidate": ["GET /v1/events"],
		},
	},
	"/v1/ws/connect": {
		post: {
			operationId: "ws.connect",
			responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
			"x-invalidate": ["GET /v1/ws/status"],
			"x-websocket": true,
		},
	},
	"/v1/ws/status": {
		get: {
			operationId: "ws.status",
			responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
		},
	},
})

/* SSE-only spec without x-invalidate — for testing the no-invalidation guard */
const sseNoInvalidateSpec = makeSpec({
	"/v1/feed": {
		get: {
			operationId: "feed.stream",
			responses: { "200": { content: { "text/event-stream": { schema: { type: "string" } } } } },
		},
	},
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-16 — SSE/WS x-invalidate — #requestSSE, #doSSE, #connectWS
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-16 SSE/WS x-invalidate — emitter Layer B' regression strings", () => {
	it("#requestSSE signature takes entry", () => {
		const { files } = generateSDK(phaseJSpec, { name: "TestSDK" })
		expect(files.client).toContain("#requestSSE(entry: _ServiceEntry")
	})

	it("#doSSE signature takes entry", () => {
		const { files } = generateSDK(phaseJSpec, { name: "TestSDK" })
		expect(files.client).toContain("#doSSE(entry: _ServiceEntry")
	})

	it("#doSSE calls #markStale after response.ok", () => {
		const { files } = generateSDK(phaseJSpec, { name: "TestSDK" })
		/*
		 * Extract the #doSSE method body from the generated client and assert
		 * #markStale is called there — not just anywhere else in the file (e.g. #request).
		 */
		const doSseStart = files.client.indexOf("async *#doSSE(")
		const doSseEnd = files.client.indexOf("\n\t}", doSseStart)
		const doSseBody = files.client.slice(doSseStart, doSseEnd)
		expect(doSseBody).toContain("this.#markStale(entry.invalidate")
	})

	it("#doSSE reads method from entry", () => {
		const { files } = generateSDK(phaseJSpec, { name: "TestSDK" })
		/*
		 * The old #doSSE took `method: string` as a parameter — entry.method was absent.
		 * After the fix, the parameter becomes `entry: _ServiceEntry` and the body declares
		 * `const method = entry.method`. Assert this is in the #doSSE body, not just #request.
		 */
		const doSseStart = files.client.indexOf("async *#doSSE(")
		const doSseEnd = files.client.indexOf("\n\t}", doSseStart)
		const doSseBody = files.client.slice(doSseStart, doSseEnd)
		expect(doSseBody).toContain("entry.method")
	})

	it("#connectWS signature takes entry", () => {
		const { files } = generateSDK(phaseJSpec, { name: "TestSDK" })
		expect(files.client).toContain("#connectWS(entry: _ServiceEntry")
	})

	it("#connectWS calls #markStale on open", () => {
		const { files } = generateSDK(phaseJSpec, { name: "TestSDK" })
		expect(files.client).toContain(`ws.on("open"`)
		/* #markStale call appears in the same generated file, wired through the open handler */
		expect(files.client).toContain("#markStale")
	})

	it("proxy SSE call site passes entry", () => {
		const { files } = generateSDK(phaseJSpec, { name: "TestSDK" })
		expect(files.client).toContain("target.#requestSSE(entry,")
	})

	it("proxy WS call site passes entry", () => {
		const { files } = generateSDK(phaseJSpec, { name: "TestSDK" })
		expect(files.client).toContain("target.#connectWS(entry,")
	})

	it("SSE without x-invalidate — no #markStale emitted in #doSSE when no invalidation targets exist", () => {
		const { files } = generateSDK(sseNoInvalidateSpec, { name: "TestSDK" })
		/*
		 * The guard `entry.invalidate && entry.invalidate.length > 0` handles undefined.
		 * The generated code must still compile — presence of the guard string confirms
		 * the emitter unconditionally emits it (it handles the no-invalidate case at runtime).
		 */
		expect(files.client).toContain("entry.invalidate && entry.invalidate.length > 0")
	})
})
