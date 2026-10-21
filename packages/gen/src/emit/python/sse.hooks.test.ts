/**
 * An SSE open runs through phase c's exchange (contract 34 §6.3; Rust's `sse.hooks.test.ts` analog): its typed
 * `<Op>Headers` are filled at the open, and the `on_request` and `on_response` hooks, the 401 refresh and `on_log`
 * run on it as on a plain call. A hook's body replaces an error status's; a raising hook ends the open as
 * `HookError` with the stream unread and its connection let go; the refreshed token is the client's current one,
 * which a later open sends; and every log entry names only the operation template, never a header value, query,
 * path value or token. Driven on `AsyncSDK` (streams are its alone, G2) against the `sse` registry document
 * (shared/__fixtures__/documents-streams.ts). The standalone adapter's dial hooks are `realtime.test.ts`'s.
 */
import { describe, expect, it } from "vitest"
import type { Call, Observed, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { HookTrace, LogTrace, PythonError, Script } from "../shared/__fixtures__/protocol.ts"
import { gone } from "../shared/__fixtures__/gone.ts"
import { type Reply, served, REFUSED_URL } from "../shared/__fixtures__/recording-server.ts"
import { consume, seen } from "./__fixtures__/consumer.ts"
import { type DrivenPythonSdk, drivenPythonSdk } from "./__fixtures__/driven.ts"
import { withPython } from "./__fixtures__/python-env.ts"

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()
/** Every executed describe's bound: a cold gate builds the venv and the package first. */
const SLOW = { timeout: 600_000 }

const route = (method: string, path: string) => ({ method, path })
const ticks = (extra: Partial<Call> = {}): Call => ({
	operation: "ticks.stream",
	route: route("GET", "/ticks"),
	...extra,
})
const pending = (id: string): Call => ({
	operation: "pending.stream",
	params: { id },
	route: route("GET", "/pending/{id}"),
})

const sse = (steps: readonly (string | { waitMs: number })[], end: "close" | "drop" | "hold" = "close"): Reply => ({
	sse: { end, steps },
	status: 200,
})
const TICK = sse(['data: {"n":1}\n\n'])
/* a held typed stream: only the client leaving ends it */
const HELD = sse(['id: 7\ndata: {"n":1}\n\n', { waitMs: 50 }, 'data: {"n":2}\n\n'], "hold")
const NOPE: Reply = { json: { message: "nope" }, status: 404 }
const TICKED: Observed = { events: [{ data: { n: 1 } }], kind: "events" }

/** The `sse` SDK with the driver aimed at it: it must import. */
function sseSdk(): DrivenPythonSdk {
	const sdk = drivenPythonSdk("sse")
	expect(sdk.imported, sdk.stderr).toBe(true)
	return sdk
}

/** `calls` on `AsyncSDK` under `script` against a server answering `replies`: the run (which must exit 0), hops, streams and origin. */
async function drive(replies: readonly Reply[], calls: readonly Call[], script: Script, setup: Setup = {}) {
	const sdk = sseSdk()
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup }, { url: server.url }, { client: "async", script })
		expect(run.status, run.stderr).toBe(0)
		return { hops: [...server.hops], run, streams: [...server.streams], url: server.url }
	})
}

/** The hook runs as `<call> <phase> <index>`, a retry flag and status when they have them, joined by `|`. */
const steps = (hooks: readonly HookTrace[] | undefined) =>
	hooks
		?.map((h) => [h.call, h.phase, h.index, h.isRetry ? "retry" : "", h.status ?? ""].filter((p) => p !== "").join(" "))
		.join(" | ")

/** A Python error as the trace records it: no cause and the method's own raise unless given, any repr. */
const plain = (entry: Partial<PythonError>) => ({ cause: null, repr: expect.any(String), via: "return", ...entry })

/** An on_log entry as the trace records it, named by the operation template. */
const logged = (operation: string, event: string, level: string, extra: Partial<LogTrace> = {}) => ({
	event,
	level,
	operation,
	...extra,
})
const TICKS = "GET /ticks"
const PENDING = "GET /pending/{id}"
const start = (operation: string) => logged(operation, "request_start", "debug")
const answered = (operation: string, level: string, status: number) =>
	logged(operation, "response_received", level, { status })

