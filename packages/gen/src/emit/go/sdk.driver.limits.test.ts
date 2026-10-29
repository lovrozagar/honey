/**
 * The Go SDK's limits on what it reads and sends (bit 19 b1), through the test driver: a gzip bomb is refused on its
 * decoded bytes (net/http decodes, the MaxResponseBytes cap counts what it decodes to; a *DecodeError since bit 21
 * i3), and a header the SDK cannot
 * send, a control character in its value or a name outside the token grammar, is refused before anything goes out,
 * the error naming the header and never quoting its value.
 */
import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import type { GoError, Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { compiledSdk, type DrivenSdk } from "./__fixtures__/compiled.ts"
import { withGo } from "./__fixtures__/go-env.ts"

const GO = withGo()
const MiB = 1 << 20
const SECRET = "s3cr3t"

/** One JSON GET: what the limit legs call. */
const DOCUMENT = {
	info: { title: "Limits", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/echo": {
			get: {
				operationId: "echo.get",
				responses: { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } },
			},
		},
	},
}
const ECHO: Call = { operation: "echo.get", route: { method: "GET", path: "/echo" } }

/** The SDK compiled with the driver, which must build and vet clean. */
function limitsSdk(): DrivenSdk {
	const sdk = compiledSdk(DOCUMENT, { modulePath: "example.com/limits" })
	expect({ built: sdk.built, vet: sdk.vet }, sdk.stderr).toEqual({ built: true, vet: [] })
	return sdk
}

/** `calls` run by `sdk` under `script` against a server answering `replies`: the run and the hops. */
async function drive(sdk: DrivenSdk, replies: readonly Reply[], calls: readonly Call[], script: Script) {
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup: {} }, server, script)
		return { hops: [...server.hops], run }
	})
}

/** net/http's refusal of a header, as the SDK wraps it: the request's URL, then the header, never its value. */
const refusal = (what: string) =>
	expect.stringMatching(
		new RegExp(`^honey: http do: Get "http://127\\.0\\.0\\.1:\\d+/echo": net/http: invalid header field ${what}$`),
	)

/** A Go error of no honey type, as the trace records it. */
const plain = (entry: Partial<GoError>) => ({
	canceled: false,
	deadline: false,
	tooLarge: false,
	via: "return",
	...entry,
})

/** A streamed 64 MiB body coded as `coding`, whose coded size is a small fraction of it: a bomb past a 1 MiB cap. */
const bomb = (coding: "br" | "deflate" | "gzip" | "zstd"): Reply => ({
	bytes: 64 * MiB,
	...({ br: { brotli: true }, deflate: { deflate: true }, gzip: { gzip: true }, zstd: { zstd: true } } as const)[
		coding
	],
	headers: { "content-type": "application/json" },
	status: 200,
})

describe.skipIf(!GO)(
	"the Go SDK's response cap counts decoded bytes, for the one encoding net/http asks for (bit 19 b1)",
	() => {
		it("refuses a gzip bomb past a 1 MiB cap, having asked for exactly gzip", async () => {
			const { hops, run } = await drive(limitsSdk(), [bomb("gzip")], [ECHO], { config: { maxResponseBytes: MiB } })
			expect(
				{ encoding: hops[0]?.headers["accept-encoding"], error: run.trace?.calls[0]?.error, observed: run.observed },
				run.stderr,
			).toEqual({
				encoding: "gzip",
				/* bit 21 i3: the status and headers arrived, so the 2xx past the cap is a *DecodeError, an answer */
				error: plain({
					chain: ["*sdk.DecodeError", "*errors.errorString"],
					text: "honey: decode response: honey: response body exceeds MaxResponseBytes",
					tooLarge: true,
					type: "*sdk.DecodeError",
				}),
				observed: [{ kind: "decode", status: 200 }],
			})
		}, 600_000)
	},
)

describe.skipIf(!GO)(
	"a header the Go SDK cannot send: refused by name, its value never quoted, nothing sent (bit 19 b1)",
	() => {
		it("refuses \\u0001 and DEL in a value and a header named 'bad name'", async () => {
			const calls: Call[] = [
				{ ...ECHO, headers: { "X-Bad": `${SECRET}\u0001x` } },
				{ ...ECHO, headers: { "X-Bad": `${SECRET}\u007fx` } },
				{ ...ECHO, headers: { "bad name": SECRET } },
			]
			const { hops, run } = await drive(limitsSdk(), [], calls, {})
			const errors = run.trace?.calls.map((call) => call?.error?.text)
			expect(
				{
					errors,
					hops: hops.length,
					leaks: JSON.stringify(run.trace ?? null).includes(SECRET),
					observed: run.observed,
				},
				run.stderr,
			).toEqual({
				errors: [refusal('value for "X-Bad"'), refusal('value for "X-Bad"'), refusal('name "bad name"')],
				hops: 0,
				leaks: false,
				observed: [null, null, null],
			})
		}, 600_000)
	},
)
