/**
 * The TS SDK's safe call (`client.safe`, bit 21 i1) over its error kinds in the default run (bit 19 f, sweep 20): an
 * API answer is its Result's Err beside the Response, an error status as its ClientError subclass (the envelope its
 * body) and an undecodable 2xx as DecodeError (v0 7c6878d7c4; every sibling's safe call answers it so from bit 21 i).
 * No answer is thrown: a path that cannot be built (a status-0 ClientError, never sent), a timeout, the caller's abort,
 * a refused connection (APIConnectionError, f2) and a throwing hook.
 */
import { describe, expect, it } from "vitest"
import { emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

const DOC = {
	info: { title: "T", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/items/{id}": {
			get: {
				operationId: "items.get",
				parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
				responses: {
					200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" },
					404: { description: "gone" },
				},
			},
		},
	},
}

type Get = (
	input: object,
) => Promise<
	{ ok: true; data: unknown; response: Response } | { ok: false; error: Error & { body: unknown }; response: Response }
>

/**
 * Where `client.safe.items.get` with `input` under `config` landed: the Result's arm, its Response's status, and its
 * data or its error's class and body; or the name of what it threw.
 */
async function landed(answer: (request: Request) => Response | Promise<Response>, input: object, config = {}) {
	const { TestSDK } = (await emittedSdk(DOC)) as unknown as {
		TestSDK: new (config: object) => { safe: { items: { get: Get } } }
	}
	const sdk = new TestSDK({ baseURL: "https://api.test", fetch: recordingFetch(answer).fetch, ...config })
	return sdk.safe.items.get({ params: { id: "i1" }, ...input }).then(
		(r) =>
			r.ok
				? ["ok", r.response.status, r.data]
				: ["err", r.response.status, r.error.constructor.name, r.error.name, r.error.body],
		(e: Error) => ["thrown", e.name],
	)
}

const never = (request: Request) =>
	new Promise<Response>((_, reject) =>
		request.signal.addEventListener("abort", () => reject(request.signal.reason as Error)),
	)

describe("the safe call over the TS SDK's error kinds (bit 19 f, bit 21 i1)", () => {
	it("answers an error status and an undecodable 2xx as an Err; throws an unbuilt path, a timeout, an abort, a refused connection and a hook", async () => {
		const status = await landed(
			() => Response.json({ error_key: "item.missing", message: "gone" }, { status: 404 }),
			{},
		)
		const path = await landed(() => Response.json({}), { params: { id: ".." } })
		const torn = await landed(() => new Response('{"id":', { headers: { "content-type": "application/json" } }), {})
		const timeout = await landed(never, { timeout: 20 })
		const abort = await landed(never, { signal: AbortSignal.abort() })
		const refused = await landed(() => Promise.reject(new TypeError("fetch failed")), {})
		const boom = () => {
			throw new RangeError("boom")
		}
		const hooked = await landed(() => Response.json({}), {}, { onRequest: [boom] })
		const ok = await landed(() => Response.json({ id: "i1" }), {})
		expect({ abort, hooked, ok, path, refused, status, timeout, torn }).toEqual({
			abort: ["thrown", "AbortError"],
			hooked: ["thrown", "RangeError"],
			ok: ["ok", 200, { id: "i1" }],
			path: ["thrown", "ClientError"],
			refused: ["thrown", "APIConnectionError"],
			status: ["err", 404, "NotFoundError", "NotFoundError", { error_key: "item.missing", message: "gone" }],
			timeout: ["thrown", "TimeoutError"],
			torn: ["err", 200, "DecodeError", "DecodeError", '{"id":'],
		})
	})
})
