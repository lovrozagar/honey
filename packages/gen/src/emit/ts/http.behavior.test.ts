import { describe, expect, it, vi } from "vitest"
import { emittedApp, emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

type Json = Record<string, unknown>
/** What a safe call resolves to. */
type Result = { data?: unknown; error?: unknown; ok: boolean; response: Response }
type Verb = "delete" | "get" | "patch" | "post" | "put"
type Api = Record<Verb, (path: string, input?: Json) => Promise<unknown>> & {
	safe: Record<Verb, (path: string, input?: Json) => Promise<Result>>
}
type Answer = (request: Request) => Response | Promise<Response>
/** The app client module's runtime exports these cases use. */
type AppModule = {
	createClient: (config: Json) => Api
	HTTPClient: new (config: Json) => { request: (method: string, path: string, opts: Json) => Promise<unknown> }
	isClientError: (value: unknown) => boolean
	UnauthorizedError: new () => Error
}
/** A generated SDK with one `a` operation (`GET /a`). */
type OneOpSdk = { a: () => Promise<unknown>; safe: { a: () => Promise<Result> }; state: Json }

/** The emitted app client module. */
async function app(): Promise<AppModule> {
	return (await emittedApp()) as unknown as AppModule
}

/** `createClient` from the emitted app client, over a recording fetch answering `answer`. */
async function appClient(config: Json, answer?: Answer): Promise<{ api: Api; calls: Request[] }> {
	const { calls, fetch } = recordingFetch(answer)
	return { api: (await app()).createClient({ baseURL: "https://api.test.com", fetch, ...config }), calls }
}

/** The emitted SDK class for one `a` operation (`GET /a`) answering JSON. */
async function oneOpSdk(): Promise<new (config: Json) => OneOpSdk> {
	const ok = { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }
	const document = {
		info: { title: "t", version: "1" },
		openapi: "3.1.0",
		paths: { "/a": { get: { operationId: "a", responses: ok } } },
	}
	return ((await emittedSdk(document)) as unknown as { TestSDK: new (config: Json) => OneOpSdk }).TestSDK
}

/** A fetch answer that never responds, rejecting with the signal's reason once it aborts. */
const hanging: Answer = (request) =>
	new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason)))

/** A JSON response whose body stalls after its first bytes until the request aborts, or 2 s pass. */
const stalledBody: Answer = (request) => {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('{"a":'))
			const timer = setTimeout(() => controller.close(), 2000)
			request.signal.addEventListener("abort", () => {
				clearTimeout(timer)
				controller.error(request.signal.reason)
			})
		},
	})
	return new Response(body, { headers: { "content-type": "application/json" } })
}

const json401 = () => Response.json({ message: "no" }, { status: 401 })

describe("results: what a call resolves to", () => {
	// v0: 6ecb113767
	it("resolves the parsed body directly", async () => {
		const { api } = await appClient({}, () => new Response("ok", { headers: { "content-type": "text/plain" } }))
		expect(await api.get("/api/health")).toBe("ok")
	})

	// v0: 5d71e8c6d5
	it("resolves one result object however often the call is awaited", async () => {
		const { api, calls } = await appClient({}, () => Response.json({ ok: true }))
		const call = api.get("/api/health")
		const [first, second] = [await call, await call]
		expect([first === second, first, calls.length]).toEqual([true, { ok: true }, 1])
	})

	// v0: 8102eea6a6
	it("keeps two clients on one server independent, each with its own headers", async () => {
		const { calls, fetch } = recordingFetch((request) =>
			request.url.endsWith("/organizations") && request.headers.get("authorization") !== "Bearer test"
				? Response.json({ message: "forbidden" }, { status: 403 })
				: Response.json({}),
		)
		const { createClient } = await app()
		const publicApi = createClient({ baseURL: "https://api.test.com", fetch })
		const authedApi = createClient({
			baseURL: "https://api.test.com",
			fetch,
			headers: { authorization: "Bearer test" },
		})
		const results = [
			await publicApi.safe.get("/api/health"),
			await authedApi.safe.get("/api/v1/organizations"),
			await publicApi.safe.get("/api/v1/organizations"),
		]
		expect([
			results.map((result) => result.response.status),
			calls.map((call) => call.headers.get("authorization")),
		]).toEqual([
			[200, 200, 403],
			[null, "Bearer test", null],
		])
	})
})

