/**
 * The HTTP runtime's answers (contract 19 §5.4, the Go `http.response.test.ts` analog): a JSON answer decoded
 * into the operation's type, and an undecodable 2xx as the method's own `Error::Decode` on the client and
 * `Answer::Err(SafeError::Decode)` with its response on `client.safe()` (bit 21 i4, R-i1: it is an answer); every
 * member the wire sent kept; a text answer as the body verbatim; and a call ended by its timeout, a refused
 * connection or a cancel, none of them `Api`. Driven against `http` (documents-http.ts), in both styles.
 */
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { RustError, Script, Trace } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served, type Json as WireJson, REFUSED_URL } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenRustSdk, drivenRustSdk } from "./__fixtures__/driven.ts"
import { withRust } from "./__fixtures__/rust-env.ts"

/** Whether Rust is here: a missing toolchain fails where it is required and skips these legs elsewhere (rust-env). */
const RUST = withRust()

/** The call for `operation` at `path` with GET and `params`. */
const get = (operation: string, path: string, params?: Record<string, string>): Call => ({
	operation,
	params,
	route: { method: "GET", path },
})

const USER = get("users.get", "/users/{id}", { id: "1" })
const LABELS = get("labels.get", "/labels")
const SHAPE = get("shapes.get", "/shape")
const SLOW = get("slow.get", "/slow")
const TEXT = get("text.get", "/text")

/** A 200 JSON reply of `json`, and the data the driver observes for it. */
const found = (json: WireJson): Reply => ({ json, status: 200 })
const data = (json: unknown) => ({ data: json, kind: "data", status: 200 })

/** An answer that arrives two seconds late: every bound below ends the call well before it. */
const LATE: Reply = { delayMs: 2000, json: { ok: true }, status: 200 }

/** The `http` SDK compiled with the driver, which must build. */
function driven(): DrivenRustSdk {
	const sdk = drivenRustSdk("http")
	expect(sdk.built, sdk.stderr).toBe(true)
	return sdk
}

type Options = { readonly safe?: boolean; readonly script?: Script; readonly setup?: Setup }

/** `calls` run by `sdk` under `options` (on `client.safe()` when `safe`) against a server answering `replies`. */
async function drive(sdk: DrivenRustSdk, replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup: options.setup ?? {} }, server, options.script, options.safe)
		return { hops: [...server.hops], run }
	})
}
type Driven = Awaited<ReturnType<typeof drive>>

/** A traced call as these tests pin it: its error's variant, text, origin and status, and its safe Answer. */
const traced = ({ error, result }: Trace<RustError>["calls"][number]) => ({
	error: error && { status: error.status, text: error.text, variant: error.variant, via: error.via },
	result,
})

/** An undecodable 2xx as traced: Decode, via `return` on the client or `result` on client.safe() with its Answer. */
const undecoded = (via: string, result: unknown) => ({
	error: { status: undefined, text: expect.stringMatching(/^decode: /), variant: "Decode", via },
	result,
})

/** A safe call's Answer summary for a 200, `Ok` or `Err`. */
const answer = (ok: boolean) => ({ data: ok, ok, response: true, status: 200 })

/** A decoding run as a809e6f134 pins it: each call traced, the urls hit, what was observed, the exit status. */
const decoding = ({ hops, run }: Driven) => ({
	calls: run.trace?.calls.map(traced),
	hops: hops.map((h) => h.url),
	observed: run.observed,
	status: run.status,
})

/** A run as the plain legs pin it: the urls hit, what was observed, the exit status. */
const wire = ({ hops, run }: Driven) => ({ hops: hops.map((h) => h.url), observed: run.observed, status: run.status })

/** A text run as 2953bc0ffc pins it: the accept each hop sent, what was observed, the exit status and stderr. */
const answered = ({ hops, run }: Driven) => ({
	accept: hops.map((h) => h.headers.accept),
	observed: run.observed,
	status: run.status,
	stderr: run.stderr.trim(),
})

describe.skipIf(!RUST)(
	"a JSON answer decodes into the operation's type; an undecodable one is the method's error",
	() => {
		// v0: a809e6f134
		it("returns the decoded user, and a truncated JSON body as Error::Decode, on client.safe() an Answer::Err(Decode)", async () => {
			const truncated: Reply = { headers: { "content-type": "application/json" }, status: 200, text: '{"id":' }
			const replies = [found({ id: "u1" }), truncated]
			const run = (safe: boolean) => drive(driven(), replies, [USER, USER], { safe, script: {} })
			const [thrown, safe] = await Promise.all([run(false), run(true)])
			/* F5: v0 decoded a 2xx with serde_json::from_slice into its Json variant; v1 returns an undecodable 2xx
			 * as the method's Err(Error::Decode), and (R-i1) client.safe() as the answer it is, with its response */
			const expected = (first: unknown, second: ReturnType<typeof undecoded>) => ({
				calls: [{ error: undefined, result: first }, second],
				hops: ["/users/1", "/users/1"],
				observed: [data({ id: "u1" }), { kind: "decode", status: 200 }],
				status: 0,
			})
			expect({ safe: decoding(safe), thrown: decoding(thrown) }, thrown.run.stderr + safe.run.stderr).toEqual({
				safe: expected(answer(true), undecoded("result", answer(false))),
				thrown: expected(undefined, undecoded("return", undefined)),
			})
		}, 600_000)
	},
)

