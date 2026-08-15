import { describe, expect, it } from "vitest"
import { generateSDK } from "../../../src/codegen.ts"

function makeSpec(paths: Record<string, Record<string, Record<string, unknown>>>) {
	return {
		info: { title: "Test", version: "1.0" },
		openapi: "3.1.0" as const,
		paths,
	}
}

/* ===================================================
 * Realtime route detection in serviceMap
 * =================================================== */

describe("Realtime: serviceMap detection", () => {
	it("x-realtime operation -> realtime: true in serviceMap", () => {
		const spec = makeSpec({
			"/rt/feed": {
				get: { operationId: "rt.feed", responses: {}, "x-realtime": true },
			},
		})

		const { serviceMap } = generateSDK(spec)
		expect(serviceMap.rt.feed.realtime).toBe(true)
		expect(serviceMap.rt.feed.method).toBe("GET")
	})

	it("non-realtime operations have no realtime flag", () => {
		const spec = makeSpec({
			"/items": {
				get: { operationId: "items.list", responses: { "200": {} } },
			},
		})

		const { serviceMap } = generateSDK(spec)
		expect(serviceMap.items.list.realtime).toBeUndefined()
	})

	it("mixed HTTP + WS + realtime coexist in serviceMap", () => {
		const spec = makeSpec({
			"/items": {
				get: { operationId: "items.list", responses: { "200": {} } },
			},
			"/rt/live": {
				get: { operationId: "rt.live", responses: {}, "x-realtime": true },
			},
			"/ws/echo": {
				get: { operationId: "ws.echo", responses: {}, "x-websocket": true },
			},
		})

		const { serviceMap } = generateSDK(spec)
		expect(serviceMap.items.list.realtime).toBeUndefined()
		expect(serviceMap.items.list.ws).toBeUndefined()
		expect(serviceMap.ws.echo.ws).toBe(true)
		expect(serviceMap.ws.echo.realtime).toBeUndefined()
		expect(serviceMap.rt.live.realtime).toBe(true)
		expect(serviceMap.rt.live.ws).toBeUndefined()
	})
})

/* ===================================================
 * Runtime file generation
 * =================================================== */

describe("Realtime: runtime file generation", () => {
	it("generates runtime file when spec has realtime routes", () => {
		const spec = makeSpec({
			"/rt/feed": {
				get: { operationId: "rt.feed", responses: {}, "x-realtime": true },
			},
		})

		const { files } = generateSDK(spec)
		expect(files.runtime).toBeTruthy()
		expect(typeof files.runtime).toBe("string")
		expect((files.runtime as string).length).toBeGreaterThan(0)
	})

	it("does not generate runtime file for REST-only spec", () => {
		const spec = makeSpec({
			"/items": {
				get: { operationId: "items.list", responses: { "200": {} } },
			},
		})

		const { files } = generateSDK(spec)
		expect(files.runtime).toBeNull()
	})

	it("does not generate runtime file for WS-only spec", () => {
		const spec = makeSpec({
			"/ws/echo": {
				get: { operationId: "ws.echo", responses: {}, "x-websocket": true },
			},
		})

		const { files } = generateSDK(spec)
		expect(files.runtime).toBeNull()
	})

	it("runtime content includes error classes", () => {
		const spec = makeSpec({
			"/rt/feed": {
				get: { operationId: "rt.feed", responses: {}, "x-realtime": true },
			},
		})

		const { files } = generateSDK(spec)
		const runtime = files.runtime as string
		expect(runtime).toContain("RealtimeError")
		expect(runtime).toContain("RealtimeConnectError")
		expect(runtime).toContain("RealtimeAuthError")
		expect(runtime).toContain("RealtimeKickedError")
		expect(runtime).toContain("RealtimeAbortError")
	})

	it("runtime content includes ResumableConnection", () => {
		const spec = makeSpec({
			"/rt/feed": {
				get: { operationId: "rt.feed", responses: {}, "x-realtime": true },
			},
		})

		const { files } = generateSDK(spec)
		const runtime = files.runtime as string
		expect(runtime).toContain("createResumableConnection")
	})

	it("runtime content includes KeepaliveLoop", () => {
		const spec = makeSpec({
			"/rt/feed": {
				get: { operationId: "rt.feed", responses: {}, "x-realtime": true },
			},
		})

		const { files } = generateSDK(spec)
		const runtime = files.runtime as string
		expect(runtime).toContain("createKeepaliveLoop")
	})

	it("runtime content includes FallbackChain", () => {
		const spec = makeSpec({
			"/rt/feed": {
				get: { operationId: "rt.feed", responses: {}, "x-realtime": true },
			},
		})

		const { files } = generateSDK(spec)
		const runtime = files.runtime as string
		expect(runtime).toContain("createFallbackChain")
	})
})