describe("timeouts and abort: a network-level failure rejects from both clients", () => {
	// v0: c2aaf13e25
	it("rejects with a TimeoutError, not a ClientError", async () => {
		const { isClientError } = await app()
		const { api } = await appClient({ timeout: 1 }, hanging)
		const error = (await api.get("/api/events-live").catch((e: unknown) => e)) as Error
		expect([isClientError(error), error.name]).toEqual([false, "TimeoutError"])
	})

	// v0: 39f681f314
	it("rejects on a timeout from the safe twin too", async () => {
		const { api } = await appClient({ timeout: 1 }, hanging)
		await expect(api.safe.get("/api/events-live")).rejects.toMatchObject({ name: "TimeoutError" })
	})

	// v0: 78ea52cb6f
	it("aborts an HTTPClient request through the fetch signal once the timeout passes", async () => {
		const { HTTPClient } = await app()
		const { calls, fetch } = recordingFetch(hanging)
		const client = new HTTPClient({ baseURL: "https://api.test.com", fetch, timeout: 50 })
		await expect(client.request("GET", "/slow", {})).rejects.toThrow()
		expect(calls[0]?.signal.aborted).toBe(true)
	})

	// v0: 52165058ee
	it("covers reading the body: a stalled body ends the safe twin's call with its TimeoutError, no answer (f2)", async () => {
		const { api } = await appClient({ timeout: 50 }, stalledBody)
		const started = Date.now()
		const error = (await api.safe.get("/slow").catch((e: unknown) => e)) as Error
		expect([error.name, Date.now() - started < 1000]).toEqual(["TimeoutError", true])
	})
})

describe("timeouts and abort: body reads and user aborts", () => {
	// v0: b2e97061fc
	it("covers reading the body in a generated SDK", async () => {
		const TestSDK = await oneOpSdk()
		const { fetch } = recordingFetch(stalledBody)
		const sdk = new TestSDK({ baseURL: "https://api.test.com", fetch, timeout: 50 })
		const started = Date.now()
		await expect(sdk.a()).rejects.toBeTruthy()
		expect(Date.now() - started).toBeLessThan(2000)
	})

	// v0: 8ce64c4bf9
	it("lets a user abort after the headers cancel the body read while a timeout is set", async () => {
		const { api } = await appClient({ timeout: 10_000 }, stalledBody)
		const controller = new AbortController()
		const call = api.get("/slow", { signal: controller.signal })
		setTimeout(() => controller.abort(new Error("user")), 30)
		const started = Date.now()
		await expect(call).rejects.toThrow("user")
		expect(Date.now() - started).toBeLessThan(1000)
	})

	// v0: 5c32d62538
	it("rejects an already aborted call with an AbortError, not a ClientError, sending nothing", async () => {
		const { isClientError } = await app()
		const { api, calls } = await appClient({})
		const error = (await api.get("/api/health", { signal: AbortSignal.abort() }).catch((e: unknown) => e)) as Error
		expect([isClientError(error), error.name, calls.length]).toEqual([false, "AbortError", 0])
	})

	// v0: 1b05f701da
	it("rejects an aborted call from the safe twin too", async () => {
		const { api } = await appClient({})
		await expect(api.safe.get("/api/health", { signal: AbortSignal.abort() })).rejects.toMatchObject({
			name: "AbortError",
		})
	})
})

