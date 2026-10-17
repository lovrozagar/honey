/**
 * The C# HTTP runtime's answers (contract 47 §5.6, Python's and Rust's `http.response.test.ts` analog): a JSON
 * answer decoded into the operation's type, and an undecodable 2xx (truncated, or nested past the parser's depth)
 * as the method's own `DecodeException` in both modes, never a safe-mode `SdkResult.Error`; a deep error body kept
 * as its status class with an empty envelope and a cut `Detail`; every member the wire sent kept; a text answer as
 * the body verbatim, asked for by its media type; a call ended by its one deadline (across an auth retry), the
 * caller's token or a refused connection, none of them an `ApiStatusException`; and the answer's cap. Fc1: the
 * handler the SDK builds asks for and decodes gzip, deflate and brotli, the cap counts decoded bytes, and a caller's
 * own handler governs its decompression. Driven against `http` and `http-safe` on C#'s one async client.
 */
import { gzipSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { CsError, Script, Trace } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served, type Json as WireJson } from "../shared/__fixtures__/recording-server.ts"
import { consume } from "./__fixtures__/consumer.ts"
import { withDotnet } from "./__fixtures__/csharp-env.ts"
import { type DrivenCSharpSdk, drivenCSharpSdk } from "./__fixtures__/driven.ts"

/** Whether .NET is here: a missing SDK fails where it is required and skips these legs elsewhere (csharp-env). */
const DOTNET = withDotnet()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

/** The call for `operation` at `path` with GET and `params`. */
const get = (operation: string, path: string, params?: Record<string, string>): Call => ({
	operation,
	params,
	route: { method: "GET", path },
})

const ECHO = get("echo.get", "/echo")
const USER = get("users.get", "/users/{id}", { id: "1" })
const LABELS = get("labels.get", "/labels")
const SHAPE = get("shapes.get", "/shape")
const SLOW_GET = get("slow.get", "/slow")
const TEXT = get("text.get", "/text")

/** A 200 JSON reply of `json`, and the data the driver observes for it. */
const found = (json: WireJson): Reply => ({ json, status: 200 })
const data = (json: unknown) => ({ data: json, kind: "data", status: 200 })
const OK: Reply = { json: { ok: true }, status: 200 }
const OK_DATA = data({ ok: true })
/** A reply whose body claims JSON and is `text`. */
const claimed = (text: string, status = 200): Reply => ({
	headers: { "content-type": "application/json" },
	status,
	text,
})

/** An answer that arrives a second late: every bound below ends the call well before it. */
const LATE: Reply = { delayMs: 1000, json: { ok: true }, status: 200 }

/** A C# error as the trace records it: no inner, not canceled, the method's own throw unless given, any display. */
const plain = (entry: Partial<CsError>) => ({
	canceled: false,
	display: expect.any(String),
	inner: null,
	via: "return",
	...entry,
})
/** The method's DecodeException for a 2xx whose body does not decode (§5.6 pins its class, not its text). */
const UNDECODED = expect.objectContaining({
	canceled: false,
	chain: ["DecodeException", "HoneyException"],
	type: "DecodeException",
	via: "return",
})
/** The ApiConnectionException the cap throws: no inner (§1 rules). */
const capped = (limit: number) =>
	plain({
		chain: ["ApiConnectionException", "HoneyException"],
		text: `the answer exceeds ${limit} bytes`,
		type: "ApiConnectionException",
	})
/** The deadline's ApiTimeoutException (phase b's text, kept); the canceled send is its inner. */
const timedOut = (ms: number) =>
	plain({
		chain: ["ApiTimeoutException", "HoneyException"],
		inner: expect.any(String),
		text: `GET /slow timed out after ${ms} ms`,
		type: "ApiTimeoutException",
	})

type Key = "http" | "http-safe"

