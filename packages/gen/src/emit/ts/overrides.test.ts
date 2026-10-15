import { describe, expect, it } from "vitest"
import { emittedApp, emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

type Json = Record<string, unknown>
type Call = (input?: Json) => Promise<unknown>
type Api = { get(path: string, input?: Json): Promise<unknown> }
type Sdk = {
	events: { watch(input?: Json): AsyncIterable<{ data: string }> }
	items: { list: Call }
	reports: { get: Call }
	slow: { get: Call }
}

const OK = { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }
const get = (operationId: string, responses: Json = OK) => ({ get: { operationId, responses } })
const DOC = {
	info: { title: "T", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/events": get("events.watch", {
			200: { content: { "text/event-stream": { schema: { type: "string" } } }, description: "" },
		}),
		"/items": get("items.list"),
		"/reports": get("reports.get", { ...OK, 404: { description: "missing" } }),
		"/slow": get("slow.get"),
	},
}

/** The emitted SDK module for `DOC` and a client of it. */
async function sdk(config: Json): Promise<{ client: Sdk; mod: Record<string, unknown> }> {
	const mod = await emittedSdk(DOC)
	return { client: new (mod.TestSDK as new (config: Json) => Sdk)(config), mod }
}

/** The app front's `createClient`. */
async function createClient(config: Json): Promise<Api> {
	return ((await emittedApp()).createClient as (config: Json) => Api)(config)
}

/** A fetch that never answers, rejecting with the signal's reason once the request is aborted. */
function hanging() {
	return recordingFetch(
		(request) =>
			new Promise<Response>((_, reject) => {
				request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
			}),
	)
}

/** An event stream that sends `a`, waits `ms`, then sends `b` and ends. */
function slowEvents(ms: number): Response {
	const encoder = new TextEncoder()
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			controller.enqueue(encoder.encode("data: a\n\n"))
			await new Promise((resolve) => setTimeout(resolve, ms))
			controller.enqueue(encoder.encode("data: b\n\n"))
			controller.close()
		},
	})
	return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

describe("per-call timeout and headers (C2)", () => {
	// v0: 3aa1ed37c9
	it("a per-call timeout overrides the config's and rejects with TimeoutError", async () => {
		const api = await createClient({
			baseURL: "https://x",
			fetch: hanging().fetch,
			throwOnError: true,
			timeout: 60_000,
		})
		await expect(api.get("/slow", { timeout: 30 })).rejects.toMatchObject({ name: "TimeoutError" })
	})

	// v0: 964e43315a
	it("per-call headers override the config's async headers function", async () => {
		const { calls, fetch } = recordingFetch()
		const api = await createClient({
			baseURL: "https://api.example.com",
			fetch,
			headers: async () => ({ authorization: "Bearer wrong" }),
			throwOnError: true,
		})
		await api.get("/api/v1/organizations", { headers: { authorization: "Bearer test" } })
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer test")
	})

	// v0: e58f0e96f9
	it("per-call headers override same-named config headers, inherit the rest, and leave the config untouched", async () => {
		const { calls, fetch } = recordingFetch()
		const { client } = await sdk({
			baseURL: "https://api.example.com",
			fetch,
			headers: { "x-api-key": "k", "x-version": "1" },
		})
		await client.items.list({ headers: { "x-version": "2" } })
		await client.items.list()
		expect(calls.map((call) => [call.headers.get("x-version"), call.headers.get("x-api-key")])).toEqual([
			["2", "k"],
			["1", "k"],
		])
	})
})

describe("per-call base, signal and stream timeouts (C2)", () => {
	it("a per-call baseURL redirects that call only, on both fronts", async () => {
		const { calls, fetch } = recordingFetch()
		const config = { baseURL: "https://api.example.com", fetch }
		const { client } = await sdk(config)
		const api = await createClient(config)
		await client.items.list({ baseURL: "https://eu.example.com/v2" })
		await client.items.list()
		await api.get("/items", { baseURL: "https://eu.example.com/v2" })
		await api.get("/items")
		expect(calls.map((call) => call.url)).toEqual([
			"https://eu.example.com/v2/items",
			"https://api.example.com/items",
			"https://eu.example.com/v2/items",
			"https://api.example.com/items",
		])
	})

	it("a per-call signal cancels its call, and the config timeout still applies beside it", async () => {
		const ctrl = new AbortController()
		const stopped = new Error("stopped")
		const { client: patient } = await sdk({
			baseURL: "https://x",
			fetch: hanging().fetch,
			throwOnError: true,
			timeout: 60_000,
		})
		const pending = patient.slow.get({ signal: ctrl.signal })
		ctrl.abort(stopped)
		await expect(pending).rejects.toBe(stopped)
		const { client: hasty } = await sdk({
			baseURL: "https://x",
			fetch: hanging().fetch,
			throwOnError: true,
			timeout: 30,
		})
		await expect(hasty.slow.get({ signal: new AbortController().signal })).rejects.toMatchObject({
			name: "TimeoutError",
		})
	})

	it("an event stream is exempt from the timeout", async () => {
		const { fetch } = recordingFetch(() => slowEvents(80))
		const { client } = await sdk({ baseURL: "https://x", fetch, throwOnError: true, timeout: 20 })
		const data: string[] = []
		for await (const event of client.events.watch()) data.push(event.data)
		expect(data).toEqual(["a", "b"])
	})
})

/** A fetch answering `/reports` with `status` and an `x-total` header. */
const reports = (status: number) =>
	recordingFetch(() => Response.json({ total: 3 }, { headers: { "x-total": "3" }, status }))

describe("raw-response accessor (C2): `raw: true` resolves the unread Response", () => {
	it("reaches status, headers and the unread body in either mode", async () => {
		for (const throwOnError of [false, true]) {
			const { client } = await sdk({ baseURL: "https://x", fetch: reports(200).fetch, throwOnError })
			const response = (await client.reports.get({ raw: true })) as Response
			expect([
				response instanceof Response,
				response.status,
				response.headers.get("x-total"),
				response.bodyUsed,
			]).toEqual([true, 200, "3", false])
			expect(await response.json()).toEqual({ total: 3 })
		}
	})

	it("resolves an error status in safe mode and throws the typed error in throw mode", async () => {
		const { client: safe } = await sdk({ baseURL: "https://x", fetch: reports(404).fetch })
		const response = (await safe.reports.get({ raw: true })) as Response
		expect([response.status, await response.json()]).toEqual([404, { total: 3 }])
		const { client: thrower, mod } = await sdk({ baseURL: "https://x", fetch: reports(404).fetch, throwOnError: true })
		await expect(thrower.reports.get({ raw: true })).rejects.toBeInstanceOf(mod.NotFoundError as typeof Error)
	})
})
