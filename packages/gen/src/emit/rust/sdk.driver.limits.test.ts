/**
 * The Rust SDK's limits on what it reads and sends (bit 19 b1), through the test driver: it asks for gzip and deflate
 * and decodes them, so a gzip bomb is refused on its decoded bytes by `max_response_bytes`, and a header the SDK cannot
 * send, a control character in its value or a name outside the token grammar, is `Error::Config` before anything goes
 * out, naming the header and never quoting its value.
 */
import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import type { RustError, Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenRustSdk, drivenRustSdk } from "./__fixtures__/driven.ts"
import { withRust } from "./__fixtures__/rust-env.ts"

const RUST = withRust()
const MiB = 1 << 20
const SECRET = "s3cr3t"
const ECHO: Call = { operation: "echo.get", route: { method: "GET", path: "/echo" } }

/** The registry `http` SDK compiled with the driver, which must build. */
function driven(): DrivenRustSdk {
	const sdk = drivenRustSdk("http")
	expect(sdk.built, sdk.stderr).toBe(true)
	return sdk
}

/** `calls` run by `sdk` under `script` against a server answering `replies`: the run and the hops. */
async function drive(sdk: DrivenRustSdk, replies: readonly Reply[], calls: readonly Call[], script: Script) {
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup: {} }, server, script)
		return { hops: [...server.hops], run }
	})
}

/** A Rust error as the trace records it: no source and the method's own Err unless given, any Debug text. */
const plain = (entry: Partial<RustError>) => ({ debug: expect.any(String), source: false, via: "return", ...entry })

/** A streamed 64 MiB body coded as `coding`, whose coded size is a small fraction of it: a bomb past a 1 MiB cap. */
const bomb = (coding: "br" | "deflate" | "gzip" | "zstd"): Reply => ({
	bytes: 64 * MiB,
	...({ br: { brotli: true }, deflate: { deflate: true }, gzip: { gzip: true }, zstd: { zstd: true } } as const)[
		coding
	],
	headers: { "content-type": "application/json" },
	status: 200,
})

describe.skipIf(!RUST)(
	"the Rust SDK's response cap counts decoded bytes, for every encoding it asks for (bit 19 b1)",
	() => {
		it.each(["gzip", "deflate"] as const)(
			"refuses a %s bomb past a 1 MiB cap, having asked for exactly gzip and deflate",
			async (coding) => {
				const { hops, run } = await drive(driven(), [bomb(coding)], [ECHO], { config: { maxResponseBytes: MiB } })
				expect(
					{ encoding: hops[0]?.headers["accept-encoding"], error: run.trace?.calls[0]?.error, observed: run.observed },
					run.stderr,
				).toEqual({
					encoding: "gzip,deflate",
					error: plain({ source: true, text: `transport: the answer exceeds ${MiB} bytes`, variant: "Transport" }),
					observed: [null],
				})
			},
			600_000,
		)
	},
)

describe.skipIf(!RUST)(
	"a header the Rust SDK cannot send: Error::Config by name, its value never quoted, nothing sent (bit 19 b1)",
	() => {
		it("refuses \\u0001 and DEL in a value and a header named 'bad name'", async () => {
			const calls: Call[] = [
				{ ...ECHO, headers: { "X-Bad": `${SECRET}\u0001x` } },
				{ ...ECHO, headers: { "X-Bad": `${SECRET}\u007fx` } },
				{ ...ECHO, headers: { "bad name": SECRET } },
			]
			const { hops, run } = await drive(driven(), [], calls, {})
			const errors = run.trace?.calls.map((call) => call?.error)
			expect(
				{
					errors,
					hops: hops.length,
					leaks: JSON.stringify(run.trace ?? null).includes(SECRET),
					observed: run.observed,
				},
				run.stderr,
			).toEqual({
				errors: [
					plain({ text: "config: the x-bad header's value is not valid in a header", variant: "Config" }),
					plain({ text: "config: the x-bad header's value is not valid in a header", variant: "Config" }),
					plain({ text: 'config: "bad name" is not a valid header name', variant: "Config" }),
				],
				hops: 0,
				leaks: false,
				observed: [null, null, null],
			})
		}, 600_000)
	},
)

describe.skipIf(!RUST)(
	"a WebSocket dial's header the Rust SDK cannot send: refused the same way, nothing dialed (bit 19 b1)",
	() => {
		it("refuses \\u0001 in a dial's per-call header as Error::Config naming it, never its value", async () => {
			const sdk = drivenRustSdk("ws")
			expect(sdk.built, sdk.stderr).toBe(true)
			const room: Call = {
				headers: { "X-Bad": `${SECRET}\u0001x` },
				operation: "rooms.socket",
				params: { room: "r" },
				route: { method: "GET", path: "/rooms/{room}" },
				take: 0,
			}
			const { hops, run } = await drive(sdk, [], [room], {})
			const error = run.trace?.calls[0]?.error
			expect(
				{ error, hops: hops.length, leaks: JSON.stringify(run.trace ?? null).includes(SECRET) },
				run.stderr,
			).toEqual({
				error: expect.objectContaining({
					text: "config: the x-bad header's value is not valid in a header",
					variant: "Config",
				}),
				hops: 0,
				leaks: false,
			})
		}, 600_000)
	},
)