/** The registry SDK `key` with the driver aimed at it: it must build. */
function driven(key: Key): DrivenCSharpSdk {
	const sdk = drivenCSharpSdk(key)
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

type Options = { readonly key?: Key; readonly script?: Script; readonly setup?: Setup }

/** `calls` run under `options` against a server answering `replies`: the run and the hops. */
async function drive(replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	const sdk = driven(options.key ?? "http")
	return served(replies, async (server) => {
		const cell = { calls, setup: options.setup ?? {} }
		const run = await sdk.runCalls(cell, { url: server.url }, { script: options.script })
		return { hops: [...server.hops], run }
	})
}
type Driven = Awaited<ReturnType<typeof drive>>

/** A traced call as these tests pin it: its error and its SdkResult, without the time. */
const traced = ({ error, result }: Trace<CsError>["calls"][number]) => ({ error, result })

/** A decoding run: each call traced, the urls hit, what was observed, the exit status. */
const decoding = ({ hops, run }: Driven) => ({
	calls: run.trace?.calls.map(traced),
	hops: hops.map((h) => h.url),
	observed: run.observed,
	status: run.status,
})

/** A run as the plain legs pin it: the urls hit, what was observed, the exit status. */
const wire = ({ hops, run }: Driven) => ({ hops: hops.map((h) => h.url), observed: run.observed, status: run.status })

/** The decoding run of a user and then a truncated body, the first call's SdkResult `first`. */
const truncated = (first: Trace<CsError>["calls"][number]["result"]) => ({
	calls: [
		{ error: undefined, result: first },
		{ error: UNDECODED, result: undefined },
	],
	hops: ["/users/1", "/users/1"],
	observed: [data({ id: "u1" }), null],
	status: 0,
})

/** JSON nested past any parser's depth. */
const DEEP = "[".repeat(100_000)

describe.skipIf(!DOTNET)(
	"a JSON answer decodes into the operation's type; an undecodable one is the method's error",
	SLOW,
	() => {
		/* ported: python http.response.test.ts:117 */
		it("the decoded user, then a truncated body as DecodeException in both modes", async () => {
			const replies = [found({ id: "u1" }), claimed('{"id":')]
			const run = (key: Key) => drive(replies, [USER, USER], { key, script: {} })
			const [thrown, safe] = await Promise.all([run("http"), run("http-safe")])
			expect({ safe: decoding(safe), thrown: decoding(thrown) }, thrown.run.stderr + safe.run.stderr).toEqual({
				safe: truncated({ data: true, ok: true, response: true, status: 200 }),
				thrown: truncated(undefined),
			})
		})

		/* ported: python http.response.test.ts:127 (and the error status's envelope, §1 rules: JsonDocument's depth 64) */
		it("a 2xx nested past the parser's depth is DecodeException; a 404 of it keeps its class, a cut Detail, an empty envelope", async () => {
			const script: Script = { calls: [null, { envelope: true }] }
			const run = await drive([claimed(DEEP), claimed(DEEP, 404)], [USER, USER], { script })
			const detail = `${"[".repeat(512)}…`
			expect(decoding(run), run.run.stderr).toEqual({
				calls: [
					{ error: UNDECODED, result: undefined },
					{
						error: plain({
							chain: ["NotFoundException", "ApiStatusException", "HoneyException"],
							envelope: { extraKeys: [] },
							key: null,
							keyMember: null,
							message: detail,
							status: 404,
							text: `HTTP 404: ${detail}`,
							type: "NotFoundException",
						}),
						result: undefined,
					},
				],
				hops: ["/users/1", "/users/1"],
				observed: [null, expect.objectContaining({ errorKey: null, kind: "error", status: 404 })],
				status: 0,
			})
		})
	},
)

/* ported: python http.response.test.ts:143 */
describe.skipIf(!DOTNET)("a decoded answer keeps every member the wire sent", SLOW, () => {
	it("the additional properties beside a declared field, each union variant's own", async () => {
		const labels = { color: "red", name: "x" }
		const circle = { kind: "circle", radius: 2.5 }
		const square = { kind: "square", side: 3 }
		const run = await drive([found(labels), found(circle), found(square)], [LABELS, SHAPE, SHAPE])
		expect(wire(run), run.run.stderr).toEqual({
			hops: ["/labels", "/shape", "/shape"],
			observed: [data(labels), data(circle), data(square)],
			status: 0,
		})
	})
})

/** A text run: the accept each hop sent, what was observed, the exit status. */
const answered = ({ hops, run }: Driven) => ({
	accept: hops.map((h) => h.headers.accept),
	observed: run.observed,
	status: run.status,
})

/* ported: python http.response.test.ts:160 (phase b sent no Accept on a text answer, a defect fixed here) */
describe.skipIf(!DOTNET)("a text answer is the body as a string, asked for by its media type", SLOW, () => {
	it("a text/plain body verbatim, never JSON-decoded, accept text/plain, both modes", async () => {
		const reply: Reply = { headers: { "content-type": "text/plain" }, status: 200, text: '{"a":1}' }
		const run = (key: Key) => drive([reply], [TEXT], { key })
		const [thrown, safe] = await Promise.all([run("http"), run("http-safe")])
		const expected = { accept: ["text/plain"], observed: [data('{"a":1}')], status: 0 }
		expect({ safe: answered(safe), thrown: answered(thrown) }, thrown.run.stderr + safe.run.stderr).toEqual({
			safe: expected,
			thrown: expected,
		})
	})
})

/** A timed run's one call: what it observed, its error, its time, and the hops. */
const timed = ({ hops, run }: Driven) => ({
	elapsed: run.trace?.calls[0]?.elapsedMs ?? -1,
	error: run.trace?.calls[0]?.error,
	hops: hops.length,
	observed: run.observed,
	status: run.status,
})

describe.skipIf(!DOTNET)(
	"a call ends when its time is up or it is canceled, never as an ApiStatusException",
	SLOW,
	() => {
		/* ported: python http.response.test.ts:173, rust http.response.test.ts:138 (the ClientConfig bound) */
		it("ClientConfig.Timeout bounds a call: a timeout observed well before the reply", async () => {
			const setup: Setup = { timeoutMs: 300 }
			const [bare, scripted] = await Promise.all([
				drive([LATE], [SLOW_GET], { setup }),
				drive([LATE], [SLOW_GET], { script: {}, setup }),
			])
			const { elapsed, ...call } = timed(scripted)
			expect(
				{ bare: wire(bare), bounded: elapsed >= 250 && elapsed < 900, scripted: call },
				`${bare.run.stderr}${scripted.run.stderr} elapsed ${elapsed}`,
			).toEqual({
				bare: { hops: ["/slow"], observed: [{ kind: "timeout" }], status: 0 },
				bounded: true,
				scripted: { error: timedOut(300), hops: 1, observed: [{ kind: "timeout" }], status: 0 },
			})
		})

		/* §1 rules: one deadline per call, over its attempts, hops, body reads and hooks */
		it("one deadline spans the auth retry: two 400 ms answers under 600 ms time out on the second", async () => {
			const script: Script = { onAuthExpired: { tokens: ["new"] } }
			const setup: Setup = { auth: { kind: "bearer", token: "old" }, timeoutMs: 600 }
			const replies: Reply[] = [
				{ delayMs: 400, status: 401 },
				{ ...LATE, delayMs: 400 },
			]
			const run = await drive(replies, [SLOW_GET], { script, setup })
			const { elapsed, ...call } = timed(run)
			expect(
				{ ...call, bounded: elapsed >= 550 && elapsed < 800, expired: run.run.trace?.authExpired },
				`${run.run.stderr} elapsed ${elapsed}`,
			).toEqual({
				bounded: true,
				error: timedOut(600),
				expired: 1,
				hops: 2,
				observed: [{ kind: "timeout" }],
				status: 0,
			})
		})

		/* ported: python http.response.test.ts:208 (the caller's token: the OCE as thrown, never wrapped) */
		it("a call canceled in flight on its token ends at once, its one request sent", async () => {
			const script: Script = { calls: [{ cancel: { afterMs: 300 } }] }
			const run = await drive([LATE], [SLOW_GET], { script })
			const { elapsed, ...call } = timed(run)
			expect({ ...call, fast: elapsed < 900 }, `${run.run.stderr} elapsed ${elapsed}`).toEqual({
				error: expect.objectContaining({ canceled: true, via: "return" }),
				fast: true,
				hops: 1,
				observed: [null],
				status: 0,
			})
		})
	},
)

/* ported: python http.response.test.ts:233 */
describe.skipIf(!DOTNET)("a refused connection is a transport error, never a cancel", SLOW, () => {
	it("ApiConnectionException with HttpRequestException inner, and no status", async () => {
		const closed = await served([], async (server) => server.url)
		const run = await driven("http").runCalls({ calls: [USER], setup: {} }, { url: closed }, { script: {} })
		expect({ error: run.trace?.calls[0]?.error, observed: run.observed, status: run.status }, run.stderr).toEqual({
			error: plain({
				chain: ["ApiConnectionException", "HoneyException"],
				inner: "HttpRequestException",
				text: expect.any(String),
				type: "ApiConnectionException",
			}),
			observed: [null],
			status: 0,
		})
	})
})

/** A 64-byte JSON answer echo.get decodes: `{"ok":true}` and trailing spaces. */
const SIXTY_FOUR: Reply = claimed(`{"ok":true}${" ".repeat(53)}`)

/** One echo.get of SIXTY_FOUR under `maxResponseBytes`. */
const cap = (maxResponseBytes: number) => drive([SIXTY_FOUR], [ECHO], { script: { config: { maxResponseBytes } } })
/** A capped run: each call traced, what was observed. */
const capRead = ({ run }: Driven) => ({ calls: run.trace?.calls.map(traced), observed: run.observed })

/* ported: python sdk.driver.script.test.ts:173 (and the 0 case: no cap) */
describe.skipIf(!DOTNET)("ClientConfig.MaxResponseBytes caps an answer; 0 is none", SLOW, () => {
	it("10 on 64 bytes is ApiConnectionException, observed null; 0 decodes the 64 bytes", async () => {
		const [ten, none] = await Promise.all([cap(10), cap(0)])
		expect({ none: capRead(none), ten: capRead(ten) }, ten.run.stderr + none.run.stderr).toEqual({
			none: { calls: [{ error: undefined, result: undefined }], observed: [OK_DATA] },
			ten: { calls: [{ error: capped(10), result: undefined }], observed: [null] },
		})
	})
})

/** A gzipped JSON body of 2,010 decoded bytes whose wire form is far under 512. */
const PADDED = { pad: "a".repeat(2000) }

describe.skipIf(!DOTNET)("decompression (Fc1): the SDK's handler decodes, the cap counts decoded bytes", SLOW, () => {
	/* Fc1, Q-c4 */
	it("asks for gzip, deflate and br; a gzipped answer decodes; a small gzip of a large body exceeds the cap", async () => {
		const wireSize = gzipSync(JSON.stringify(PADDED)).byteLength
		const replies: Reply[] = [OK, { ...found({ id: "u1" }), gzip: true }, { ...found(PADDED), gzip: true }]
		const run = await drive(replies, [ECHO, USER, ECHO], { script: { config: { maxResponseBytes: 512 } } })
		expect(
			{
				accept: run.hops.map((h) => h.headers["accept-encoding"]),
				capped: run.run.trace?.calls[2]?.error,
				observed: run.run.observed,
				small: wireSize < 512 && JSON.stringify(PADDED).length > 512,
			},
			run.run.stderr,
		).toEqual({
			accept: ["gzip, deflate, br", "gzip, deflate, br", "gzip, deflate, br"],
			capped: capped(512),
			observed: [OK_DATA, data({ id: "u1" }), null],
			small: true,
		})
	})
})

/** A client on the SDK's own handler, then one on a caller's `SocketsHttpHandler` (decompression off). */
const GOVERNS = `using (var own = Client())
{
    await own.Echo.GetAsync();
}
using (var caller = Client(new ClientConfig { Handler = new System.Net.Http.SocketsHttpHandler() }))
{
    await caller.Echo.GetAsync();
}
Note("ok");`

describe.skipIf(!DOTNET)("decompression (Fc1): a caller's handler governs its own", SLOW, () => {
	/* Fc1: the SDK never touches a caller primary's AutomaticDecompression */
	it("the SDK's handler sends accept-encoding; a caller's SocketsHttpHandler, left as it is, sends none", async () => {
		const { accept, run } = await served([OK, OK], async (server) => ({
			run: await consume("http", "response-governs", { base: server.url, body: GOVERNS }),
			accept: server.hops.map((h) => h.headers["accept-encoding"]),
		}))
		expect({ accept, out: run.out?.main, ran: run.ran }, run.stderr).toEqual({
			accept: ["gzip, deflate, br", undefined],
			out: ["ok"],
			ran: true,
		})
	})
})
