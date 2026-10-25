/**
 * The Rust SDK's API error text (bit 19 d2, sweep item 6): `HTTP <status>: <message>`, or `HTTP <status>` without a
 * message, as the Python, C#, Java and TS SDKs read; no reason phrase, which no target can spell alike.
 */
import { describe, expect, it } from "vitest"
import { served } from "../shared/__fixtures__/recording-server.ts"
import { consume, seen } from "./__fixtures__/consumer.ts"
import { withRust } from "./__fixtures__/rust-env.ts"

const RUST = withRust()

describe.skipIf(!RUST)("the Rust SDK's API error text (bit 19 d2)", () => {
	it("reads HTTP <status>: <message>, HTTP <status> without one, and no reason phrase for any status", async () => {
		const replies = [
			{ json: { message: "x" }, status: 404 },
			{ status: 404, text: "" },
			{ json: { message: "m" }, status: 418 },
		]
		const run = await served(replies, (server) =>
			consume("errors", "text", {
				base: server.url,
				body: `let c = client(&base).expect("client");
    let o = sdk::ItemsGetOpts::default();
    for id in ["a", "b", "c"] {
        match c.items().get(id, &o).await {
            Err(e) => n.note(format!("{e}")),
            Ok(_) => n.note("ok"),
        }
    }`,
			}),
		)
		expect(seen(run), run.stderr).toEqual({ built: true, out: ["HTTP 404: x", "HTTP 404", "HTTP 418: m"] })
	}, 600_000)
})