describe("auth refresh: onAuthExpired turns a 401 into one retry with a fresh token", () => {
	// v0: db3b5c9df0
	it("refreshes once on a 401, retries with the new token and keeps it for later calls", async () => {
		const onAuthExpired = vi.fn(async () => "fresh")
		const { api, calls } = await appClient({ headers: { authorization: "Bearer stale" }, onAuthExpired }, (request) =>
			request.headers.get("authorization") === "Bearer fresh" ? Response.json({ ok: true }) : json401(),
		)
		const data = [await api.get("/a"), await api.get("/b")]
		expect([data, onAuthExpired.mock.calls, calls.map((call) => call.headers.get("authorization"))]).toEqual([
			[{ ok: true }, { ok: true }],
			[[{ rejectedToken: "stale" }]],
			["Bearer stale", "Bearer fresh", "Bearer fresh"],
		])
	})

	// v0: 33437db7ac
	it("shares one refresh between concurrent 401s", async () => {
		let resolveToken: ((token: string) => void) | undefined
		const onAuthExpired = vi.fn(() => new Promise<string>((resolve) => (resolveToken = resolve)))
		const { api } = await appClient({ headers: { authorization: "Bearer stale" }, onAuthExpired }, (request) =>
			request.headers.get("authorization") === "Bearer fresh" ? Response.json({}) : json401(),
		)
		const all = Promise.all([api.safe.get("/1"), api.safe.get("/2"), api.safe.get("/3")])
		await vi.waitFor(() => expect(onAuthExpired).toHaveBeenCalled())
		resolveToken?.("fresh")
		expect([(await all).map((result) => result.response.status), onAuthExpired.mock.calls.length]).toEqual([
			[200, 200, 200],
			1,
		])
	})

	// v0: 931fa820f2
	it("shares one refresh between concurrent 401s in a generated SDK, sending the new token first afterwards", async () => {
		const TestSDK = await oneOpSdk()
		let refreshes = 0
		const { calls, fetch } = recordingFetch((request) =>
			request.headers.get("authorization") === "Bearer fresh"
				? Response.json({ ok: true })
				: new Response(null, { status: 401 }),
		)
		const onAuthExpired = async () => {
			refreshes++
			await new Promise((resolve) => setTimeout(resolve, 10))
			return "fresh"
		}
		const sdk = new TestSDK({
			baseURL: "https://api.test.com",
			fetch,
			headers: { authorization: "Bearer stale" },
			onAuthExpired,
		})
		const statuses = (await Promise.all([sdk.safe.a(), sdk.safe.a(), sdk.safe.a()])).map(
			(result) => result.response.status,
		)
		const before = calls.length
		await sdk.a()
		const after = calls.slice(before).map((call) => call.headers.get("authorization"))
		expect([statuses, refreshes, after]).toEqual([[200, 200, 200], 1, ["Bearer fresh"]])
	})
})

describe("auth refresh: when it does not retry", () => {
	// v0: 56f8ab6406
	it("gives up on a null or empty token without an unauthenticated retry", async () => {
		const { UnauthorizedError } = await app()
		const { api, calls } = await appClient({ onAuthExpired: async () => "" }, json401)
		const error = await api.get("/a").catch((e: unknown) => e)
		expect([error instanceof UnauthorizedError, calls.length]).toEqual([true, 1])
	})

	// v0: aedfbd26ef
	it("retries a replayable body but never a stream body", async () => {
		const replayable = await appClient({ onAuthExpired: async () => "fresh" }, json401)
		const streamed = await appClient(
			{
				onAuthExpired: async () => "fresh",
				onRequest: [(ctx: { body?: BodyInit }) => void (ctx.body = new ReadableStream({ start: (c) => c.close() }))],
			},
			json401,
		)
		const statuses = [
			(await replayable.api.safe.post("/up", {})).response.status,
			(await streamed.api.safe.post("/up", {})).response.status,
		]
		expect([statuses, replayable.calls.length, streamed.calls.length]).toEqual([[401, 401], 2, 1])
	})
})

describe("generated SDK config", () => {
	// v0: 4ba33cc9c6
	it("never writes to the caller's config: instances built from one config keep their own state", async () => {
		const TestSDK = await oneOpSdk()
		const states: Json[] = []
		const { fetch } = recordingFetch()
		const config = {
			baseURL: "https://api.test.com",
			fetch,
			onRequest: [(ctx: { state: Json }) => void states.push(ctx.state)],
		}
		const [first, second] = [new TestSDK(config), new TestSDK(config)]
		await first.a()
		await second.a()
		expect([
			Object.keys(config),
			states[0] === first.state,
			states[1] === second.state,
			first.state === second.state,
		]).toEqual([["baseURL", "fetch", "onRequest"], true, true, false])
	})
})