describe.skipIf(!PY)("an SSE open's typed response headers and request hooks", SLOW, () => {
	it("runs the request hooks on the open, their header sent, and fills the typed headers at the open", async () => {
		const reply: Reply = { ...TICK, headers: { "x-stream-id": "s-1" } }
		const script: Script = { hooks: { request: [{ setHeader: ["x-hook", "1"] }] } }
		const { hops, run, url } = await drive([reply], [ticks()], script)
		expect(
			{
				hook: hops.map((hop) => hop.headers["x-hook"]),
				observed: run.observed,
				ran: run.trace?.hooks.filter((hook) => hook.phase === "request"),
			},
			run.stderr,
		).toEqual({
			hook: ["1"],
			observed: [TICKED],
			ran: [
				{
					call: 0,
					index: 0,
					invalidatedBy: [],
					isRetry: false,
					isStale: false,
					method: "GET",
					path: "/ticks",
					phase: "request",
					selector: "",
					url: `${url}/ticks`,
				},
			],
		})
		/* contract 34 §3.4 #1: HEAD never fills an SSE call's headers_into */
		expect(run.trace?.calls[0]?.stream).toEqual({ headers: { "x-stream-id": "s-1" }, retry: [null], yields: 1 })
	})
})

/**
 * A raising `on_response` hook on a held stream's open, then the program's next request, on a client without the
 * hook: the release point (gone.ts), its answer held until the first stream's client left.
 */
const HOOK_FAILS = `async def bad(ctx):
    raise ValueError("bad")


async with aclient(on_response=[bad]) as c:
    try:
        await c.ticks.stream()
        note("opened")
    except sdk.HookError as error:
        note(f"{type(error).__name__}: {error}")
    async with aclient() as plain, await plain.ticks.stream() as s:
        note((await anext(s)).data["n"])`

describe.skipIf(!PY)("an SSE open through a plain call's pipeline: the on_response hooks", SLOW, () => {
	it("runs them in order on the open, and an error status's last body set is the one observed", async () => {
		/* a 2xx stream's body is never buffered: its events come from the stream, whatever a hook set */
		const script: Script = { hooks: { response: [{}, { body: '{"message":"hooked"}' }] } }
		const { run } = await drive([TICK, NOPE], [ticks(), ticks()], script)
		expect({ observed: run.observed, order: steps(run.trace?.hooks) }, run.stderr).toEqual({
			observed: [TICKED, { body: { message: "hooked" }, errorKey: null, kind: "error", status: 404 }],
			order: "0 request 0 | 0 response 0 200 | 0 response 1 200 | 1 request 0 | 1 response 0 404 | 1 response 1 404",
		})
	})

	it("ends the open as HookError when one raises: no stream, no later hook, the connection gone unread", async () => {
		const { run, streams } = await drive([HELD], [ticks()], { hooks: { response: [{ fail: "bad" }, {}] } })
		expect(
			{
				error: run.trace?.calls[0]?.error,
				gone: streams[0]?.clientGone,
				observed: run.observed,
				order: steps(run.trace?.hooks),
			},
			run.stderr,
		).toEqual({
			error: plain({ cause: "ValueError", chain: ["HookError", "HoneyError"], text: "hook: bad", type: "HookError" }),
			gone: true,
			observed: [null],
			order: "0 request 0 | 0 response 0 200",
		})
	})

	it("lets the connection go at the raise, while the program runs on, not at its exit", async () => {
		/* contract 34 §3.4 #9: HEAD leaves the 2xx response open when an on_response hook raises (the pool keeps it) */
		const next = gone(TICK)
		const run = await served([HELD, next.reply], (server) =>
			consume("sse", "hook_fails", { base: server.url, body: HOOK_FAILS }),
		)
		expect({ ...seen(run), released: next.released() }, run.stderr).toEqual({
			out: ["HookError: hook: bad", "1"],
			ran: true,
			released: true,
		})
	})
})

