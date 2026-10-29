import { describe, expect, it } from "vitest"
import { emittedApp, emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

type Front = "app" | "sdk"
type Method = "delete" | "get" | "post"
type Result =
	| { ok: true; data: unknown; response: Response }
	| { ok: false; error: Error & { body: unknown; status: number }; response: Response }

const FRONTS: readonly Front[] = ["sdk", "app"]

/** A declared JSON answer. */
const JSON_BODY = { content: { "application/json": {} } }

/**
 * `GET`, `POST` and `DELETE /items`, the SDK methods `items.list`, `items.create` and `items.remove`;
 * `GET /moved`, declaring only a 307, and `PUT /items`, a 200 without content: no success body.
 */
const DOC = {
	info: { title: "Test", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/items": {
			delete: { operationId: "items.remove", responses: { "204": { description: "gone" } } },
			get: { operationId: "items.list", responses: { "200": { description: "ok", ...JSON_BODY } } },
			post: { operationId: "items.create", responses: { "201": { description: "made", ...JSON_BODY } } },
			put: { operationId: "items.touch", responses: { "200": { description: "touched" } } },
		},
		"/moved": {
			get: {
				operationId: "moved",
				responses: { "307": { description: "moved", headers: { location: { schema: { type: "string" } } } } },
			},
		},
	},
}
const SDK_METHOD = { delete: "remove", get: "list", post: "create" } as const

type Calls<T> = Record<string, (input: object) => Promise<T>>
type Verbs<T> = Record<Method, (path: string, input: object) => Promise<T>>

/** One `method /items` call through `front` (the SDK class or the app client), answered by `answer`: its Result. */
async function call(front: Front, answer: () => Response, method: Method = "get"): Promise<Result> {
	return send(front, answer, method, true) as Promise<Result>
}

/** The same call through the normal client: its value, an error status thrown. */
async function thrown(front: Front, answer: () => Response, method: Method = "get"): Promise<unknown> {
	return send(front, answer, method, false)
}

/** One `method /items` call through `front`, its safe twin when `safe`. */
async function send(front: Front, answer: () => Response, method: Method, safe: boolean): Promise<unknown> {
	const settings = { baseURL: "https://api.test", fetch: recordingFetch(answer).fetch }
	const input = method === "post" ? { json: { name: "a" } } : {}
	if (front === "sdk") {
		const { TestSDK } = (await emittedSdk(DOC)) as unknown as {
			TestSDK: new (config: object) => { items: Calls<unknown>; safe: { items: Calls<unknown> } }
		}
		const sdk = new TestSDK(settings)
		return (safe ? sdk.safe.items : sdk.items)[SDK_METHOD[method]]?.(input)
	}
	const { createClient } = (await emittedApp()) as unknown as {
		createClient: (config: object) => Verbs<unknown> & { safe: Verbs<unknown> }
	}
	const client = createClient(settings)
	return (safe ? client.safe : client)[method]("/items", input)
}

/** A Result's error arm, or a failure naming the arm it got. */
function errOf(result: Result) {
	if (result.ok) throw new Error(`expected an Err, got Ok ${JSON.stringify(result.data)}`)
	return result
}

/** A JSON answer with `status`. */
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	Response.json(body, { headers, status })

/** honey's error envelope for `status`, `key` and `fields`. */
function envelope(status: number, key: string, fields: Record<string, unknown> = {}) {
	return { error_key: key, fields, message: "Rejected", request_id: "req-1", status, status_key: key, success: false }
}

describe("a safe call's 2xx answer: { ok: true, data, response }", () => {
	// v0: 091340af93
	// v0: 80921780d9
	// v0: e45e2d4201
	// v0: d5298d8cd1
	// v0: 924b793b81
	// v0: 9c34aa9ebd
	// v0: fc8e23e301
	it.each(FRONTS)("%s resolves exactly ok, the parsed body and the Response, its status numeric", async (front) => {
		const result = await call(front, () => json([{ id: "1", name: "Alice" }]))
		expect(result).toEqual({ data: [{ id: "1", name: "Alice" }], ok: true, response: expect.any(Response) })
		expect(result.response.status).toBe(200)
	})

	// v0: b5fdd1360b
	it.each(FRONTS)("%s hands back the server's own Response, its headers readable", async (front) => {
		const { response } = await call(front, () => new Response("ok", { headers: { "x-trace": "t-1" } }))
		expect([response.headers.get("content-type"), response.headers.get("x-trace")]).toEqual([
			"text/plain;charset=UTF-8",
			"t-1",
		])
	})

	// v0: 89b66eb842
	it.each(FRONTS)("%s keeps a 201 as the result's response status", async (front) => {
		const result = await call(front, () => json({ id: "1" }, 201), "post")
		expect([result.ok, result.ok && result.data, result.response.status]).toEqual([true, { id: "1" }, 201])
	})
})

/** A 204 No Content answer. */
const noContent = () => new Response(null, { status: 204 })

describe("a 204 No Content answer", () => {
	// v0: 041b9a2d0c
	// v0: 0a9df4cde3
	// v0: 56285fd8ff
	// v0: 5fbb101f38
	it.each(FRONTS)("%s's safe call resolves ok, data null, status 204", async (front) => {
		const result = await call(front, noContent, "delete")
		expect([result.ok, result.ok && result.data, result.response.status]).toEqual([true, null, 204])
	})

	// v0: caee5f8ccd
	// v0: 2571c2bc9f
	it.each(FRONTS)("%s's normal call resolves null", async (front) => {
		expect(await thrown(front, noContent, "delete")).toBeNull()
	})
})

