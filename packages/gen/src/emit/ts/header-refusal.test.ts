/**
 * A header the TS SDK cannot send (bit 19 b1): any control character but tab in a value, or a name outside the
 * token grammar, is a TypeError before anything goes out, naming the header and never quoting its value. The
 * platforms differ underneath: Node's Headers quotes a CR/LF/NUL value in its own error, and Bun sends `\u0001` and
 * DEL raw (probe: ~/.cache/honey-tmp/b19/probes/undici-header.txt), so the SDK checks before Headers sees either.
 * Nothing was answered, so the safe call (bit 21 i1) throws it too, never an Err.
 */
import { describe, expect, it } from "vitest"
import { emittedApp, emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

type Front = "app" | "sdk"
const FRONTS: readonly Front[] = ["sdk", "app"]
const SECRET = "s3cr3t"

/** `GET /items`, the SDK method `items.list`. */
const DOC = {
	info: { title: "Test", version: "1" },
	openapi: "3.1.0",
	paths: { "/items": { get: { operationId: "items.list", responses: { "200": { description: "ok" } } } } },
}

type List = { items: { list: (input: object) => Promise<unknown> } }
type Get = { get: (path: string, opts: object) => Promise<unknown> }

/**
 * What one `GET /items` through `front` with `headers` rejects with, and the requests it made: the normal call, or its
 * safe twin when `safe`.
 */
async function refused(
	front: Front,
	headers: Record<string, string>,
	config: Record<string, unknown> = {},
	safe = false,
) {
	const recorded = recordingFetch()
	const settings = { baseURL: "https://api.test", fetch: recorded.fetch, ...config }
	let call: Promise<unknown>
	if (front === "sdk") {
		const { TestSDK } = (await emittedSdk(DOC)) as unknown as { TestSDK: new (config: object) => List & { safe: List } }
		const sdk = new TestSDK(settings)
		call = (safe ? sdk.safe : sdk).items.list({ headers })
	} else {
		const { createClient } = (await emittedApp()) as unknown as {
			createClient: (config: object) => Get & { safe: Get }
		}
		const client = createClient(settings)
		call = (safe ? client.safe : client).get("/items", { headers })
	}
	const error = await call.then(
		() => null,
		(thrown: unknown) => thrown as Error,
	)
	return { error: error && `${error.name}: ${error.message}`, sent: recorded.calls.length }
}

describe.each(FRONTS)("a header the TS SDK cannot send, through the %s (bit 19 b1)", (front) => {
	it.each([
		["\\u0001", `${SECRET}\u0001x`],
		["DEL", `${SECRET}\u007fx`],
		["CR LF", `${SECRET}\r\nx-injected: 1`],
		["NUL", `${SECRET}\u0000`],
	])(
		"refuses %s in a per-call value as a TypeError naming the header, its value never quoted, nothing sent",
		async (_, value) => {
			expect(await refused(front, { "X-Bad": value })).toEqual({
				error: "TypeError: the X-Bad header's value cannot be sent",
				sent: 0,
			})
		},
	)

	it("refuses a header named 'bad name' by name, nothing sent", async () => {
		expect(await refused(front, { "bad name": SECRET })).toEqual({
			error: "TypeError: the bad name header cannot be sent",
			sent: 0,
		})
	})

	it("refuses a configured header's control character too, before the call's are added", async () => {
		expect(await refused(front, {}, { headers: { "X-Config": `${SECRET}\u0001` } })).toEqual({
			error: "TypeError: the X-Config header's value cannot be sent",
			sent: 0,
		})
	})

	it("throws the refusal from the safe call too, nothing sent", async () => {
		expect(await refused(front, { "X-Bad": `${SECRET}\u0001x` }, {}, true)).toEqual({
			error: "TypeError: the X-Bad header's value cannot be sent",
			sent: 0,
		})
	})

	it("sends a tab inside a value as it is", async () => {
		expect(await refused(front, { "X-Ok": "a\tb" })).toEqual({ error: null, sent: 1 })
	})
})
