/**
 * The TS SDK's declared Idempotency-Key (bit 19 d1, sweep item 11), pinned as Python's and C#'s are (contract 29 §1): a
 * declared `Idempotency-Key` header parameter's value is the one sent, over the `idempotencyKey` option and the
 * generated key, and an unset one sends the option's key, else a fresh UUIDv4. (TS types a header parameter as text, so
 * the empty-map rule has nothing to apply to.)
 */
import { describe, expect, it } from "vitest"
import { emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** An idempotent POST declaring its Idempotency-Key header: the SDK method `keyed.send`. */
const DOC = {
	info: { title: "Test", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/keyed": {
			post: {
				operationId: "keyed.send",
				parameters: [{ in: "header", name: "Idempotency-Key", schema: { type: "string" } }],
				responses: { 204: { description: "done" } },
				"x-idempotency-key": true,
			},
		},
	},
}

describe("a declared Idempotency-Key header param: its value over the generated key (bit 19 d1)", () => {
	it("sends the declared key over the option's, the option's when undeclared, and a UUIDv4 when neither is set", async () => {
		const recorded = recordingFetch(() => new Response(null, { status: 204 }))
		const { TestSDK } = (await emittedSdk(DOC)) as unknown as {
			TestSDK: new (config: object) => { keyed: { send: (input?: object) => Promise<unknown> } }
		}
		const sdk = new TestSDK({ baseURL: "https://api.test", fetch: recorded.fetch })
		await sdk.keyed.send({ headers: { "Idempotency-Key": "declared-k" }, idempotencyKey: "opt-k" })
		await sdk.keyed.send({ idempotencyKey: "opt-k" })
		await sdk.keyed.send()
		expect(recorded.calls.map((call) => call.headers.get("idempotency-key"))).toEqual([
			"declared-k",
			"opt-k",
			expect.stringMatching(V4),
		])
	})
})
