import { afterEach, describe, expect, it, vi } from "vitest"
import { emittedApp, emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

type Json = Record<string, unknown>
type Answer = (request: Request) => Response | Promise<Response>
type Send = (path: string, input?: Json) => Promise<unknown>
type App = { get: Send; post: Send }
type Op = (input?: Json) => Promise<unknown>

const ORIGIN = "https://api.example.com"
const OK = { 200: { content: { "application/json": { schema: {} } }, description: "ok" } }
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/* bytes 0..15 through the v4 version and variant masks */
const COUNTING_UUID = "00010203-0405-4607-8809-0a0b0c0d0e0f"

/** A `crypto` with `getRandomValues` (filling 0, 1, 2, ...) and no `randomUUID`. */
const countingCrypto = {
	getRandomValues: (out: Uint8Array) => {
		out.forEach((_, at) => (out[at] = at))
		return out
	},
}

/** The app-front client on `ORIGIN` over a recording fetch answering `answer`, and what it sent. */
async function app(config: Json = {}, answer?: Answer): Promise<{ api: App; calls: Request[] }> {
	const { createClient } = await emittedApp()
	const { calls, fetch } = recordingFetch(answer)
	return { api: (createClient as (config: Json) => App)({ baseURL: ORIGIN, fetch, ...config }), calls }
}

/** The SDK emitted for `GET /users` (`listUsers`) and an idempotent `POST /pay` (`pay`), over a recording fetch. */
async function sdkOf(config: Json = {}): Promise<{ calls: Request[]; sdk: { listUsers: Op; pay: Op } }> {
	const mod = await emittedSdk({
		info: { title: "T", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/pay": { post: { operationId: "pay", responses: OK, "x-idempotency-key": true } },
			"/users": { get: { operationId: "listUsers", responses: OK } },
		},
	})
	const { calls, fetch } = recordingFetch()
	const SDK = mod.TestSDK as new (config: Json) => { listUsers: Op; pay: Op }
	return { calls, sdk: new SDK({ baseURL: ORIGIN, fetch, ...config }) }
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("app front: requests and headers", () => {
	// v0: 0df7a8cb44
	// v0: adca120b1b
	it("sends a GET to the base URL plus the path, resolving the parsed JSON in throw mode", async () => {
		const body = { items: [{ id: "1", name: "Alice" }], total: 1 }
		const { api, calls } = await app({ throwOnError: true }, () => Response.json(body))
		const data = await api.get("/users", { search: { limit: "10" } })
		await api.get("/health")
		expect([data, calls.map((call) => [call.method, call.url])]).toEqual([
			body,
			[
				["GET", `${ORIGIN}/users?limit=10`],
				["GET", `${ORIGIN}/health`],
			],
		])
	})

	// v0: 10260f12c8
	// v0: 8c95cd8217
	it("sends the configured headers together with the per-call ones", async () => {
		const { api, calls } = await app({ headers: { authorization: "Bearer token123" } })
		await api.get("/protected", { headers: { "x-custom": "value" } })
		expect([calls[0]?.headers.get("authorization"), calls[0]?.headers.get("x-custom")]).toEqual([
			"Bearer token123",
			"value",
		])
	})

	// v0: 04973354cb
	it("skips undefined per-call headers, and a per-call header replaces the configured one", async () => {
		const { api, calls } = await app({ headers: { Authorization: "Bearer a" } })
		await api.get("/p", { headers: { authorization: "Bearer b", "x-maybe": undefined } })
		expect([calls[0]?.headers.get("authorization"), calls[0]?.headers.has("x-maybe")]).toEqual(["Bearer b", false])
	})

	// v0: 54e28dea74
	// v0: 6539084abd
	it("serializes cookies into the Cookie header, after a configured cookie header", async () => {
		const plain = await app()
		await plain.api.get("/health", { cookies: { locale: "en", sid: "abc123" } })
		const configured = await app({ headers: { cookie: "session=xyz" } })
		await configured.api.get("/health", { cookies: { extra: "val" } })
		expect([plain.calls[0]?.headers.get("cookie"), configured.calls[0]?.headers.get("cookie")]).toEqual([
			"locale=en; sid=abc123",
			"session=xyz; extra=val",
		])
	})
})

describe("app front: x-request-id", () => {
	// v0: 388d4f9772
	it("attaches a fresh v4 UUID to every request", async () => {
		const { api, calls } = await app()
		await api.get("/a")
		await api.get("/b")
		const [first, second] = calls.map((call) => call.headers.get("x-request-id"))
		expect([UUID_V4.test(first ?? ""), UUID_V4.test(second ?? ""), first === second]).toEqual([true, true, false])
	})

	// v0: 179fe237b7
	// v0: 073657bca1
	it("keeps a configured x-request-id whatever its case, and a per-call one over it", async () => {
		const { api, calls } = await app({ headers: { "X-Request-Id": "from-config" } })
		await api.get("/health")
		await api.get("/health", { headers: { "x-request-id": "from-call" } })
		expect(calls.map((call) => call.headers.get("x-request-id"))).toEqual(["from-config", "from-call"])
	})

	// v0: f3cd0bf50e
	it("newClientRequestId returns an RFC 4122 version-4 UUID", async () => {
		const { newClientRequestId } = await emittedApp()
		expect((newClientRequestId as () => string)()).toMatch(UUID_V4)
	})

	// v0: 8b3950a462
	it("newClientRequestId falls back to getRandomValues when randomUUID is missing, forcing version 4", async () => {
		const newClientRequestId = (await emittedApp()).newClientRequestId as () => string
		vi.stubGlobal("crypto", countingCrypto)
		expect(newClientRequestId()).toBe(COUNTING_UUID)
	})
})

describe("SDK front: headers, cookies and keys", () => {
	// v0: a2999bdd86
	it("merges configured and per-call headers, the per-call value winning", async () => {
		const { calls, sdk } = await sdkOf({ headers: { "x-tenant": "global", "x-version": "1" } })
		await sdk.listUsers({ headers: { "x-extra": "yes", "x-tenant": "override" } })
		const headers = calls[0]?.headers
		expect([headers?.get("x-tenant"), headers?.get("x-version"), headers?.get("x-extra")]).toEqual([
			"override",
			"1",
			"yes",
		])
	})

	// v0: 38b54a4ace
	it("percent-encodes cookies and joins them into the Cookie header", async () => {
		const { calls, sdk } = await sdkOf()
		await sdk.listUsers({ cookies: { session: "abc123", user: "al ice;" } })
		expect(calls[0]?.headers.get("cookie")).toBe("session=abc123; user=al%20ice%3B")
	})

	// v0: 79e6db30df
	it("sends an x-request-id from getRandomValues on a runtime without randomUUID", async () => {
		const { calls, sdk } = await sdkOf()
		vi.stubGlobal("crypto", countingCrypto)
		await sdk.listUsers()
		vi.unstubAllGlobals()
		expect(calls[0]?.headers.get("x-request-id")).toBe(COUNTING_UUID)
	})

	// v0: c188549198
	it("never writes the idempotency key into the caller's input, so a reused input gets a fresh key", async () => {
		const { calls, sdk } = await sdkOf()
		const input: Json = {}
		await sdk.pay(input)
		await sdk.pay(input)
		const [first, second] = calls.map((call) => call.headers.get("idempotency-key"))
		expect([input, UUID_V4.test(first ?? ""), first === second]).toEqual([{}, true, false])
	})
})
