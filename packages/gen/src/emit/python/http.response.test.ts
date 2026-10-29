/**
 * The HTTP runtime's answers (contract 29 §5.5, Rust's `http.response.test.ts` analog): a JSON answer decoded
 * into the operation's type, and an undecodable 2xx (truncated, or nested past the parser's depth) as the
 * method's own `DecodeError`, which `client.safe` answers as an `Err` (bit 21 i2, R-i1: it is an answer); every member
 * the wire sent kept; a text answer as the body verbatim; and a call ended by its timeout, a cancel or a refused
 * connection, none of them an `APIStatusError`. Driven against `http` and its `safe` mirror (documents-http.ts), every leg on
 * `AsyncSDK` and `SDK` with one expectation (G17) but the cancel's bound, client-specific by design (G22).
 */
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { PythonError, Script, Trace } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served, type Json as WireJson, REFUSED_URL } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenPythonSdk, drivenPythonSdk } from "./__fixtures__/driven.ts"
import { withPython } from "./__fixtures__/python-env.ts"

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()
/** Every executed describe's bound: a cold gate builds the venv and the package first. */
const SLOW = { timeout: 600_000 }
const CLIENTS = ["async", "sync"] as const
type Client = (typeof CLIENTS)[number]

/** The call for `operation` at `path` with GET and `params`. */
const get = (operation: string, path: string, params?: Record<string, string>): Call => ({
	operation,
	params,
	route: { method: "GET", path },
})

const USER = get("users.get", "/users/{id}", { id: "1" })
const LABELS = get("labels.get", "/labels")
const SHAPE = get("shapes.get", "/shape")
const SLOW_GET = get("slow.get", "/slow")
const TEXT = get("text.get", "/text")

/** A 200 JSON reply of `json`, and the data the driver observes for it. */
const found = (json: WireJson): Reply => ({ json, status: 200 })
const data = (json: unknown) => ({ data: json, kind: "data", status: 200 })
/** A 200 whose body claims JSON and is `text`. */
const claimed = (text: string): Reply => ({ headers: { "content-type": "application/json" }, status: 200, text })

/** An answer that arrives two seconds late: every bound below ends the call well before it. */
const LATE: Reply = { delayMs: 2000, json: { ok: true }, status: 200 }

/** A Python error as the trace records it: no cause and the method's own raise unless given, any repr. */
const plain = (entry: Partial<PythonError>) => ({ cause: null, repr: expect.any(String), via: "return", ...entry })
/** The method's DecodeError for a 2xx whose body is no JSON. */
const UNDECODED = plain({
	chain: ["DecodeError", "HoneyError"],
	text: "HTTP 200: the body is not JSON",
	type: "DecodeError",
})

/** The registry SDK `http` with the driver aimed at it: it must import. */
function driven(): DrivenPythonSdk {
	const sdk = drivenPythonSdk("http")
	expect(sdk.imported, sdk.stderr).toBe(true)
	return sdk
}

/** `safe`: through the client's `safe` mirror (bit 21 i2) */
type Options = { readonly safe?: boolean; readonly script?: Script; readonly setup?: Setup }

/** `calls` run on `client` under `options` against a server answering `replies`: the run and the hops. */
async function drive(client: Client, replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	const sdk = driven()
	return served(replies, async (server) => {
		const cell = { calls, setup: options.setup ?? {} }
		const run = await sdk.runCalls(cell, { url: server.url }, { client, safe: options.safe, script: options.script })
		return { hops: [...server.hops], run }
	})
}
type Driven = Awaited<ReturnType<typeof drive>>

/** A traced call as these tests pin it: its error and its Result, without the time. */
const traced = ({ error, result }: Trace<PythonError>["calls"][number]) => ({ error, result })

/** A decoding run: each call traced, the urls hit, what was observed, the exit status. */
const decoding = ({ hops, run }: Driven) => ({
	calls: run.trace?.calls.map(traced),
	hops: hops.map((h) => h.url),
	observed: run.observed,
	status: run.status,
})

/** A run as the plain legs pin it: the urls hit, what was observed, the exit status. */
const wire = ({ hops, run }: Driven) => ({ hops: hops.map((h) => h.url), observed: run.observed, status: run.status })

/** A text run: the accept each hop sent, what was observed, the exit status and stderr. */
const answered = ({ hops, run }: Driven) => ({
	accept: hops.map((h) => h.headers.accept),
	observed: run.observed,
	status: run.status,
	stderr: run.stderr.trim(),
})

/** The decoding run of a user and then a truncated body: the normal call's raise, or the safe call's Ok then Err. */
const truncated = (safe: boolean) => ({
	calls: safe
		? [
				{ error: undefined, result: { data: true, ok: true, response: true, status: 200 } },
				{ error: { ...UNDECODED, via: "result" }, result: { data: false, ok: false, response: true, status: 200 } },
			]
		: [
				{ error: undefined, result: undefined },
				{ error: UNDECODED, result: undefined },
			],
	hops: ["/users/1", "/users/1"],
	observed: [data({ id: "u1" }), { kind: "decode", status: 200 }],
	status: 0,
})

