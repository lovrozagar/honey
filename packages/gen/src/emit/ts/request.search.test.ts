import { describe, expect, it } from "vitest"
import { emittedApp, emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

type Json = Record<string, unknown>
type Answer = (request: Request) => Response | Promise<Response>
type Result = { data: unknown; error: unknown }
type App = {
	$path: (path: string, input?: Json) => string
	$url: (path: string, input?: Json) => string
	get: (path: string, input?: Json) => Promise<Result>
}
type Op = (input?: Json) => Promise<unknown>

const ORIGIN = "https://api.example.com"
const OK = { 200: { content: { "application/json": { schema: {} } }, description: "ok" } }

/** Answer with the request's query as a JSON object. */
const echoQuery: Answer = (request) => Response.json(Object.fromEntries(new URL(request.url).searchParams))

/** A bracket-notation serializer (`ids[]=1&ids[]=2`) that skips null and undefined. */
function brackets(query: Json): URLSearchParams {
	const params = new URLSearchParams()
	for (const [key, value] of Object.entries(query)) {
		if (Array.isArray(value)) for (const item of value) params.append(`${key}[]`, String(item))
		else if (value !== undefined && value !== null) params.set(key, String(value))
	}
	return params
}

/** The app-front client on `ORIGIN` over a recording fetch answering `answer`, and what it sent. */
async function app(config: Json = {}, answer?: Answer): Promise<{ api: App; calls: Request[] }> {
	const { createClient } = await emittedApp()
	const { calls, fetch } = recordingFetch(answer)
	return { api: (createClient as (config: Json) => App)({ baseURL: ORIGIN, fetch, ...config }), calls }
}

/** The SDK emitted for `GET /items` (`listItems`), over a recording fetch, and the URLs it sent. */
async function sdkOf(): Promise<{ listItems: Op; urls: () => string[] }> {
	const mod = await emittedSdk({
		info: { title: "T", version: "1" },
		openapi: "3.1.0",
		paths: { "/items": { get: { operationId: "listItems", responses: OK } } },
	})
	const { calls, fetch } = recordingFetch()
	const sdk = new (mod.TestSDK as new (config: Json) => { listItems: Op })({ baseURL: ORIGIN, fetch })
	return { listItems: sdk.listItems.bind(sdk), urls: () => calls.map((call) => call.url) }
}

describe("app front: query serialization", () => {
	// v0: 18efdee41a
	// v0: 1f46e43510
	// v0: ff226e7384
	it("sends the query, repeating an array's key and writing numbers and booleans as text", async () => {
		const { api, calls } = await app()
		const results = [
			await api.get("/items", { search: { limit: "10", q: "test" } }),
			await api.get("/echo", { search: { ids: [1, 2, 3] } }),
			await api.get("/echo", { search: { active: true, count: 42, tag: "test" } }),
		]
		expect([results.map((result) => result.error), calls.map((call) => call.url)]).toEqual([
			[null, null, null],
			[
				`${ORIGIN}/items?limit=10&q=test`,
				`${ORIGIN}/echo?ids=1&ids=2&ids=3`,
				`${ORIGIN}/echo?active=true&count=42&tag=test`,
			],
		])
	})

	// v0: 8683084785
	// v0: fab5f42cfb
	it("skips null and undefined values, and an empty search adds no query string", async () => {
		const { api, calls } = await app({}, echoQuery)
		const skipped = await api.get("/api", { search: { gone: null, id: "present", missing: undefined } })
		const empty = await api.get("/api/echo", { search: {} })
		expect([skipped.data, empty.data, calls.map((call) => call.url)]).toEqual([
			{ id: "present" },
			{},
			[`${ORIGIN}/api?id=present`, `${ORIGIN}/api/echo`],
		])
	})

	// v0: f12235f4d1
	it("keeps the query in insertion order by default", async () => {
		const { api, calls } = await app()
		await api.get("/test", { search: { z: "last", a: "first" } })
		expect(calls[0]?.url).toBe(`${ORIGIN}/test?z=last&a=first`)
	})
})

describe("app front: sorting and custom serializers", () => {
	// v0: 958ff3260e
	// v0: 006cc16b54
	// v0: fde693d92b
	// v0: 5c8b0c8b20
	// v0: f556883a80
	it("sorts the query by key on requests, $url and $path when sortSearchParams is set", async () => {
		const { api, calls } = await app({ sortSearchParams: true }, echoQuery)
		const search = { z: "last", m: "middle", a: "first" }
		const sent = await api.get("/test", { search })
		expect([
			calls[0]?.url,
			sent,
			api.$url("/api/echo", { search: { zebra: "z", alpha: "a", middle: "m" } }),
			api.$path("/test", { search: { z: "3", a: "1" } }),
		]).toEqual([
			`${ORIGIN}/test?a=first&m=middle&z=last`,
			expect.objectContaining({ data: { a: "first", m: "middle", z: "last" }, error: null }),
			`${ORIGIN}/api/echo?alpha=a&middle=m&zebra=z`,
			"/test?a=1&z=3",
		])
	})

	// v0: 8322d9bd6c
	// v0: d4f6e69dc9
	// v0: 1f01336c24
	it("shapes the query of requests and $url with a custom buildSearchParams", async () => {
		const { api, calls } = await app({ buildSearchParams: brackets })
		const sent = await api.get("/test", { search: { ids: [1, 2, 3], name: "x" } })
		expect([sent.error, calls[0]?.url, api.$url("/api/echo", { search: { ids: [1, 2], x: "y" } })]).toEqual([
			null,
			`${ORIGIN}/test?ids%5B%5D=1&ids%5B%5D=2&ids%5B%5D=3&name=x`,
			`${ORIGIN}/api/echo?ids%5B%5D=1&ids%5B%5D=2&x=y`,
		])
	})

	// v0: 80f8238c5b
	it("sorts what the custom serializer returns, keeping each key's values in order", async () => {
		const { api, calls } = await app({ buildSearchParams: brackets, sortSearchParams: true, throwOnError: true })
		await api.get("/test", { search: { z: "last", ids: [2, 1] } })
		expect(calls[0]?.url).toBe(`${ORIGIN}/test?ids%5B%5D=2&ids%5B%5D=1&z=last`)
	})
})

describe("SDK front: query serialization", () => {
	// v0: 64c7a6b83d
	// v0: ae685a18ac
	// v0: 9e6939e825
	// v0: 7fa63ad3d6
	it("appends the query, writing numbers and booleans as text", async () => {
		const { listItems, urls } = await sdkOf()
		await listItems({ search: { limit: 20, offset: 40, status: "active" } })
		await listItems({ search: { q: "foo" } })
		await listItems({ search: { limit: 10, q: "alice" } })
		await listItems({ search: { flag: true } })
		expect(urls()).toEqual([
			`${ORIGIN}/items?limit=20&offset=40&status=active`,
			`${ORIGIN}/items?q=foo`,
			`${ORIGIN}/items?limit=10&q=alice`,
			`${ORIGIN}/items?flag=true`,
		])
	})

	// v0: c0b2418c3e
	// v0: 5b9726f2c0
	it("repeats the key for each array item", async () => {
		const { listItems, urls } = await sdkOf()
		await listItems({ search: { tags: ["a", "b"] } })
		await listItems({ search: { ids: ["1", "2", "3"] } })
		expect(urls()).toEqual([`${ORIGIN}/items?tags=a&tags=b`, `${ORIGIN}/items?ids=1&ids=2&ids=3`])
	})

	// v0: 6739433526
	// v0: 557ae99876
	// v0: f4567265b5
	// v0: 8c67cdff2d
	// v0: 4713e39fae
	// v0: 05ad3f661b
	it("omits null, undefined and symbol values without throwing, and sends no query string without a search", async () => {
		const { listItems, urls } = await sdkOf()
		await listItems({ search: { page: undefined } })
		await listItems({})
		await listItems({ search: { active: undefined, page: 1 } })
		await listItems({ search: { skip: null } })
		await listItems({ search: { active: true, skip: null, top: undefined } })
		await listItems({ search: { tag: Symbol("x") } })
		expect(urls()).toEqual([
			`${ORIGIN}/items`,
			`${ORIGIN}/items`,
			`${ORIGIN}/items?page=1`,
			`${ORIGIN}/items`,
			`${ORIGIN}/items?active=true`,
			`${ORIGIN}/items`,
		])
	})

	// v0: 794d1127b9
	it("serializes a Date as URL-encoded ISO 8601", async () => {
		const { listItems, urls } = await sdkOf()
		await listItems({ search: { since: new Date("2026-01-01T00:00:00.000Z") } })
		expect(urls()).toEqual([`${ORIGIN}/items?since=2026-01-01T00%3A00%3A00.000Z`])
	})
})
