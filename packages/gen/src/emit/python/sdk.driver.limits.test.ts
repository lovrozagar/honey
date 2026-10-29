/**
 * The Python SDK's limits on what it reads and sends (bit 19 b1), through the test driver on both clients: httpx2
 * asks for gzip and decodes it, so a gzip bomb is refused on its decoded bytes by `max_response_bytes`, and a header
 * the SDK cannot send, any control character but tab in its value or a name outside the token grammar, is a
 * ConfigError before anything goes out, naming the header and never quoting its value.
 */
import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import type { PythonError, Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { drivenPythonSdk } from "./__fixtures__/driven.ts"
import { withPython } from "./__fixtures__/python-env.ts"

const PY = withPython()
const SLOW = { timeout: 600_000 }
const CLIENTS = ["async", "sync"] as const
const MiB = 1 << 20
const SECRET = "s3cr3t"
const ECHO: Call = { operation: "echo.get", route: { method: "GET", path: "/echo" } }

/** `calls` run on `client` under `script` against a server answering `replies`: the run and the hops. */
async function drive(
	client: (typeof CLIENTS)[number],
	replies: readonly Reply[],
	calls: readonly Call[],
	script: Script,
) {
	const sdk = drivenPythonSdk("http")
	expect(sdk.imported, sdk.stderr).toBe(true)
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup: {} }, { alt: server.alt, url: server.url }, { client, script })
		return { hops: [...server.hops], run }
	})
}

/** A Python error as the trace records it: no cause and the method's own raise unless given, any repr. */
const plain = (entry: Partial<PythonError>) => ({ cause: null, repr: expect.any(String), via: "return", ...entry })
const config = (text: string) => plain({ chain: ["ConfigError", "HoneyError"], text, type: "ConfigError" })

/** A streamed 64 MiB body coded as `coding`, whose coded size is a small fraction of it: a bomb past a 1 MiB cap. */
const bomb = (coding: "br" | "deflate" | "gzip" | "zstd"): Reply => ({
	bytes: 64 * MiB,
	...({ br: { brotli: true }, deflate: { deflate: true }, gzip: { gzip: true }, zstd: { zstd: true } } as const)[
		coding
	],
	headers: { "content-type": "application/json" },
	status: 200,
})

describe.skipIf(!PY)(
	"the Python SDK's response cap counts decoded bytes, for every encoding httpx2 asks for (bit 19 b1)",
	SLOW,
	() => {
		const cases = CLIENTS.flatMap((client) =>
			(["gzip", "deflate", "zstd"] as const).map((coding) => [client, coding] as const),
		)
		it.each(cases)(
			"%s: refuses a %s bomb past a 1 MiB cap, having asked for exactly gzip, deflate and zstd",
			async (client, coding) => {
				const { hops, run } = await drive(client, [bomb(coding)], [ECHO], { config: { maxResponseBytes: MiB } })
				expect(
					{ encoding: hops[0]?.headers["accept-encoding"], error: run.trace?.calls[0]?.error, observed: run.observed },
					run.stderr,
				).toEqual({
					encoding: "gzip, deflate, zstd",
					error: plain({
						chain: ["APIConnectionError", "HoneyError"],
						text: `the answer exceeds ${MiB} bytes`,
						type: "APIConnectionError",
					}),
					observed: [{ kind: "transport" }],
				})
			},
		)
	},
)

describe.skipIf(!PY)(
	"a header the Python SDK cannot send: ConfigError by name, its value never quoted, nothing sent (bit 19 b1)",
	SLOW,
	() => {
		it.each(CLIENTS)("%s: refuses \\u0001 and DEL in a value and a header named 'bad name'", async (client) => {
			const calls: Call[] = [
				{ ...ECHO, headers: { "X-Bad": `${SECRET}\u0001x` } },
				{ ...ECHO, headers: { "X-Bad": `${SECRET}\u007fx` } },
				{ ...ECHO, headers: { "bad name": SECRET } },
			]
			const { hops, run } = await drive(client, [], calls, {})
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
					config("the X-Bad header's value cannot be sent"),
					config("the X-Bad header's value cannot be sent"),
					config("the bad name header cannot be sent"),
				],
				hops: 0,
				leaks: false,
				observed: [null, null, null],
			})
		})
	},
)

/* the sync client has no WebSocket method: a dial is async alone */
describe.skipIf(!PY)(
	"a WebSocket dial's header the Python SDK cannot send: refused the same way, nothing dialed (bit 19 b1)",
	SLOW,
	() => {
		it.each(["async"] as const)(
			"%s: refuses \\u0001 in a dial's per-call header as ConfigError naming it, never its value",
			async (client) => {
				const sdk = drivenPythonSdk("ws")
				expect(sdk.imported, sdk.stderr).toBe(true)
				const room: Call = {
					headers: { "X-Bad": `${SECRET}\u0001x` },
					operation: "rooms.socket",
					params: { room: "r" },
					route: { method: "GET", path: "/rooms/{room}" },
					take: 0,
				}
				const { hops, run } = await served([], async (server) => {
					const sent = await sdk.runCalls(
						{ calls: [room], setup: {} },
						{ alt: server.alt, url: server.url },
						{ client, script: {} },
					)
					return { hops: [...server.hops], run: sent }
				})
				const error = run.trace?.calls[0]?.error
				expect(
					{ error, hops: hops.length, leaks: JSON.stringify(run.trace ?? null).includes(SECRET) },
					run.stderr,
				).toEqual({
					error: expect.objectContaining({
						chain: ["ConfigError", "HoneyError"],
						text: "the X-Bad header's value cannot be sent",
					}),
					hops: 0,
					leaks: false,
				})
			},
		)
	},
)
