/**
 * The TS SDK's safe mode over its error kinds in the default run (bit 19 f, sweep 20; the grid runs it too, so no grid
 * doubling, Q11): an error status lands in the result beside its status and Response, its envelope as the error; a
 * path that cannot be built is a status-0 result; an undecodable 2xx is a result too (v0 7c6878d7c4, TS's own: the
 * siblings raise it); a timeout, the caller's abort, a refused connection (APIConnectionError, f2) and a throwing hook
 * are thrown.
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

type Get = (input: object) => Promise<{ data: unknown; error: unknown; response?: unknown; status: number }>

/** Where `items.get` with `input` under `config` landed: the result's status, data, error class and Response, or what it threw. */
async function landed(answer: (request: Request) => Response | Promise<Response>, input: object, config = {}) {
	const { TestSDK } = (await emittedSdk(DOC)) as unknown as {
		TestSDK: new (config: object) => { items: { get: Get } }
	}
	const sdk = new TestSDK({ baseURL: "https://api.test", fetch: recordingFetch(answer).fetch, ...config })
	return sdk.items.get({ params: { id: "i1" }, ...input }).then(
		(r) => [
			"result",
			r.status,
			r.data,
			(r.error as Error | null)?.constructor?.name ?? r.error,
			r.response instanceof Response,
		],
		(e: Error) => ["thrown", e.name],
	)
}

const never = (request: Request) =>
	new Promise<Response>((_, reject) =>
		request.signal.addEventListener("abort", () => reject(request.signal.reason as Error)),
	)

describe("safe mode over the TS SDK's error kinds (bit 19 f)", () => {
	it("holds an error status, an unbuilt path and an undecodable 2xx in the result; throws a timeout, an abort, a refused connection and a hook", async () => {
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
		expect({ abort, hooked, path, refused, status, timeout, torn }).toEqual({
			abort: ["thrown", "AbortError"],
			hooked: ["thrown", "RangeError"],
			path: ["result", 0, null, "ClientError", true],
			refused: ["thrown", "APIConnectionError"],
			status: ["result", 404, null, "Object", true],
			timeout: ["thrown", "TimeoutError"],
			torn: ["result", 200, null, "ClientError", true],
		})
	})
})
