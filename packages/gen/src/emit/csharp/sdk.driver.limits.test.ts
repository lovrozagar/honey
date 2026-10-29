/**
 * The C# SDK's refusal of a header it cannot send (bit 19 b1), through the test driver: any control character but tab
 * in a value, or a name outside the token grammar, is a ConfigException before anything goes out, naming the header
 * and never quoting its value. A bad name was dropped silently before (TryAddWithoutValidation), and `\u0001` and DEL
 * went out raw. Its response cap counts decoded bytes for every encoding its handler asks for: gzip, deflate and br;
 * a 2xx past it is the call's DecodeException (bit 21 i5: the status and headers arrived, so it is an answer).
 */
import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import type { CsError } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { withDotnet } from "./__fixtures__/csharp-env.ts"
import { drivenCSharpSdk } from "./__fixtures__/driven.ts"

const DOTNET = withDotnet()
const SLOW = { timeout: 600_000 }
const SECRET = "s3cr3t"
const MiB = 1 << 20
const ECHO: Call = { operation: "echo.get", route: { method: "GET", path: "/echo" } }

/** A C# error as the trace records it: no inner, not canceled, the method's own throw unless given, any display. */
const plain = (entry: Partial<CsError>) => ({
	canceled: false,
	display: expect.any(String),
	inner: null,
	via: "return",
	...entry,
})
const config = (text: string) => plain({ chain: ["ConfigException", "HoneyException"], text, type: "ConfigException" })

describe.skipIf(!DOTNET)(
	"a header the C# SDK cannot send: ConfigException by name, its value never quoted, nothing sent (bit 19 b1)",
	SLOW,
	() => {
		it("refuses \\u0001 and DEL in a value and a header named 'bad name'", async () => {
			const sdk = drivenCSharpSdk("http")
			expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
			const calls: Call[] = [
				{ ...ECHO, headers: { "X-Bad": `${SECRET}\u0001x` } },
				{ ...ECHO, headers: { "X-Bad": `${SECRET}\u007fx` } },
				{ ...ECHO, headers: { "bad name": SECRET } },
			]
			const { hops, run } = await served([], async (server) => {
				const sent = await sdk.runCalls({ calls, setup: {} }, { alt: server.alt, url: server.url }, { script: {} })
				return { hops: [...server.hops], run: sent }
			})
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

describe.skipIf(!DOTNET)(
	"a WebSocket dial's header the C# SDK cannot send: refused the same way, nothing dialed (bit 19 b1)",
	SLOW,
	() => {
		it("refuses \\u0001 in a dial's per-call header as ConfigException naming it, never its value", async () => {
			const sdk = drivenCSharpSdk("ws")
			expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
			const room: Call = {
				headers: { "X-Bad": `${SECRET}\u0001x` },
				operation: "rooms.socket",
				params: { room: "r" },
				route: { method: "GET", path: "/rooms/{room}" },
				take: 0,
			}
			const { hops, run } = await served([], async (server) => {
				const sent = await sdk.runCalls({ calls: [room], setup: {} }, { url: server.url }, { script: {} })
				return { hops: [...server.hops], run: sent }
			})
			const error = run.trace?.calls[0]?.error
			expect(
				{ error, hops: hops.length, leaks: JSON.stringify(run.trace ?? null).includes(SECRET) },
				run.stderr,
			).toEqual({
				error: expect.objectContaining({
					chain: ["ConfigException", "HoneyException"],
					text: "the X-Bad header's value cannot be sent",
				}),
				hops: 0,
				leaks: false,
			})
		})
	},
)

/** A streamed 64 MiB body coded as `coding`, whose coded size is a small fraction of it: a bomb past a 1 MiB cap. */
const bomb = (coding: "br" | "deflate" | "gzip"): Reply => ({
	bytes: 64 * MiB,
	...({ br: { brotli: true }, deflate: { deflate: true }, gzip: { gzip: true } } as const)[coding],
	headers: { "content-type": "application/json" },
	status: 200,
})

describe.skipIf(!DOTNET)(
	"the C# SDK's response cap counts decoded bytes, for every encoding it asks for (bit 19 b1)",
	SLOW,
	() => {
		it.each(["gzip", "deflate", "br"] as const)(
			"refuses a %s bomb past a 1 MiB cap, having asked for exactly gzip, deflate and br",
			async (coding) => {
				const sdk = drivenCSharpSdk("http")
				expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
				const { hops, run } = await served([bomb(coding)], async (server) => {
					const script = { config: { maxResponseBytes: MiB } }
					const sent = await sdk.runCalls(
						{ calls: [ECHO], setup: {} },
						{ alt: server.alt, url: server.url },
						{ script },
					)
					return { hops: [...server.hops], run: sent }
				})
				expect(
					{ encoding: hops[0]?.headers["accept-encoding"], error: run.trace?.calls[0]?.error, observed: run.observed },
					run.stderr,
				).toEqual({
					encoding: "gzip, deflate, br",
					error: plain({
						chain: ["DecodeException", "SdkException", "HoneyException"],
						text: `the answer exceeds ${MiB} bytes`,
						type: "DecodeException",
					}),
					observed: [null],
				})
			},
		)
	},
)
