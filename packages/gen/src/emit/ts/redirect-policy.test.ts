import { describe, expect, it } from "vitest"
import { emittedApp, emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

type Json = Record<string, unknown>
type Result = { data: unknown; error: unknown; status: number }
type Api = { get(path: string, input?: Json): Promise<Result> }
type Sdk = { a(input?: Json): Promise<Result>; items: { list(input?: Json): Promise<Result> } }

const OK = { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }
const DOC = {
	info: { title: "T", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/a": { get: { operationId: "a", responses: OK } },
		"/items": { get: { operationId: "items.list", responses: OK } },
	},
}

/** The only headers a cross-origin hop may carry. */
const SAFE = ["accept", "accept-language", "user-agent"]

/** A redirect to `location` with `status`. */
const redirect = (location: string, status = 302) => new Response(null, { headers: { location }, status })

/** The app front's `createClient`. */
async function createClient(config: Json): Promise<Api> {
	return ((await emittedApp()).createClient as (config: Json) => Api)(config)
}

/** A client of the SDK emitted for `DOC`. */
async function sdk(config: Json): Promise<Sdk> {
	return new ((await emittedSdk(DOC)).TestSDK as new (config: Json) => Sdk)(config)
}

/** A fetch on which every `https://api.test` request redirects to `https://evil.test/landing`. */
function twoOrigins() {
	return recordingFetch((request) =>
		request.url.startsWith("https://api.test/") ? redirect("https://evil.test/landing") : Response.json({}),
	)
}

/** Config whose function-form headers, per-call headers and onRequest hook each set private and safe headers. */
const leaky = (fetch: typeof globalThis.fetch): Json => ({
	baseURL: "https://api.test",
	fetch,
	headers: () => ({
		"accept-language": "hr",
		authorization: "Bearer secret",
		"user-agent": "honey-test",
		"x-api-key": "secret",
	}),
	onRequest: [(ctx: { headers: Headers }) => void ctx.headers.set("x-hook", "h")],
	redirect: "follow",
})

/** The header names `request` carries outside the cross-origin allowlist, and its safe headers' values. */
function crossed(request: Request | undefined): [string[], (string | null)[]] {
	const headers = request?.headers ?? new Headers()
	return [
		[...headers.keys()].filter((name) => !SAFE.includes(name)),
		[headers.get("accept-language"), headers.get("user-agent")],
	]
}

describe("redirects: same-origin (default)", () => {
	// v0: 16e75f6590
	it("follows a same-origin redirect with fetch in manual mode and returns a cross-origin one unfetched", async () => {
		const { calls, fetch } = recordingFetch((request) => {
			if (request.url.endsWith("/old")) return redirect("/v1/new", 308)
			if (request.url.endsWith("/leave")) return redirect("https://evil.example/x", 307)
			return Response.json({ ok: 1 })
		})
		const api = await createClient({ baseURL: "https://api.example.com/v1", fetch, headers: { "x-api-key": "k" } })
		expect((await api.get("/old")).data).toEqual({ ok: 1 })
		expect([calls[0]?.redirect, calls[1]?.url]).toEqual(["manual", "https://api.example.com/v1/new"])
		expect((await api.get("/leave")).status).toBe(307)
		expect(calls.map((call) => new URL(call.url).origin)).toEqual(Array(3).fill("https://api.example.com"))
	})

	// v0: 6959ecd9e9
	it("an SDK call follows a same-origin chain and returns its cross-origin hop unfollowed, so the key never leaves", async () => {
		const { calls, fetch } = recordingFetch((request) => {
			if (request.url.endsWith("/a")) return redirect("/a2")
			if (request.url.endsWith("/a2")) return redirect("https://evil.example/x")
			return Response.json({})
		})
		const client = await sdk({ baseURL: "https://api.example.com", fetch, headers: { "x-api-key": "secret" } })
		const result = await client.a()
		expect(calls.map((call) => call.url)).toEqual(["https://api.example.com/a", "https://api.example.com/a2"])
		expect(result.status).toBe(302)
	})
})

describe("redirects: follow — a cross-origin hop carries only safe headers, never Authorization (H18.10)", () => {
	// v0: d588cc97c1
	it("strips Authorization and configured headers on a cross-origin hop", async () => {
		const { calls, fetch } = recordingFetch((request) =>
			request.url.startsWith("https://api.example.com") ? redirect("https://cdn.example/f") : Response.json({}),
		)
		const api = await createClient({
			baseURL: "https://api.example.com",
			fetch,
			headers: { authorization: "Bearer t", "x-api-key": "k" },
			redirect: "follow",
		})
		await api.get("/file")
		expect(calls[1]?.url).toBe("https://cdn.example/f")
		expect([calls[1]?.headers.has("authorization"), calls[1]?.headers.has("x-api-key")]).toEqual([false, false])
	})

	// v0: 765a8e1e33
	it("app front: the hop drops function-form config, per-call and onRequest headers and keeps the safe ones", async () => {
		const { calls, fetch } = twoOrigins()
		const api = await createClient(leaky(fetch))
		await api.get("/items", { headers: { "x-call": "c" } })
		const atEvil = calls.filter((call) => call.url.startsWith("https://evil.test/"))
		expect(atEvil).toHaveLength(1)
		expect(crossed(atEvil[0])).toEqual([[], ["hr", "honey-test"]])
	})

	// v0: add250aa51
	it("SDK front: the hop drops function-form config, per-call and onRequest headers and keeps the safe ones", async () => {
		const { calls, fetch } = twoOrigins()
		const client = await sdk(leaky(fetch))
		await client.items.list({ headers: { "x-call": "c" } })
		const atEvil = calls.filter((call) => call.url.startsWith("https://evil.test/"))
		expect(atEvil).toHaveLength(1)
		expect(crossed(atEvil[0])).toEqual([[], ["hr", "honey-test"]])
	})
})