describe.skipIf(!PY)(
	"a JSON answer decodes into the operation's type; an undecodable one is the method's error",
	SLOW,
	() => {
		/* V0BUG: v0's _parse_body returned None for an undecodable JSON 2xx (_runtime.py:469-471, survey V0BUG 6),
		 * and v0 drove AsyncSDK alone; v1 raises DecodeError from the method on both clients, and the safe call
		 * answers it as an Err with its response (bit 21 i2, R-i1; bit 19 F5 had it raised in safe mode too) */
		// v0: 2ebe2ae717
		it.each(CLIENTS)(
			"%s: the decoded user, then a truncated body: DecodeError raised, or the safe Err",
			async (client) => {
				const replies = [found({ id: "u1" }), claimed('{"id":')]
				const run = (safe: boolean) => drive(client, replies, [USER, USER], { safe, script: {} })
				const [thrown, safe] = await Promise.all([run(false), run(true)])
				expect({ safe: decoding(safe), thrown: decoding(thrown) }, thrown.run.stderr + safe.run.stderr).toEqual({
					safe: truncated(true),
					thrown: truncated(false),
				})
			},
		)

		it.each(CLIENTS)(
			"%s: a 2xx nested past the parser's depth is DecodeError, never RecursionError",
			async (client) => {
				const run = await drive(client, [claimed("[".repeat(100_000))], [USER], { script: {} })
				expect(decoding(run), run.run.stderr).toEqual({
					calls: [{ error: UNDECODED, result: undefined }],
					hops: ["/users/1"],
					observed: [{ kind: "decode", status: 200 }],
					status: 0,
				})
			},
		)
	},
)

describe.skipIf(!PY)("a decoded answer keeps every member the wire sent", SLOW, () => {
	it.each(CLIENTS)(
		"%s: the additional properties beside a declared field, each union variant's own",
		async (client) => {
			const labels = { color: "red", name: "x" }
			const circle = { kind: "circle", radius: 2.5 }
			const square = { kind: "square", side: 3 }
			const run = await drive(client, [found(labels), found(circle), found(square)], [LABELS, SHAPE, SHAPE])
			expect(wire(run), run.run.stderr).toEqual({
				hops: ["/labels", "/shape", "/shape"],
				observed: [data(labels), data(circle), data(square)],
				status: 0,
			})
		},
	)
})

describe.skipIf(!PY)("a text answer is the body as a str, asked for by its media type", SLOW, () => {
	it.each(CLIENTS)(
		"%s: a text/plain body verbatim, never JSON-decoded, accept text/plain, both styles",
		async (client) => {
			const reply: Reply = { headers: { "content-type": "text/plain" }, status: 200, text: '{"a":1}' }
			const run = (safe: boolean) => drive(client, [reply], [TEXT], { safe })
			const [thrown, safe] = await Promise.all([run(false), run(true)])
			const expected = { accept: ["text/plain"], observed: [data('{"a":1}')], status: 0, stderr: "" }
			expect({ safe: answered(safe), thrown: answered(thrown) }).toEqual({ safe: expected, thrown: expected })
		},
	)
})

describe.skipIf(!PY)("a call ends when its time is up or it is canceled, never as an APIStatusError", SLOW, () => {
	it.each(CLIENTS)(
		"%s: ClientConfig.timeout bounds a call: a timeout observed well before the reply",
		async (client) => {
			const setup: Setup = { timeoutMs: 300 }
			const [bare, scripted] = await Promise.all([
				drive(client, [LATE], [SLOW_GET], { setup }),
				drive(client, [LATE], [SLOW_GET], { script: {}, setup }),
			])
			const call = scripted.run.trace?.calls[0]
			const elapsed = call?.elapsedMs ?? -1
			expect(
				{
					bounded: elapsed >= 250 && elapsed < 1500,
					error: call?.error,
					hops: [bare.hops.length, scripted.hops.length],
					observed: [bare.run.observed, scripted.run.observed],
					status: [bare.run.status, scripted.run.status],
				},
				`${bare.run.stderr}${scripted.run.stderr} elapsed ${elapsed}`,
			).toEqual({
				bounded: true,
				error: plain({
					/* the httpx2 timeout the bound ended the read with */
					cause: expect.any(String),
					chain: ["APITimeoutError", "APIConnectionError", "HoneyError"],
					text: "the call ran past its timeout",
					type: "APITimeoutError",
				}),
				hops: [1, 1],
				observed: [[{ kind: "timeout" }], [{ kind: "timeout" }]],
				status: [0, 0],
			})
		},
	)

	it.each(CLIENTS)("%s: a call canceled in flight is CanceledError, its one request sent", async (client) => {
		/* the cancel lands after the send: an AsyncSDK's first connect is in its window */
		const script: Script = { calls: [{ cancel: { afterMs: 1000 } }] }
		const { hops, run } = await drive(client, [{ ...LATE, delayMs: 3000 }], [SLOW_GET], { script })
		const elapsed = run.trace?.calls[0]?.elapsedMs ?? -1
		expect(
			{
				error: run.trace?.calls[0]?.error,
				hops: hops.map((h) => h.url),
				observed: run.observed,
				status: run.status,
				/* client-specific by design (G22): AsyncSDK races the cancel, a blocking read is not interrupted */
				timed: client === "async" ? elapsed < 2500 : elapsed >= 2900,
			},
			`${run.stderr} elapsed ${elapsed}`,
		).toEqual({
			error: plain({ chain: ["CanceledError", "HoneyError"], text: "the call was canceled", type: "CanceledError" }),
			hops: ["/slow"],
			observed: [null],
			status: 0,
			timed: true,
		})
	})
})

describe.skipIf(!PY)("a refused connection is a transport error, never CanceledError", SLOW, () => {
	it.each(CLIENTS)("%s: APIConnectionError caused by httpx2's ConnectError, with no status", async (client) => {
		const closed = REFUSED_URL
		const run = await driven().runCalls({ calls: [USER], setup: {} }, { url: closed }, { client, script: {} })
		expect({ error: run.trace?.calls[0]?.error, observed: run.observed, status: run.status }, run.stderr).toEqual({
			error: plain({
				cause: "ConnectError",
				chain: ["APIConnectionError", "HoneyError"],
				text: expect.stringMatching(/^the request failed: ConnectError/),
				type: "APIConnectionError",
			}),
			observed: [{ kind: "transport" }],
			status: 0,
		})
	})
})
