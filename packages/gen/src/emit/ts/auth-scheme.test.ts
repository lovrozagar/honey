/**
 * The TS SDK's auth header follows the API's scheme (bit 19 b3, sweep item 1), as the Go, Rust, Python, C# and Java
 * SDKs do: under an apiKey-in-header scheme a refreshed token goes in that header with no prefix, under bearer as
 * `Authorization: Bearer`. The pair rule is the siblings': leave both unset for the scheme's; set the name and the
 * prefix is the caller's (unset meaning none); set only the prefix and the scheme's header keeps it.
 */
import { describe, expect, it } from "vitest"
import { emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

/** `GET /items` under `schemes`, the SDK method `items.list`. */
const doc = (schemes: Record<string, unknown>) => ({
	components: { securitySchemes: schemes },
	info: { title: "Test", version: "1" },
	openapi: "3.1.0",
	paths: { "/items": { get: { operationId: "items.list", responses: { "200": { description: "ok" } } } } },
	security: [Object.fromEntries(Object.keys(schemes).map((name) => [name, []]))],
})
const API_KEY = doc({ key: { in: "header", name: "X-API-Key", type: "apiKey" } })
const BEARER = doc({ bearer: { scheme: "bearer", type: "http" } })

/** The header lines of the retry `items.list` sends after a 401 and a refresh to `k`, under `document` and `config`. */
async function retried(document: Record<string, unknown>, config: Record<string, unknown> = {}) {
	let n = 0
	const recorded = recordingFetch(() => (n++ === 0 ? new Response(null, { status: 401 }) : Response.json({})))
	const { TestSDK } = (await emittedSdk(document)) as unknown as {
		TestSDK: new (config: object) => { items: { list: () => Promise<unknown> } }
	}
	const settings = { baseURL: "https://api.test", fetch: recorded.fetch, onAuthExpired: async () => "k", ...config }
	await new TestSDK(settings).items.list()
	const retry = recorded.calls[1]
	return { authorization: retry?.headers.get("authorization") ?? null, key: retry?.headers.get("x-api-key") ?? null }
}

describe("the TS SDK's auth header follows the API's scheme (bit 19 b3)", () => {
	it("sends an apiKey scheme's refreshed token in its header, with no prefix", async () => {
		expect(await retried(API_KEY)).toEqual({ authorization: null, key: "k" })
	})

	it("sends a bearer scheme's as Authorization: Bearer", async () => {
		expect(await retried(BEARER)).toEqual({ authorization: "Bearer k", key: null })
	})

	it("keeps a caller's header name, its prefix the caller's: none when unset", async () => {
		expect(await retried(BEARER, { authHeaderName: "X-API-Key" })).toEqual({ authorization: null, key: "k" })
	})

	it("keeps the scheme's header under a caller's prefix alone", async () => {
		expect(await retried(API_KEY, { authHeaderPrefix: "Token " })).toEqual({ authorization: null, key: "Token k" })
	})
})
