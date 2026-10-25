/**
 * The Go SDK speaks HTTP/1.1 (bit 19 d2, sweep item 10): against a server offering h2 and http/1.1 by ALPN, its
 * request arrives over http/1.1, as every SDK's does, so the conformance grid's cleartext server is the wire every
 * target ships. net/http's DefaultTransport would negotiate h2 (probe: ~/.cache/honey-tmp/b19/probes/http-version.txt);
 * the SDK sends through an HTTP/1.1-only copy of it, also for a caller's HTTPClient that names no Transport. A caller's
 * own Transport is the caller's.
 */
import { describe, expect, it } from "vitest"
import { alpnServer, trusted } from "../shared/__fixtures__/alpn-server.ts"
import { consume } from "./__fixtures__/consumer.ts"
import { withGo } from "./__fixtures__/go-env.ts"
import { generateGoSdk } from "./sdk.ts"

const GO = withGo()
const MODULE = "example.com/version"

/** One JSON GET. */
const DOCUMENT = {
	info: { title: "Version", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/ping": {
			get: {
				operationId: "ping.get",
				responses: { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } },
			},
		},
	},
}

/** The default client's call, then one through a caller HTTPClient naming no Transport. */
const BODY = `	for _, c := range []*sdk.Client{
		sdk.NewClient(sdk.Config{BaseURL: input.Base}),
		sdk.NewClient(sdk.Config{BaseURL: input.Base, HTTPClient: &http.Client{}}),
	} {
		if _, err := c.Ping.Get(ctx, nil); err != nil {
			note("error " + err.Error())
		}
	}`

describe.skipIf(!GO)("the Go SDK speaks HTTP/1.1 to a server that offers h2 (bit 19 d2)", () => {
	it("sends over http/1.1 by default, and through a caller HTTPClient that names no Transport", async () => {
		const { files } = generateGoSdk(DOCUMENT, { modulePath: MODULE })
		const server = await alpnServer()
		try {
			const run = await trusted(() => consume(files, MODULE, { base: server.url, body: BODY, imports: ["net/http"] }))
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