describe.skipIf(!PY)("an SSE open's 401: one refresh, its token the client's current one", SLOW, () => {
	// v0: ff9fbb8384
	it("refreshes once and streams on the retry, every hook again with isRetry, on_log one exchange", async () => {
		/* V0BUG: v0's _open_stream ran on_request only (_runtime.py:813-815, survey 8): no on_response, no log, no refresh */
		const script: Script = { hooks: { response: [{}] }, log: true, onAuthExpired: { tokens: ["new"] } }
		const replies: Reply[] = [{ json: { message: "expired" }, status: 401 }, TICK]
		const { hops, run } = await drive(replies, [ticks()], script, { auth: { kind: "bearer", token: "old" } })
		expect(
			{
				auth: hops.map((hop) => hop.headers.authorization),
				error: run.trace?.calls[0]?.error,
				expired: run.trace?.authExpired,
				log: run.trace?.log,
				observed: run.observed,
				order: steps(run.trace?.hooks),
			},
			run.stderr,
		).toEqual({
			auth: ["Bearer old", "Bearer new"],
			error: undefined,
			expired: 1,
			log: [start(TICKS), answered(TICKS, "info", 200)],
			observed: [TICKED],
			order: "0 request 0 | 0 response 0 401 | 0 request 0 retry | 0 response 0 retry 200",
		})
	})

	it("sends the refreshed token on the next open, never the one the client was built with", async () => {
		const script: Script = { onAuthExpired: { tokens: ["new"] } }
		const replies: Reply[] = [{ json: { message: "expired" }, status: 401 }, TICK, TICK]
		const { hops, run } = await drive(replies, [ticks(), ticks()], script, { auth: { kind: "bearer", token: "old" } })
		expect(
			{
				auth: hops.map((hop) => hop.headers.authorization),
				expired: run.trace?.authExpired,
				observed: run.observed,
			},
			run.stderr,
		).toEqual({ auth: ["Bearer old", "Bearer new", "Bearer new"], expired: 1, observed: [TICKED, TICKED] })
	})
})

/* values no log entry may carry: a header value, a query value, a path value and the token */
const SECRETS = ["t-secret", "987654321", "p-secret", "tok-secret"]
/** The secrets `logs` carry, as JSON: [] when they are clean (G19 redaction). */
const leaked = (...logs: (readonly LogTrace[] | undefined)[]) =>
	SECRETS.filter((value) => JSON.stringify(logs).includes(value))

describe.skipIf(!PY)(
	"an SSE open through a plain call's pipeline: on_log, by the operation template only",
	SLOW,
	() => {
		it("logs request_start, then response_received at info for a 2xx, warn plus an error entry for an error status", async () => {
			const calls = [
				ticks({ headers: { "x-tenant": "t-secret" }, search: { since: 987654321 } }),
				ticks(),
				pending("p-secret"),
			]
			const setup: Setup = { auth: { kind: "bearer", token: "tok-secret" } }
			const { hops, run } = await drive([TICK, NOPE, sse(["data: x\n\n"])], calls, { log: true }, setup)
			expect({ log: run.trace?.log, observed: run.observed }, run.stderr).toEqual({
				log: [
					start(TICKS),
					answered(TICKS, "info", 200),
					start(TICKS),
					answered(TICKS, "warn", 404),
					logged(TICKS, "error", "error", { error: "NotFoundError: HTTP 404: nope", status: 404 }),
					start(PENDING),
					answered(PENDING, "info", 200),
				],
				observed: [
					TICKED,
					{ body: { message: "nope" }, errorKey: null, kind: "error", status: 404 },
					{ events: [{ data: "x" }], kind: "events" },
				],
			})
			/* the secrets did reach the wire: the log is what leaves them out */
			expect(hops.map((hop) => [hop.url, hop.headers["x-tenant"], hop.headers.authorization])[0]).toEqual([
				"/ticks?since=987654321",
				"t-secret",
				"Bearer tok-secret",
			])
			expect(leaked(run.trace?.log)).toEqual([])
		})

		it("logs request_start then an error entry with no status when no answer arrives, naming no secret", async () => {
			const closed = REFUSED_URL
			const setup: Setup = { auth: { kind: "bearer", token: "tok-secret" } }
			const run = await sseSdk().runCalls(
				{ calls: [pending("p-secret")], setup },
				{ url: closed },
				{ client: "async", script: { log: true } },
			)
			expect({ log: run.trace?.log, observed: run.observed, status: run.status }, run.stderr).toEqual({
				log: [
					start(PENDING),
					logged(PENDING, "error", "error", { error: expect.stringMatching(/^APIConnectionError: /) }),
				],
				observed: [null],
				status: 0,
			})
			expect(leaked(run.trace?.log)).toEqual([])
		})
	},
)
