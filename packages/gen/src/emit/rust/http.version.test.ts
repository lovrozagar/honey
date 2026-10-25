/**
 * The Rust SDK speaks HTTP/1.1 (bit 19 d2, sweep item 10): against a server offering h2 and http/1.1 by ALPN, its
 * request arrives over http/1.1, as every SDK's does. reqwest built with its `http2` feature negotiated h2 (probe:
 * ~/.cache/honey-tmp/b19/probes/http-version.txt); the crate is built without it, so no client, a caller's
 * `http_builder` included, can offer h2.
 */
import { describe, expect, it } from "vitest"
import { alpnServer, trusted } from "../shared/__fixtures__/alpn-server.ts"
import { consume } from "./__fixtures__/consumer.ts"
import { withRust } from "./__fixtures__/rust-env.ts"

const RUST = withRust()

/** The default client's call, then one through a caller's `http_builder`. */
const BODY = `match client(&base) {
        Ok(c) => if let Err(e) = c.echo().get(&sdk::EchoGetOpts::default()).await { n.note(format!("error {e}")) },
        Err(e) => n.note(format!("client {e}")),
    }
    let built = sdk::Client::new(sdk::ClientConfig {
        base_url: base.clone(),
        http_builder: Some(reqwest::Client::builder()),
        ..Default::default()
    });
    match built {
        Ok(c) => if let Err(e) = c.echo().get(&sdk::EchoGetOpts::default()).await { n.note(format!("error {e}")) },
        Err(e) => n.note(format!("client {e}")),
    }`

describe.skipIf(!RUST)("the Rust SDK speaks HTTP/1.1 to a server that offers h2 (bit 19 d2)", () => {
	it("sends over http/1.1 by default and through a caller's http_builder", async () => {
		const server = await alpnServer()
		try {
			const run = await trusted(() => consume("http", "version", { base: server.url, body: BODY }))
			expect({ built: run.built, out: run.out, seen: server.seen() }, run.stderr).toEqual({
				built: true,
				out: {},
				seen: [
					{ alpn: "http/1.1", version: "1.1" },
					{ alpn: "http/1.1", version: "1.1" },
				],
			})
		} finally {
			await server.close()
		}
	}, 600_000)
})
