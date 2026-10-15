import { describe, expect, it } from "vitest"
import { emittedApp, emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

type Front = "app" | "sdk"
type Method = "delete" | "get" | "post"
type Result = { data: unknown; error: unknown; response: Response; status: number }

const FRONTS: readonly Front[] = ["sdk", "app"]

/** `GET`, `POST` and `DELETE /items`, the SDK methods `items.list`, `items.create` and `items.remove`. */
const DOC = {
	info: { title: "Test", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/items": {
			delete: { operationId: "items.remove", responses: { "204": { description: "gone" } } },
			get: { operationId: "items.list", responses: { "200": { description: "ok" } } },
			post: { operationId: "items.create", responses: { "201": { description: "made" } } },
		},
	},
}
const SDK_METHOD = { delete: "remove", get: "list", post: "create" } as const

/** One `method /items` call through `front` (the SDK class or the app client), answered by `answer`. */
async function call(
	front: Front,
	answer: () => Response,
	config: Record<string, unknown> = {},
	method: Method = "get",
): Promise<unknown> {
	const settings = { baseURL: "https://api.test", fetch: recordingFetch(answer).fetch, ...config }
	const input = method === "post" ? { json: { name: "a" } } : {}
	if (front === "sdk") {
		const { TestSDK } = (await emittedSdk(DOC)) as unknown as {
			TestSDK: new (config: object) => { items: Record<string, (input: object) => Promise<unknown>> }
		}
		return new TestSDK(settings).items[SDK_METHOD[method]]?.(input)
	}
	const { createClient } = (await emittedApp()) as unknown as {
		createClient: (config: object) => Record<Method, (path: string, input: object) => Promise<unknown>>
	}
	return createClient(settings)[method]("/items", input)
}

/** A JSON answer with `status`. */
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	Response.json(body, { headers, status })

/** honey's error envelope for `status`, `key` and `fields`. */
function envelope(status: number, key: string, fields: Record<string, unknown> = {}) {
	return { error_key: key, fields, message: "Rejected", request_id: "req-1", status, status_key: key, success: false }
}

describe("safe mode, a 2xx answer: { data, error: null, response, status }", () => {
	// v0: 091340af93
	// v0: 80921780d9
	// v0: e45e2d4201
	// v0: d5298d8cd1
	// v0: 924b793b81
	// v0: 9c34aa9ebd
	// v0: fc8e23e301
	it.each(FRONTS)(
		"%s resolves exactly the parsed body, a null error, the Response and the numeric status",
		async (front) => {
			const result = await call(front, () => json([{ id: "1", name: "Alice" }]))
			expect(result).toEqual({
				data: [{ id: "1", name: "Alice" }],
				error: null,
				response: expect.any(Response),
				status: 200,
			})
		},
	)

	// v0: b5fdd1360b
	it.each(FRONTS)("%s hands back the server's own Response, its headers readable", async (front) => {
		const { response } = (await call(front, () => new Response("ok", { headers: { "x-trace": "t-1" } }))) as Result
		expect([response.headers.get("content-type"), response.headers.get("x-trace")]).toEqual([
			"text/plain;charset=UTF-8",
			"t-1",
		])
	})

	// v0: 89b66eb842
	it.each(FRONTS)("%s keeps a 201 as the result's status", async (front) => {
		const result = (await call(front, () => json({ id: "1" }, 201), {}, "post")) as Result
		expect([result.data, result.error, result.status]).toEqual([{ id: "1" }, null, 201])
	})
})

/** A 204 No Content answer. */
const noContent = () => new Response(null, { status: 204 })

describe("a 204 No Content answer", () => {
	// v0: 041b9a2d0c
	// v0: 0a9df4cde3
	// v0: 56285fd8ff
	// v0: 5fbb101f38
	it.each(FRONTS)("%s in safe mode resolves data null, error null, status 204", async (front) => {
		const result = (await call(front, noContent, {}, "delete")) as Result
		expect([result.data, result.error, result.status]).toEqual([null, null, 204])
	})

	// v0: caee5f8ccd
	// v0: 2571c2bc9f
	it.each(FRONTS)("%s in throw mode resolves null", async (front) => {
		expect(await call(front, noContent, { throwOnError: true }, "delete")).toBeNull()
	})
})

describe("throw mode, a 2xx answer", () => {
	// v0: 2efaedd4e1
	// v0: 2e83b29115
	it.each(FRONTS)("%s resolves the parsed body itself, not a result", async (front) => {
		expect(await call(front, () => json({ id: "1", name: "Test" }), { throwOnError: true })).toEqual({
			id: "1",
			name: "Test",
		})
	})
})

/** A proxy's HTML 502 page. */
const badGateway = () =>
	new Response("<html>bad gateway</html>", { headers: { "content-type": "text/html" }, status: 502 })

/* each non-2xx answer as [status, JSON body] */
const FAILURES: ReadonlyArray<readonly [number, Record<string, unknown>]> = [
	[403, { message: "Forbidden" }],
	[404, envelope(404, "not_found")],
	[422, envelope(422, "validation_error", { name: [{ error_key: "required", message: "Required", path: "name" }] })],
	[500, { message: "Server error" }],
]

describe("safe mode, a non-2xx JSON answer: { data: null, error: the body, response, status }", () => {
	// v0: 51c69e7164
	// v0: 34728d7a98
	// v0: 5751e4a67b
	// v0: 906b7a7d38
	// v0: 9837436fa1
	// v0: aa60f4c20f
	// v0: d98726b2da
	// v0: ded04e6dff
	// v0: 9a6154239c
	it.each(FRONTS)("%s resolves, never rejects, with the parsed body as the error", async (front) => {
		const results = await Promise.all(FAILURES.map(([status, body]) => call(front, () => json(body, status))))
		expect(results).toEqual(
			FAILURES.map(([status, body]) => ({ data: null, error: body, response: expect.any(Response), status })),
		)
	})

	// v0: 9b684ba7f9
	it.each(FRONTS)("%s hands back the server's Response on the error path too, headers intact", async (front) => {
		const answer = () => json(envelope(404, "not_found"), 404, { "x-trace": "t-2" })
		const { response } = (await call(front, answer)) as Result
		expect([response.status, response.headers.get("content-type"), response.headers.get("x-trace")]).toEqual([
			404,
			"application/json",
			"t-2",
		])
	})

	// v0: 4931052a5f
	// v0: 5964e66cd7
	// v0: 82e5ebbd8a
	it.each(FRONTS)("%s leaves the Response body unread: the caller can still read it", async (front) => {
		const body = envelope(403, "forbidden")
		const result = (await call(front, () => json(body, 403))) as Result
		expect([result.error, await result.response.json()]).toEqual([body, body])
	})

	// v0: 862e5c0c21
	it.each(FRONTS)("%s yields a truthy error carrying the status, whatever the body", async (front) => {
		const result = (await call(front, badGateway)) as { error: { status: number } | null; status: number }
		expect([Boolean(result.error), result.error?.status, result.status]).toEqual([true, 502, 502])
	})
})