describe.skipIf(!RUST)("a decoded answer keeps every member the wire sent", () => {
	it("keeps the additional properties beside a declared field, and each union variant's own fields", async () => {
		const labels = { color: "red", name: "x" }
		const circle = { kind: "circle", radius: 2.5 }
		const square = { kind: "square", side: 3 }
		const replies = [found(labels), found(circle), found(square)]
		const run = await drive(driven(), replies, [LABELS, SHAPE, SHAPE])
		expect(wire(run), run.run.stderr).toEqual({
			hops: ["/labels", "/shape", "/shape"],
			observed: [data(labels), data(circle), data(square)],
			status: 0,
		})
	}, 600_000)
})

describe.skipIf(!RUST)("a text answer is the body as a String, asked for by its media type", () => {
	// v0: 2953bc0ffc
	it("returns a text/plain body verbatim, never JSON-decoded, and sends accept: text/plain, in both styles", async () => {
		const reply: Reply = { headers: { "content-type": "text/plain" }, status: 200, text: '{"a":1}' }
		const run = (safe: boolean) => drive(driven(), [reply], [TEXT], { safe })
		const [thrown, safe] = await Promise.all([run(false), run(true)])
		const expected = { accept: ["text/plain"], observed: [data('{"a":1}')], status: 0, stderr: "" }
		expect({ safe: answered(safe), thrown: answered(thrown) }).toEqual({ safe: expected, thrown: expected })
	}, 600_000)
})

describe.skipIf(!RUST)("a call ends when its time is up or it is canceled, never as Api", () => {
	// v0: 2b87c0fe0a
	it("bounds a call by ClientConfig.timeout: a timeout observed, Error::Timeout well before the reply", async () => {
		const sdk = driven()
		const setup: Setup = { timeoutMs: 300 }
		const [plain, scripted] = await Promise.all([
			drive(sdk, [LATE], [SLOW], { setup }),
			drive(sdk, [LATE], [SLOW], { script: {}, setup }),
		])
		const call = scripted.run.trace?.calls[0]
		expect(
			{
				bounded: (call?.elapsedMs ?? 0) >= 250 && (call?.elapsedMs ?? 1500) < 1500,
				error: call && traced(call).error,
				hops: [plain.hops.length, scripted.hops.length],
				observed: [plain.run.observed, scripted.run.observed],
				status: [plain.run.status, scripted.run.status],
			},
			plain.run.stderr + scripted.run.stderr,
		).toEqual({
			bounded: true,
			error: { status: undefined, text: "the call timed out", variant: "Timeout", via: "return" },
			hops: [1, 1],
			observed: [[{ kind: "timeout" }], [{ kind: "timeout" }]],
			status: [0, 0],
		})
	}, 600_000)

	it("ends a call canceled in flight as Error::Canceled, well before the reply, its one request sent", async () => {
		const script: Script = { calls: [{ cancel: { afterMs: 300 } }] }
		const { hops, run } = await drive(driven(), [LATE], [SLOW], { script })
		const call = run.trace?.calls[0]
		expect(
			{
				error: call && traced(call).error,
				hops: hops.map((h) => h.url),
				observed: run.observed,
				quick: (call?.elapsedMs ?? 1500) < 1500,
				status: run.status,
			},
			run.stderr,
		).toEqual({
			error: { status: undefined, text: "the call was canceled", variant: "Canceled", via: "return" },
			hops: ["/slow"],
			observed: [null],
			quick: true,
			status: 0,
		})
	}, 600_000)
})

describe.skipIf(!RUST)("a refused connection is a transport error, never Canceled", () => {
	// v0: 91cbb6da4b
	it("fails a refused connection as Error::Transport with its source, no status and no Canceled in its Debug", async () => {
		const closed = REFUSED_URL
		const run = await driven().runCalls({ calls: [USER], setup: {} }, { url: closed }, {})
		const error = run.trace?.calls[0]?.error
		expect(
			{
				canceled: error === undefined ? undefined : /Canceled/.test(error.debug),
				error: error && { source: error.source, status: error.status, variant: error.variant, via: error.via },
				observed: run.observed,
				status: run.status,
				text: error?.text.startsWith("transport: "),
			},
			run.stderr,
		).toEqual({
			canceled: false,
			error: { source: true, status: undefined, variant: "Transport", via: "return" },
			observed: [{ kind: "transport" }],
			status: 0,
			text: true,
		})
	}, 600_000)
})
