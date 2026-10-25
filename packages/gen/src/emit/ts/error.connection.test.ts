/**
 * A network failure in the TS SDK is its typed connection error (bit 19 f2), as the siblings' APIConnectionError,
 * ApiConnectionException and Transport error: a request that got no answer (a refused or reset connection, DNS, TLS)
 * throws `APIConnectionError` on both fronts and in either mode, the platform's error its `cause`; its message names
 * the method and the URL's origin and path, never a query or a header value. An abort and a timeout keep their names,
 * and a realtime dial's connection failure stays transient: the chain backs off and redials.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { REFUSED_URL } from "../shared/__fixtures__/recording-server.ts"
import { emittedApp, emittedSdk } from "./__fixtures__/emitted.ts"

const DOC = {
	info: { title: "T", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/items/{id}": {
			get: {
				operationId: "items.get",
				parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
				responses: { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "" } },
			},
		},
		"/feed": {
			get: {
				operationId: "rt.feed",
				responses: { 200: { content: { "text/event-stream": { schema: { type: "object" } } }, description: "" } },
				"x-realtime": true,
			},
		},
	},
}

type Get = (input: object) => Promise<unknown>
type Feed = AsyncIterable<unknown> & { close(): void }
type Sdk = { dispose(): void; items: { get: Get }; rt: { feed(input: object): Feed } }

/** What a call threw: its class, whether it is the exported connection error, its cause's class and its message. */
function caught(err: unknown, Connection: unknown) {
	const e = err as Error & { cause?: unknown }
	return {
		cause: (e.cause as Error | undefined)?.constructor.name,
		message: e.message,
		name: e.name,
		typed: typeof Connection === "function" && e instanceof (Connection as new () => Error),
	}
}

const SECRET = { headers: { authorization: "Bearer s3cret" }, search: { token: "q-s3cret" } }
const REFUSED = {
	cause: expect.any(String),
	message: `GET ${REFUSED_URL}/items/i1: the connection failed`,
	name: "APIConnectionError",
	typed: true,
}

afterEach(() => vi.unstubAllGlobals())

describe("a network failure is the TS SDK's APIConnectionError (bit 19 f2)", () => {
	it("throws it on a refused connection in either mode, the platform's error its cause, no query or header in its message", async () => {
		const sdk = await emittedSdk(DOC)
		const TestSDK = sdk.TestSDK as new (config: object) => Sdk
		const thrown = []
		for (const throwOnError of [false, true]) {
			const client = new TestSDK({ baseURL: REFUSED_URL, headers: SECRET.headers, throwOnError })
			thrown.push(
				await client.items
					.get({ params: { id: "i1" }, search: SECRET.search })
					.then(String, (e) => caught(e, sdk.APIConnectionError)),
			)
			client.dispose()
		}
		expect(thrown).toEqual([REFUSED, REFUSED])
	})

	it("throws it on the app front, exported there too", async () => {
		const app = await emittedApp()
		const api = (app.createClient as (config: object) => { get: (path: string, opts?: object) => Promise<unknown> })({
			baseURL: REFUSED_URL,
			headers: SECRET.headers,
		})
		const thrown = await api
			.get("/items/i1", { search: SECRET.search })
			.then(String, (e) => caught(e, app.APIConnectionError))
		expect(thrown).toEqual(REFUSED)
	})

	it("keeps an abort and a timeout as they are", async () => {
		const TestSDK = (await emittedSdk(DOC)).TestSDK as new (config: object) => Sdk
		const never: typeof fetch = (_input, init) =>
			new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error)))
		const client = new TestSDK({ baseURL: "https://api.test", fetch: never })
		const names = await Promise.all([
			client.items.get({ params: { id: "i1" }, signal: AbortSignal.abort() }).then(String, (e: Error) => e.name),
			client.items.get({ params: { id: "i1" }, timeout: 20 }).then(String, (e: Error) => e.name),
		])
		client.dispose()
		expect(names).toEqual(["AbortError", "TimeoutError"])
	})

	it("leaves a realtime dial's connection failure transient: the chain backs off and redials", async () => {
		vi.stubGlobal("WebSocket", undefined)
		const TestSDK = (await emittedSdk(DOC)).TestSDK as new (config: object) => Sdk
		const client = new TestSDK({ baseURL: REFUSED_URL })
		const attempts: number[] = []
		const feed = client.rt.feed({
			maxReconnectAttempts: 2,
			onReconnecting: (n: number) => attempts.push(n),
			reconnectDelayMs: 1,
		})
		const ended = await (async () => {
			for await (const _ of feed) return "value"
			return "ended"
		})().catch((e: Error) => e.name)
		client.dispose()
		expect({ attempts, ended }).toEqual({ attempts: [1, 2], ended: "ended" })
	})
})
