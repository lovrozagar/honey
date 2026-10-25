/**
 * The Go SDK's header-rule parity (bit 19 d1, sweep item 11, N2): an empty map as a header or query parameter's value
 * sends nothing, as Python, C#, Java and Rust send, and a non-empty one its JSON text (Go sent `{}`); a declared
 * Idempotency-Key parameter's value is the one sent, over the SDK's generated key, and an unset one sends a fresh UUIDv4.
 */
import { describe, expect, it } from "vitest"
import { served } from "../shared/__fixtures__/recording-server.ts"
import { consume } from "./__fixtures__/consumer.ts"
import { withGo } from "./__fixtures__/go-env.ts"
import { generateGoSdk } from "./sdk.ts"

const GO = withGo()
const MODULE = "example.com/keyed"
const MAP = { additionalProperties: { type: "string" }, type: "object" }
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** One idempotent POST taking a declared key, a map header and a map query parameter. */
const DOCUMENT = {
	info: { title: "Keyed", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/keyed": {
			post: {
				operationId: "keyed.send",
				parameters: [
					{ in: "header", name: "Idempotency-Key", schema: { type: "string" } },
					{ in: "header", name: "X-Meta", schema: MAP },
					{ in: "query", name: "filter", schema: MAP },
				],
				responses: { 204: { description: "done" } },
				"x-idempotency-key": true,
			},
		},
	},
}

/** Empty maps and no key; non-empty maps and a declared key. */
const BODY = `	c := sdk.NewClient(sdk.Config{BaseURL: input.Base})
	empty := map[string]string{}
	full := map[string]string{"a": "1"}
	note(c.Keyed.Send(ctx, &sdk.KeyedSendOpts{Filter: empty, XMeta: empty}) == nil)
	note(c.Keyed.Send(ctx, &sdk.KeyedSendOpts{Filter: full, IdempotencyKey: "declared-k", XMeta: full}) == nil)`

describe.skipIf(!GO)("the Go SDK's header rules: an empty map sends nothing, a declared key wins (bit 19 d1)", () => {
	it("sends no x-meta or filter for {}, a non-empty map's JSON text, the declared key over a fresh UUIDv4", async () => {
		const { files } = generateGoSdk(DOCUMENT, { modulePath: MODULE })
		const { hops, run } = await served([{ status: 204 }, { status: 204 }], async (server) => {
			const out = await consume(files, MODULE, { base: server.url, body: BODY })
			return { hops: [...server.hops], run: out }
		})
		expect(
			{
				keys: hops.map((hop) => hop.headers["idempotency-key"]),
				meta: hops.map((hop) => hop.headers["x-meta"]),
				out: run.out,
				urls: hops.map((hop) => hop.url),
			},
			run.stderr,
		).toEqual({
			keys: [expect.stringMatching(UUID_V4), "declared-k"],
			meta: [undefined, '{"a":"1"}'],
			out: { main: ["true", "true"] },
			urls: ["/keyed", `/keyed?filter=${encodeURIComponent('{"a":"1"}')}`],
		})
	}, 600_000)
})