/**
 * `items.touch` and `moved` through the SDK class (its safe twin when `safe`), each answered by a JSON body the
 * operation does not declare, as a followed redirect's target answers; `cancelled` counts the bodies discarded.
 */
async function bodiless(safe: boolean, input: object = {}) {
	let cancelled = 0
	const body = () =>
		new ReadableStream<Uint8Array>(
			{
				cancel: () => {
					cancelled++
				},
				pull: (controller) => {
					controller.enqueue(new TextEncoder().encode('{"echoed":true}'))
					controller.close()
				},
			},
			{ highWaterMark: 0 },
		)
	const echo = () => new Response(body(), { headers: { "content-type": "application/json" } })
	type Ops = { items: { touch: (input: object) => unknown }; moved: (input: object) => unknown }
	const { TestSDK } = (await emittedSdk(DOC)) as unknown as { TestSDK: new (config: object) => Ops & { safe: Ops } }
	const sdk = new TestSDK({ baseURL: "https://api.test", fetch: recordingFetch(echo).fetch })
	const ops = safe ? sdk.safe : sdk
	const results = await Promise.all([ops.items.touch(input), ops.moved(input)])
	return { cancelled, results }
}

describe("an operation that declares no success body: its data is null, its body behind raw", () => {
	it("a safe call resolves ok, data null, the 2xx status, the body discarded unread", async () => {
		const { cancelled, results } = await bodiless(true)
		const seen = (results as Result[]).map((r) => [r.ok, r.ok && r.data, r.response.status])
		expect({ cancelled, seen }).toEqual({
			cancelled: 2,
			seen: [
				[true, null, 200],
				[true, null, 200],
			],
		})
	})

	it("a normal call resolves null, the body discarded unread", async () => {
		expect(await bodiless(false)).toEqual({ cancelled: 2, results: [null, null] })
	})

	it("with raw: true the normal call resolves the Response, its body readable", async () => {
		const { cancelled, results } = await bodiless(false, { raw: true })
		const bodies = await Promise.all((results as Response[]).map((r) => r.json()))
		expect({ bodies, cancelled }).toEqual({ bodies: [{ echoed: true }, { echoed: true }], cancelled: 0 })
	})

	it("with raw: true the safe call resolves ok, the Response its data, its body readable", async () => {
		const { cancelled, results } = await bodiless(true, { raw: true })
		const responses = (results as Result[]).map((r) => (r.ok ? r.data : r.error))
		const bodies = await Promise.all((responses as Response[]).map((r) => r.json()))
		expect({ bodies, cancelled }).toEqual({ bodies: [{ echoed: true }, { echoed: true }], cancelled: 0 })
	})
})

describe("a normal call's 2xx answer", () => {
	// v0: 2efaedd4e1
	// v0: 2e83b29115
	it.each(FRONTS)("%s resolves the parsed body itself, not a result", async (front) => {
		expect(await thrown(front, () => json({ id: "1", name: "Test" }))).toEqual({
			id: "1",
			name: "Test",
		})
	})
})

/** A proxy's HTML 502 page. */
const badGateway = () =>
	new Response("<html>bad gateway</html>", { headers: { "content-type": "text/html" }, status: 502 })

/* each non-2xx answer as [status, JSON body, the error class it is] */
const FAILURES: ReadonlyArray<readonly [number, Record<string, unknown>, string]> = [
	[403, { message: "Forbidden" }, "ForbiddenError"],
	[404, envelope(404, "not_found"), "NotFoundError"],
	[
		422,
		envelope(422, "validation_error", { name: [{ error_key: "required", message: "Required", path: "name" }] }),
		"UnprocessableEntityError",
	],
	[500, { message: "Server error" }, "InternalServerError"],
]

describe("a safe call's non-2xx JSON answer: { ok: false, error: its ClientError, response }", () => {
	// v0: 51c69e7164
	// v0: 34728d7a98
	// v0: 5751e4a67b
	// v0: 906b7a7d38
	// v0: 9837436fa1
	// v0: aa60f4c20f
	// v0: d98726b2da
	// v0: ded04e6dff
	// v0: 9a6154239c
	it.each(FRONTS)(
		"%s resolves, never rejects, its error the status's ClientError with the parsed body",
		async (front) => {
			const results = await Promise.all(FAILURES.map(([status, body]) => call(front, () => json(body, status))))
			const seen = results.map(errOf).map(({ error, ok, response }) => {
				const fields = { body: error.body, name: error.name, status: error.status }
				return { error: fields, ok, response: response.status }
			})
			expect(seen).toEqual(
				FAILURES.map(([status, body, name]) => ({ error: { body, name, status }, ok: false, response: status })),
			)
		},
	)

	// v0: 9b684ba7f9
	it.each(FRONTS)("%s hands back the server's Response on the error path too, headers intact", async (front) => {
		const answer = () => json(envelope(404, "not_found"), 404, { "x-trace": "t-2" })
		const { response } = await call(front, answer)
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
		const result = errOf(await call(front, () => json(body, 403)))
		expect([result.error.body, await result.response.json()]).toEqual([body, body])
	})

	// v0: 862e5c0c21
	it.each(FRONTS)("%s yields an Err whose error carries the status, whatever the body", async (front) => {
		const result = errOf(await call(front, badGateway))
		const { body, name, status } = result.error
		expect([result.ok, name, status, body, result.response.status]).toEqual([
			false,
			"BadGatewayError",
			502,
			"<html>bad gateway</html>",
			502,
		])
	})
})
