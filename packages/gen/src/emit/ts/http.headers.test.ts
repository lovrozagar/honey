import { describe, expect, it, vi } from "vitest"
import { emittedApp, emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

type Json = Record<string, unknown>
/** What a safe call resolves to: its Ok arm, as these cases read it. */
type Result = { data: unknown; ok: boolean; response: Response }
type Call = (path: string, input?: Json) => Promise<unknown>
type Api = Record<"delete" | "get" | "patch" | "post" | "put", Call> & {
	safe: Record<"get", (path: string, input?: Json) => Promise<Result>>
}
/** The slice of the onRequest context these cases touch. */
type RequestCtx = { headers: Headers }

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** `createClient` from the emitted app client, over a recording fetch answering `{ ok: true }`. */
async function appClient(config: Json): Promise<{ api: Api; calls: Request[] }> {
	const { createClient } = (await emittedApp()) as unknown as { createClient: (config: Json) => Api }
	const { calls, fetch } = recordingFetch(() => Response.json({ ok: true }))
	return { api: createClient({ baseURL: "https://api.test.com", fetch, ...config }), calls }
}

/** The emitted SDK with one `users.list` operation, over a recording fetch. */
async function usersSdk(
	config: Json,
): Promise<{ calls: Request[]; sdk: { users: { list: (input?: Json) => Promise<unknown> } } }> {
	const document = {
		info: { title: "t", version: "1" },
		openapi: "3.1.0",
		paths: { "/users": { get: { operationId: "users.list", responses: { 200: { description: "ok" } } } } },
	}
	const { TestSDK } = (await emittedSdk(document)) as unknown as {
		TestSDK: new (config: Json) => { users: { list: (input?: Json) => Promise<unknown> } }
	}
	const { calls, fetch } = recordingFetch(() => Response.json([{ id: "u1" }]))
	return { calls, sdk: new TestSDK({ baseURL: "https://api.test.com", fetch, ...config }) }
}

/** Header `name` of each recorded request. */
function sent(calls: Request[], name: string): Array<string | null> {
	return calls.map((call) => call.headers.get(name))
}

describe("config headers: a record, or a function of the request resolved per call", () => {
	// v0: b98c67a478
	it("sends a static headers record", async () => {
		const { api, calls } = await appClient({ headers: { "x-static": "value" } })
		await api.get("/test")
		expect(sent(calls, "x-static")).toEqual(["value"])
	})

	// v0: ade0f3867f
	it("sends what a sync headers function returns", async () => {
		const { api, calls } = await appClient({
			headers: () => ({ authorization: "Bearer sync-token" }),
		})
		await api.get("/test")
		expect(sent(calls, "authorization")).toEqual(["Bearer sync-token"])
	})

	// v0: 138f2c9a6f
	it("awaits an async headers function", async () => {
		const { api, calls } = await appClient({
			headers: async () => ({ authorization: "Bearer async-token" }),
		})
		await api.get("/test")
		expect(sent(calls, "authorization")).toEqual(["Bearer async-token"])
	})

	// v0: 8281b99eda
	it("resolves async headers for the safe twin too", async () => {
		const { api, calls } = await appClient({ headers: async () => ({ "x-async": "tuple" }) })
		const result = await api.safe.get("/test")
		expect([result.ok, result.data, sent(calls, "x-async")]).toEqual([true, { ok: true }, ["tuple"]])
	})

	// v0: c0834178c7
	it("passes the function the method and the path template", async () => {
		const headers = vi.fn(() => ({}))
		const { api } = await appClient({ headers })
		await api.post("/users/:id", { params: { id: "42" } })
		expect(headers.mock.calls).toEqual([[{ method: "POST", path: "/users/:id" }]])
	})
})

describe("config headers: resolved per call, and what overrides them", () => {
	// v0: fac3512cbc
	// v0: fdc5eda3b8
	it("calls the function on every request, never caching its answer", async () => {
		let count = 0
		const { api, calls } = await appClient({ headers: () => ({ "x-count": String(++count) }) })
		await api.get("/a")
		await api.get("/b")
		expect(sent(calls, "x-count")).toEqual(["1", "2"])
	})

	// v0: b3302b1aab
	// v0: eb5969f17f
	it("lets the function choose headers by path, such as no auth on public routes", async () => {
		const { api, calls } = await appClient({
			headers: ({ path }: { path: string }) => (path.startsWith("/public") ? {} : { authorization: "Bearer secret" }),
		})
		await api.get("/public/health")
		await api.get("/users")
		expect(sent(calls, "authorization")).toEqual([null, "Bearer secret"])
	})

	// v0: c75836acc9
	it("lets per-call headers override the function's headers, keeping the rest", async () => {
		const { api, calls } = await appClient({
			headers: () => ({ authorization: "Bearer dynamic", "x-from": "dynamic" }),
		})
		await api.get("/test", { headers: { authorization: "Bearer override" } })
		expect([sent(calls, "authorization"), sent(calls, "x-from")]).toEqual([["Bearer override"], ["dynamic"]])
	})

	// v0: 674bea8edb
	// v0: e35f665414
	it("lets onRequest override a per-call header", async () => {
		const { api, calls } = await appClient({
			onRequest: [(ctx: RequestCtx) => void ctx.headers.set("x-request-id", "hook-wins")],
		})
		await api.get("/test", { headers: { "x-request-id": "from-call" } })
		expect(sent(calls, "x-request-id")).toEqual(["hook-wins"])
	})
})

describe("x-request-id: an auto correlation id that config, calls and hooks may replace", () => {
	// v0: 3f583feb77
	it("sends no x-request-id with requestId: false, so a browser needs no CORS preflight", async () => {
		const { api, calls } = await appClient({ requestId: false })
		await api.get("/p")
		expect(calls[0]?.headers.has("x-request-id")).toBe(false)
	})

	// v0: b2170fadd9
	it("shows onRequest the auto id, which the hook may then overwrite", async () => {
		const seen: Array<string | null> = []
		const onRequest = [
			(ctx: RequestCtx) => {
				seen.push(ctx.headers.get("x-request-id"))
				ctx.headers.set("x-request-id", "from-hook")
			},
		]
		const { api, calls } = await appClient({ onRequest })
		await api.get("/test")
		expect([UUID_V4.test(seen[0] ?? ""), sent(calls, "x-request-id")]).toEqual([true, ["from-hook"]])
	})

	// v0: 48a20ec21b
	it("attaches a UUID v4 x-request-id to a generated SDK call", async () => {
		const { calls, sdk } = await usersSdk({})
		await sdk.users.list()
		expect(sent(calls, "x-request-id")[0]).toMatch(UUID_V4)
	})

	// v0: a70a717fe1
	it("keeps a per-call x-request-id on a generated SDK call", async () => {
		const { calls, sdk } = await usersSdk({})
		await sdk.users.list({ headers: { "x-request-id": "call-id" } })
		expect(sent(calls, "x-request-id")).toEqual(["call-id"])
	})

	// v0: e5f3de3b8d
	it("lets a generated SDK's onRequest see the auto id and replace it", async () => {
		const seen: Array<string | null> = []
		const onRequest = [
			(ctx: RequestCtx) => {
				seen.push(ctx.headers.get("x-request-id"))
				ctx.headers.set("x-request-id", "hook-id")
			},
		]
		const { calls, sdk } = await usersSdk({ onRequest })
		await sdk.users.list()
		expect([UUID_V4.test(seen[0] ?? ""), sent(calls, "x-request-id")]).toEqual([true, ["hook-id"]])
	})
})
