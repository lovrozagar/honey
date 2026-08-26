import { describe, expect, it, vi } from "vitest"
import { createClient } from "../../../src/client/index.ts"
import { HTTPClient, newClientRequestId } from "../../../src/client/http.ts"

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function mockFetch(body: unknown = { ok: true }, status = 200): typeof fetch {
	return vi.fn().mockImplementation(() =>
		Promise.resolve(
			new Response(JSON.stringify(body), {
				headers: { "content-type": "application/json" },
				status,
			}),
		),
	)
}

function mockStreamFetch(chunks: string[]): typeof fetch {
	const encoder = new TextEncoder()
	const stream = new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
			controller.close()
		},
	})
	return vi.fn().mockResolvedValue(
		new Response(stream, {
			headers: { "content-type": "text/event-stream" },
			status: 200,
		}),
	)
}

function lastHeaders(fetchFn: typeof fetch): Headers {
	const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.at(-1) as [string, RequestInit]
	return init.headers as Headers
}

describe("newClientRequestId — cross-runtime UUID", () => {
	it("returns an RFC 4122 version-4 UUID", () => {
		expect(newClientRequestId()).toMatch(UUID_V4)
	})

	it("returns distinct values across calls", () => {
		const a = newClientRequestId()
		const b = newClientRequestId()
		expect(a).not.toBe(b)
	})

	it("falls back to getRandomValues when randomUUID is missing", () => {
		const original = globalThis.crypto
		const bytes = new Uint8Array(16)
		for (let i = 0; i < 16; i++) bytes[i] = i
		const fakeCrypto = {
			getRandomValues: (out: Uint8Array) => {
				out.set(bytes)
				return out
			},
		} as Crypto
		Object.defineProperty(globalThis, "crypto", {
			configurable: true,
			value: fakeCrypto,
		})
		try {
			const id = newClientRequestId()
			expect(id).toMatch(UUID_V4)
			/* version nibble forced to 4 */
			expect(id[14]).toBe("4")
		} finally {
			Object.defineProperty(globalThis, "crypto", {
				configurable: true,
				value: original,
			})
		}
	})
})

describe("HTTPClient — auto x-request-id", () => {
	it("attaches x-request-id when no caller set it", async () => {
		const fetchFn = mockFetch()
		const client = new HTTPClient({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
		})

		await client.request("GET", "/health", {})

		const id = lastHeaders(fetchFn).get("x-request-id")
		expect(id).toMatch(UUID_V4)
	})

	it("attaches a fresh id on every request", async () => {
		const fetchFn = mockFetch()
		const client = new HTTPClient({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
		})

		await client.request("GET", "/a", {})
		await client.request("GET", "/b", {})

		const id1 = ((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit).headers as Headers
		const id2 = ((fetchFn as ReturnType<typeof vi.fn>).mock.calls[1][1] as RequestInit).headers as Headers
		expect(id1.get("x-request-id")).toMatch(UUID_V4)
		expect(id2.get("x-request-id")).toMatch(UUID_V4)
		expect(id1.get("x-request-id")).not.toBe(id2.get("x-request-id"))
	})

	it("preserves config.headers x-request-id (case-insensitive)", async () => {
		const fetchFn = mockFetch()
		const client = new HTTPClient({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			headers: { "X-Request-Id": "from-config" },
		})

		await client.request("GET", "/health", {})

		expect(lastHeaders(fetchFn).get("x-request-id")).toBe("from-config")
	})

	it("preserves per-call headers x-request-id over auto and config", async () => {
		const fetchFn = mockFetch()
		const client = new HTTPClient({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			headers: { "x-request-id": "from-config" },
		})

		await client.request("GET", "/health", {
			headers: { "x-request-id": "from-call" },
		})

		expect(lastHeaders(fetchFn).get("x-request-id")).toBe("from-call")
	})

	it("onRequest hook wins over auto-generated id", async () => {
		const fetchFn = mockFetch()
		const seenInHook: string[] = []
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			onRequest: [
				(ctx) => {
					seenInHook.push(ctx.headers.get("x-request-id") ?? "")
					ctx.headers.set("x-request-id", "from-hook")
				},
			],
			throwOnError: true,
		})

		await api.get("/test")

		/* hook saw an auto id first, then overwrote */
		expect(seenInHook[0]).toMatch(UUID_V4)
		expect(lastHeaders(fetchFn).get("x-request-id")).toBe("from-hook")
	})

	it("onRequest hook wins over per-call header", async () => {
		const fetchFn = mockFetch()
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			onRequest: [
				(ctx) => {
					ctx.headers.set("x-request-id", "hook-wins")
				},
			],
			throwOnError: true,
		})

		await api.get("/test", { headers: { "x-request-id": "from-call" } })

		expect(lastHeaders(fetchFn).get("x-request-id")).toBe("hook-wins")
	})

	it("SSE stream requests also get x-request-id", async () => {
		const fetchFn = mockStreamFetch(["data: hi\n\n"])
		const client = new HTTPClient({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
		})

		const events: unknown[] = []
		for await (const ev of client.requestStream("GET", "/events", {})) {
			events.push(ev)
		}

		expect(events.length).toBeGreaterThan(0)
		expect(lastHeaders(fetchFn).get("x-request-id")).toMatch(UUID_V4)
	})
})
