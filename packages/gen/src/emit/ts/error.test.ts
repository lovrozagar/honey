import { describe, expect, it } from "vitest"
import { emittedApp, emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

type Front = "app" | "sdk"
type Result = { data: unknown; error: unknown; response: Response; status: number }
type ClientErrorLike = Error & { body: unknown; response: Response; status: number }
type ErrorClass = new (init: { body: unknown; message: string; response: Response; status: number }) => ClientErrorLike
type Runtime = Record<string, ErrorClass> & {
	ClientError: ErrorClass
	isClientError: (value: unknown) => boolean
}

const FRONTS: readonly Front[] = ["sdk", "app"]

/** `GET /items`, the SDK method `items.list`. */
const DOC = {
	info: { title: "Test", version: "1" },
	openapi: "3.1.0",
	paths: { "/items": { get: { operationId: "items.list", responses: { "200": { description: "ok" } } } } },
}

/** The emitted module `front` vendors: its error classes and `isClientError`. */
async function runtime(front: Front): Promise<Runtime> {
	return (front === "sdk" ? await emittedSdk(DOC) : await emittedApp()) as unknown as Runtime
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

/** What a throw-mode `GET /items` answered by `answer` rejects with. */
async function rejection(front: Front, answer: () => Response, config: Record<string, unknown> = {}) {
	return get(front, answer, { throwOnError: true, ...config }).then(
		() => {
			throw new Error("the call resolved; a rejection was expected")
		},
		(error: unknown) => error as ClientErrorLike,
	)
}

/** A JSON answer with `status`. */
const json = (body: unknown, status: number) => () => Response.json(body, { status })

/** An answer with `body` as `contentType`. */
const typed = (body: string | null, contentType: string | null, status: number) => () =>
	new Response(body, { headers: contentType === null ? {} : { "content-type": contentType }, status })

/** honey's error envelope for `status` and `key`. */
function envelope(status: number, key: string) {
	return { error_key: key, fields: {}, message: "Not found", status, status_key: key, success: false }
}

describe("ClientError, constructed", () => {
	// v0: 446ce42471
	// v0: aafd93ed2c
	// v0: 531f82b0a5
	it.each(FRONTS)(
		"%s: an Error and a ClientError carrying the body, status, response and message given",
		async (front) => {
			const { ClientError } = await runtime(front)
			const body = {
				...envelope(404, "not_found"),
				fields: { name: [{ error_key: "required", message: "Required", path: "name" }] },
			}
			const response = new Response(null, { status: 404 })
			const error = new ClientError({ body, message: "HTTP 404", response, status: 404 })
			expect([error instanceof Error, error instanceof ClientError, error.body, error.status, error.message]).toEqual([
				true,
				true,
				body,
				404,
				"HTTP 404",
			])
			expect([error.body === body, error.response === response]).toEqual([true, true])
		},
	)

	// v0: 85bad261ea
	// v0: 93b6b5d441
	// v0: af3171aa45
	it.each(FRONTS)("%s: its name is ClientError", async (front) => {
		const { ClientError } = await runtime(front)
		expect(new ClientError({ body: {}, message: "m", response: new Response(), status: 400 }).name).toBe("ClientError")
	})

	// v0: ada2115191
	// v0: e1c79a7b11
	// v0: 9f8eced04f
	it.each(FRONTS)("%s: keeps any body shape as given, never flattening the envelope onto the error", async (front) => {
		const { ClientError } = await runtime(front)
		const custom = { reason: "Item deleted", suggestions: ["/items/456"] }
		const errors = [custom, envelope(400, "test")].map(
			(body) =>
				new ClientError({ body, message: "HTTP 400", response: new Response(null, { status: 400 }), status: 400 }),
		)
		expect(errors.map((error) => [error.body, "errorKey" in error, "statusKey" in error, "fields" in error])).toEqual([
			[custom, false, false, false],
			[envelope(400, "test"), false, false, false],
		])
	})

	// v0: 9d5495ec96
	it.each(FRONTS)("%s: its stack starts at the caller, without the constructor's own frame", async (front) => {
		const { ClientError } = await runtime(front)
		const error = new ClientError({ body: {}, message: "m", response: new Response(), status: 400 })
		expect(error.stack).not.toMatch(/at new \w*ClientError/)
	})
})

describe("isClientError", () => {
	// v0: 43adbf8d3c
	// v0: f18675c8c3
	// v0: 6e5ef4f6fd
	// v0: cf08a4d905
	// v0: 73d50ab411
	// v0: d88da41a27
	// v0: 2b2699e7d5
	it.each(FRONTS)("%s: true for a ClientError or a status subclass, false for any other value", async (front) => {
		const { ClientError, NotFoundError, isClientError } = await runtime(front)
		const init = { body: {}, message: "HTTP 404", response: new Response(null, { status: 404 }), status: 404 }
		class CustomError extends Error {}
		const lookalike = { body: {}, name: "ClientError", status: 404 }
		const values = [new ClientError(init), new NotFoundError(init), new Error("nope"), new CustomError("nope")]
		expect([...values, lookalike, null, undefined, "string", 42, {}].map((value) => isClientError(value))).toEqual([
			true,
			true,
			false,
			false,
			false,
			false,
			false,
			false,
			false,
			false,
		])
	})

	// v0: 0fedaf926a
	// v0: 79ddd8e169
	it("api.$isClientError answers exactly as isClientError: a thrown error yes, a safe-mode error no", async () => {
		const { createClient, isClientError } = (await emittedApp()) as unknown as Runtime & {
			createClient: (config: object) => { $isClientError: (value: unknown) => boolean }
		}
		const api = createClient({ baseURL: "https://api.test", fetch: recordingFetch().fetch })
		const answer = json(envelope(404, "not_found"), 404)
		const safe = ((await get("app", answer)) as Result).error
		const values = [await rejection("app", answer), safe, new Error("x"), null, undefined, {}]
		const expected = [true, false, false, false, false, false]
		expect([values.map((v) => api.$isClientError(v)), values.map((v) => isClientError(v))]).toEqual([
			expected,
			expected,
		])
	})
})

/* each status's ClientError subclass; any other status throws the base class */
const STATUS_CLASSES: ReadonlyArray<readonly [number, string]> = [
	[400, "BadRequestError"],
	[401, "UnauthorizedError"],
	[403, "ForbiddenError"],
	[404, "NotFoundError"],
	[409, "ConflictError"],
	[422, "UnprocessableEntityError"],
	[429, "RateLimitError"],
	[500, "InternalServerError"],
	[502, "BadGatewayError"],
	[503, "ServiceUnavailableError"],
	[504, "GatewayTimeoutError"],
	[418, "ClientError"],
]

describe("throw mode: a non-2xx rejects with the status's ClientError", () => {
	// v0: 4b28b5125a
	// v0: b23536e1a6
	it.each(FRONTS)(
		"%s: each status rejects with its own subclass, named after it, its message stripped of control characters",
		async (front) => {
			const mod = await runtime(front)
			const thrown = await Promise.all(
				STATUS_CLASSES.map(([status]) => rejection(front, json({ message: "who\u0007" }, status))),
			)
			expect(
				thrown.map((error, i) => {
					const name = STATUS_CLASSES[i]?.[1] ?? ""
					return [
						error instanceof (mod[name] as ErrorClass),
						error instanceof mod.ClientError,
						error.name,
						error.status,
						error.message,
					]
				}),
			).toEqual(STATUS_CLASSES.map(([status, name]) => [true, true, name, status, "who"]))
		},
	)
})

/* [answer, its ClientError subclass, the body the error carries] */
const THROWN: ReadonlyArray<readonly [() => Response, string, unknown]> = [
	// v0: 1e5b8d9d3a
	// v0: 741208d659
	// v0: c7f82dcae8
	// v0: 8649409ebf
	[json(envelope(404, "not_found"), 404), "NotFoundError", envelope(404, "not_found")],
	// v0: d002e81d87
	// v0: fb6593469a
	[json({ code: "ERR_GONE", message: "gone" }, 410), "ClientError", { code: "ERR_GONE", message: "gone" }],
	// v0: 3792aab0ac
	[json({ message: "boom" }, 500), "InternalServerError", { message: "boom" }],
	// v0: 7344626b6f
	[json({ reason: "nope", ts: 2000 }, 400), "BadRequestError", { reason: "nope", ts: 2000 }],
]

describe("throw mode: what the thrown ClientError carries", () => {
	// v0: e4b98863f9
	it.each(FRONTS)(
		"%s: an Error isClientError accepts, with the HTTP status and the parsed body, extra fields kept",
		async (front) => {
			const mod = await runtime(front)
			const thrown = await Promise.all(THROWN.map(([answer]) => rejection(front, answer)))
			expect(
				thrown.map((error, i) => [
					error instanceof Error,
					mod.isClientError(error),
					error instanceof (mod[THROWN[i]?.[1] ?? ""] as ErrorClass),
					error.status,
					error.body,
				]),
			).toEqual(THROWN.map(([answer, , body]) => [true, true, true, answer().status, body]))
		},
	)

	// v0: 3ad57ef8f3
	// v0: 29a2c3a702
	it.each(FRONTS)(
		"%s: the same failure resolves in safe mode and rejects in throw mode, the body and status alike",
		async (front) => {
			const answer = json(envelope(404, "not_found"), 404)
			const safe = (await get(front, answer)) as Result
			const thrown = await rejection(front, answer)
			expect([safe.data, thrown.body, thrown.status]).toEqual([null, safe.error, safe.status])
		},
	)
})

/* [answer, the thrown ClientError's message, its body] */
const MESSAGES: ReadonlyArray<readonly [() => Response, string, unknown]> = [
	// v0: 92c289628b
	[json({ message: "not found" }, 404), "not found", { message: "not found" }],
	// v0: 0df192ecdb
	[json({ code: "ERR_X" }, 503), "HTTP 503", { code: "ERR_X" }],
	// v0: 262dee1e93
	// v0: 7d2db2844e
	[json({ message: { detail: "x" } }, 500), "HTTP 500", { message: { detail: "x" } }],
	// v0: 3f8adf51c1
	[typed("<html>oops</html>", "text/html", 500), "HTTP 500", "<html>oops</html>"],
	// v0: ca13d2e174
	[
		json({ message: `${"x".repeat(10_000)}\u0001\u0002junk` }, 500),
		"x".repeat(512),
		{ message: `${"x".repeat(10_000)}\u0001\u0002junk` },
	],
	// v0: fcfa5e14b0
	[
		json({ message: `${"x".repeat(1000)}\u0001\u0002junk` }, 500),
		"x".repeat(512),
		{ message: `${"x".repeat(1000)}\u0001\u0002junk` },
	],
]

describe("the thrown ClientError's message", () => {
	it.each(FRONTS)(
		"%s: a string message, stripped of control characters and capped at 512, else HTTP <status>; the body untouched",
		async (front) => {
			const thrown = await Promise.all(MESSAGES.map(([answer]) => rejection(front, answer)))
			expect(thrown.map((error) => [error.message, error.body])).toEqual(
				MESSAGES.map(([, message, body]) => [message, body]),
			)
		},
	)

	// v0: f0e741df66
	// v0: 8c5455f3ac
	it.each(FRONTS)("%s: maxErrorMessageChars sets the cap", async (front) => {
		const error = await rejection(front, json({ message: "x".repeat(100) }, 500), { maxErrorMessageChars: 8 })
		expect(error.message).toBe("xxxxxxxx")
	})
})

/* [a non-2xx answer whose body is no JSON object, the body its ClientError carries] */
const OPAQUE: ReadonlyArray<readonly [() => Response, unknown]> = [
	[typed("<html>bad gateway</html>", "text/html", 502), "<html>bad gateway</html>"],
	[typed("Internal Server Error", "text/html", 500), "Internal Server Error"],
	[typed(null, null, 503), null],
	[json(null, 500), null],
]

describe("safe mode: the error a failed call resolves with", () => {
	// v0: 6ae275b4c0
	// v0: f10ead7d5a
	it.each(FRONTS)("%s: a JSON object body is the error itself, a plain object and no ClientError", async (front) => {
		const { ClientError, isClientError } = await runtime(front)
		const { error } = (await get(front, json(envelope(404, "not_found"), 404))) as Result
		expect([error, error instanceof Error, error instanceof ClientError, isClientError(error)]).toEqual([
			envelope(404, "not_found"),
			false,
			false,
			false,
		])
	})

	// v0: cc1f8a93e9
	// v0: f4f728515b
	it.each(FRONTS)(
		"%s: any other body makes the error a ClientError with the result's status, so if (error) never misses",
		async (front) => {
			const { isClientError } = await runtime(front)
			const results = (await Promise.all(OPAQUE.map(([answer]) => get(front, answer)))) as Array<{
				error: ClientErrorLike
				status: number
			}>
			expect(results.map(({ error, status }) => [isClientError(error), error.status === status, error.body])).toEqual(
				OPAQUE.map(([, body]) => [true, true, body]),
			)
		},
	)
})
