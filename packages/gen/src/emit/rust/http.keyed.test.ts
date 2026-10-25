/**
 * The Rust SDK's header rules (bit 19 d1, sweep item 11), pinned as Python's and C#'s are (contract 29 §1): a declared
 * `Idempotency-Key` parameter's value is the one sent, over the SDK's own key and the generated one, and an empty map as
 * a header parameter's value sends no header (a non-empty one its JSON text). The key through the driver; the map
 * through a consumer program, since a driven call's headers are strings; both on the `keyed` fixture, the shared extra paths.
 */
import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import type { Script } from "../shared/__fixtures__/protocol.ts"
import { served } from "../shared/__fixtures__/recording-server.ts"
import { consume } from "./__fixtures__/consumer.ts"
import { drivenRustSdk } from "./__fixtures__/driven.ts"
import { withRust } from "./__fixtures__/rust-env.ts"

const RUST = withRust()
const KEYED: Call = { operation: "keyed.send", route: { method: "POST", path: "/keyed" } }
const OK = { json: { ok: true }, status: 200 }
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe.skipIf(!RUST)("a declared Idempotency-Key header param: its value over the generated key (bit 19 d1)", () => {
	it("sends the declared key, over the SDK's own key too, and a UUIDv4 when it is unset", async () => {
		const sdk = drivenRustSdk("keyed")
		expect(sdk.built, sdk.stderr).toBe(true)
		const declared: Call = { ...KEYED, headers: { "Idempotency-Key": "declared-k" } }
		const script: Script = { calls: [null, { idempotencyKey: "opt-k" }, null] }
		const { hops, run } = await served([OK, OK, OK], async (server) => {
			const sent = await sdk.runCalls({ calls: [declared, declared, KEYED], setup: {} }, server, script)
			return { hops: [...server.hops], run: sent }
		})
		expect({ keys: hops.map((h) => h.headers["idempotency-key"]), observed: run.observed?.length }, run.stderr).toEqual(
			{
				keys: ["declared-k", "declared-k", expect.stringMatching(V4)],
				observed: 3,
			},
		)
	}, 600_000)
})

const MAP_BODY = `let c = client(&base).expect("client");
    let empty = sdk::KeyedSendOpts { x_meta: Some(std::collections::HashMap::new()), ..Default::default() };
    n.note(c.keyed().send(&empty).await.is_ok().to_string());
    let full = std::collections::HashMap::from([("a".to_owned(), "1".to_owned())]);
    let full = sdk::KeyedSendOpts { x_meta: Some(full), ..Default::default() };
    n.note(c.keyed().send(&full).await.is_ok().to_string());`

describe.skipIf(!RUST)("a map header param: an empty map sends no header (bit 19 d1)", () => {
	it("sends no x-meta for {}, and a non-empty map as its JSON text", async () => {
		const { hops, run } = await served([OK, OK], async (server) => {
			const out = await consume("keyed", "keyed-map", { base: server.url, body: MAP_BODY })
			return { hops: [...server.hops], run: out }
		})
		expect({ meta: hops.map((h) => h.headers["x-meta"]), out: run.out?.main }, run.stderr).toEqual({
			meta: [undefined, '{"a":"1"}'],
			out: ["true", "true"],
		})
	}, 600_000)
})
