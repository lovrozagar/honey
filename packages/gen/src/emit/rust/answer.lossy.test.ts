/**
 * The Rust SDK decodes a text answer as UTF-8 whatever its charset, each invalid sequence U+FFFD (bit 19 d2, sweep item
 * 8), as every other SDK does; before, an invalid byte made the call an `Error::Decode`. The answer is bytes 0x00 to
 * 0xFF, so every invalid lead and continuation byte is in it; the expectation is WHATWG's lossy decode, which
 * substitutes maximal invalid subparts as Rust's `from_utf8_lossy` does.
 */
import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import { served } from "../shared/__fixtures__/recording-server.ts"
import { drivenRustSdk } from "./__fixtures__/driven.ts"
import { withRust } from "./__fixtures__/rust-env.ts"

const RUST = withRust()
const TEXT: Call = { operation: "text.get", route: { method: "GET", path: "/text" } }
const BYTES = Buffer.from(Array.from({ length: 256 }, (_, i) => i))

describe.skipIf(!RUST)("a text answer's invalid UTF-8, in the Rust SDK (bit 19 d2)", () => {
	it("reads each invalid sequence as U+FFFD, never a decode error", async () => {
		const sdk = drivenRustSdk("http")
		expect(sdk.built, sdk.stderr).toBe(true)
		const run = await served([{ bytes: 256, headers: { "content-type": "text/plain" }, status: 200 }], (server) =>
			sdk.runCalls({ calls: [TEXT], setup: {} }, server),
		)
		const decoded = new TextDecoder().decode(BYTES)
		expect([decoded.includes("�"), run.observed], run.stderr).toEqual([
			true,
			[{ data: decoded, kind: "data", status: 200 }],
		])
	}, 600_000)
})
