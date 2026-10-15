import { describe, expect, it } from "vitest"
import { emittedApp, emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

type Front = "app" | "sdk"
type Result = { data: unknown; error: unknown; response: Response; status: number }

const FRONTS: readonly Front[] = ["sdk", "app"]

/** `GET /items`, the SDK method `items.list`. */
const DOC = {
	info: { title: "Test", version: "1" },
	openapi: "3.1.0",
	paths: { "/items": { get: { operationId: "items.list", responses: { "200": { description: "ok" } } } } },
}

/** One `GET /items` through `front` (the SDK class or the app client), answered by `answer`. */
async function get(front: Front, answer: () => Response, config: Record<string, unknown> = {}): Promise<unknown> {
	const settings = { baseURL: "https://api.test", fetch: recordingFetch(answer).fetch, ...config }
	if (front === "sdk") {
		const { TestSDK } = (await emittedSdk(DOC)) as unknown as {
			TestSDK: new (config: object) => { items: { list: () => Promise<unknown> } }
		}
		return new TestSDK(settings).items.list()
	}
	const { createClient } = (await emittedApp()) as unknown as {
		createClient: (config: object) => { get: (path: string) => Promise<unknown> }
	}
	return createClient(settings).get("/items")
}

/** An answer with `body` as `contentType`, or no `Content-Type` at all when it is null. */
function typed(body: string | null, contentType: string | null, status = 200): () => Response {
	return () => new Response(body, { headers: contentType === null ? {} : { "content-type": contentType }, status })
}

/* [content type, body, the data a 2xx answer parses to] */
const PARSED: ReadonlyArray<readonly [string, string, unknown]> = [
	// v0: 7d00cdc419
	// v0: 86c23526d8
	["application/json", '{"ok":true}', { ok: true }],
	// v0: b5d1d7f84b
	["application/json; charset=utf-8", '{"method":"GET"}', { method: "GET" }],
	// v0: 2b98a2cea5
	// v0: ddbbae8b5b
	["application/problem+json", '{"type":"about:blank"}', { type: "about:blank" }],
	// v0: 317418d74f
	["application/vnd.api+json", '{"ok":true}', { ok: true }],
	// v0: 4c41fe3f1b
	["application/vnd.api+json; charset=utf-8", '{"ok":true}', { ok: true }],
	// v0: 358ff0ebb5
	// v0: dbf7fb4327
	["text/html", "<html>error</html>", "<html>error</html>"],
	// v0: dc614f32b0
	// v0: e498ad6139
	["text/plain", "ok", "ok"],
]

describe("a 2xx body, parsed by its media type", () => {
	it.each(PARSED)("%s parses to the same data through the SDK and the app client", async (contentType, body, data) => {
		const results = await Promise.all(FRONTS.map((front) => get(front, typed(body, contentType))))
		expect(results.map((result) => (result as Result).data)).toEqual([data, data])
	})

	// v0: 1a31cddf16
	// v0: fedd2850e1
	it.each(FRONTS)("%s reads application/jsonp, no JSON media type, as bytes", async (front) => {
		const { data } = (await get(front, typed("callback({});", "application/jsonp"))) as Result
		expect([data instanceof Uint8Array, new TextDecoder().decode(data as Uint8Array)]).toEqual([true, "callback({});"])
	})
})

describe("an empty or invalid 2xx body", () => {
	// v0: d7232ea91d
	it.each(FRONTS)(
		"%s in throw mode: empty JSON and no body are null, xml is text, invalid JSON rejects with the status",
		async (front) => {
			const throwing = { throwOnError: true }
			const settled = await Promise.all(
				[
					typed("", "application/json", 201),
					typed(null, null),
					typed("<a/>", "application/xml"),
					typed("{oops", "application/json"),
				].map((answer) => get(front, answer, throwing).catch((error: unknown) => ({ rejected: error }))),
			)
			expect(settled).toEqual([null, null, "<a/>", { rejected: expect.objectContaining({ status: 200 }) }])
		},
	)

	// v0: 7c6878d7c4
	it.each(FRONTS)(
		"%s in safe mode: invalid JSON resolves data null, a truthy error, the status and the Response",
		async (front) => {
			const result = (await get(front, typed("{not json", "application/json"))) as Result
			expect([result.data, Boolean(result.error), result.status, result.response instanceof Response]).toEqual([
				null,
				true,
				200,
				true,
			])
		},
	)
})

/* `GET /notes` declares text, `GET /blob` bytes, `GET /items` no body */
const DECLARED = {
	...DOC,
	paths: {
		...DOC.paths,
		"/blob": {
			get: { operationId: "blob.get", responses: { "200": { content: { "image/png": {} }, description: "" } } },
		},
		"/notes": {
			get: { operationId: "notes.get", responses: { "200": { content: { "text/plain": {} }, description: "" } } },
		},
	},
}

describe("an empty 2xx body, read by what the operation declares", () => {
	it("resolves a declared text answer to an empty string, declared bytes to zero bytes, and no body to null", async () => {
		type Sdk = {
			blob: { get: () => Promise<Result> }
			items: { list: () => Promise<Result> }
			notes: { get: () => Promise<Result> }
		}
		const { TestSDK } = (await emittedSdk(DECLARED)) as unknown as { TestSDK: new (config: object) => Sdk }
		const fetch = recordingFetch(() => new Response(null, { headers: { "content-type": "application/octet-stream" } }))
		const sdk = new TestSDK({ baseURL: "https://api.test", fetch: fetch.fetch })
		const [text, bytes, none] = await Promise.all([sdk.notes.get(), sdk.blob.get(), sdk.items.list()])
		const data = bytes.data as Uint8Array
		expect([text.data, data instanceof Uint8Array, data.byteLength, none.data]).toEqual(["", true, 0, null])
	})
})
