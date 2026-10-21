/**
 * An SSE open runs through phase c's exchange (contract 50 §5.3, the §1 rule "Open"; Python's and Rust's
 * `sse.hooks.test.ts` analog): its typed `<Op>Headers` are filled at the open (Fd4), and `OnRequest`, `OnResponse`,
 * the 401 refresh and `OnLog` run on it as on a plain call. A 2xx is never read, so its events come from the stream
 * whatever a hook set, while a hook's body replaces an error status's; a throwing hook ends the open as
 * `HookException("hook: <its message>")` with the stream unread and its live response disposed, while the program
 * runs on; the refreshed token is the client's current one, which a later open sends; and every log entry names
 * only the operation template, never a header value, query, path value or token. Driven against the `sse` registry
 * document (shared/__fixtures__/documents-streams.ts); the release at the throw is a consumer program's (`gone.ts`).
 * The realtime dials' hooks are `realtime.test.ts`'s.
 */
import { describe, expect, it } from "vitest"
import type { Call, Observed, Setup } from "../../../tests/integration/conformance/matrix.ts"
import { gone } from "../shared/__fixtures__/gone.ts"
import type { CsError, HookTrace, LogTrace, Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served, REFUSED_URL } from "../shared/__fixtures__/recording-server.ts"
import { consume, seen } from "./__fixtures__/consumer.ts"
import { withDotnet } from "./__fixtures__/csharp-env.ts"
import { type DrivenCSharpSdk, drivenCSharpSdk } from "./__fixtures__/driven.ts"

/** Whether .NET is here: a missing SDK fails where it is required and skips these legs elsewhere (csharp-env). */
const DOTNET = withDotnet()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
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
const EXPIRED: Reply = { json: { message: "expired" }, status: 401 }
const TICKED: Observed = { events: [{ data: { n: 1 } }], kind: "events" }
const OLD: Setup = { auth: { kind: "bearer", token: "old" } }

/** The `sse` SDK with the driver aimed at it: it must build. */
function sseSdk(): DrivenCSharpSdk {
	const sdk = drivenCSharpSdk("sse")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

/** `calls` under `script` and `setup` against a server answering `replies`: the run (which must exit 0), hops, streams and origin. */
async function drive(replies: readonly Reply[], calls: readonly Call[], script: Script, setup: Setup = {}) {
	const sdk = sseSdk()
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup }, { url: server.url }, { script })
		expect(run.status, run.stderr).toBe(0)
		return { hops: [...server.hops], run, streams: [...server.streams], url: server.url }
	})
}

/** The hook runs as `<call> <phase> <index>`, a retry flag and status when they have them, joined by `|`. */
const steps = (hooks: readonly HookTrace[] | undefined) =>
	hooks
		?.map((h) => [h.call, h.phase, h.index, h.isRetry ? "retry" : "", h.status ?? ""].filter((p) => p !== "").join(" "))
		.join(" | ")

/** A C# error as the trace records it: no inner, not canceled, the method's own throw unless given, any display. */
const plain = (entry: Partial<CsError>) => ({
	canceled: false,
	display: expect.any(String),
	inner: null,
	via: "return",
	...entry,
})

/** The stale fields of a client without invalidation, as every hook sees them. */
const OFF = { invalidatedBy: [], isRetry: false, isStale: false, selector: expect.any(String) }

/** An OnLog entry as the trace records it, named by the operation template. */
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

/* ported: python sse.hooks.test.ts:86 */
describe.skipIf(!DOTNET)("an SSE open's typed response headers and request hooks", SLOW, () => {
	it("runs the request hooks on the open, their header sent, and fills the typed headers at the open", async () => {
		const reply: Reply = { ...TICK, headers: { "x-stream-id": "s-1" } }
		const script: Script = { hooks: { request: [{ setHeader: ["x-hook", "1"] }] } }
		const { hops, run, url } = await drive([reply], [ticks()], script)
		expect(
			{
				hook: hops.map((hop) => hop.headers["x-hook"]),
				observed: run.observed,
				ran: run.trace?.hooks.filter((hook) => hook.phase === "request"),
				stream: run.trace?.calls[0]?.stream,
			},
			run.stderr,
		).toEqual({
			hook: ["1"],
			observed: [TICKED],
			ran: [{ ...OFF, call: 0, index: 0, method: "GET", path: "/ticks", phase: "request", url: `${url}/ticks` }],
			/* Fd4: the holder is filled at the open, its member under the header's declared wire name */
			stream: { headers: { "X-Stream-Id": "s-1" }, retry: [null], yields: 1 },
		})
	})
})

/**
 * A throwing `OnResponse` hook on a held stream's open, then the program's next request, on a client without the
 * hook: the release point (gone.ts), its answer held until the first stream's client left. The hooked client stays
 * undisposed until the program ends, so only the open's own release can let the first connection go in time.
 */
const HOOK_FAILS = `Func<ResponseContext, System.Threading.CancellationToken, Task> bad = (_, _) => throw new InvalidOperationException("bad");
using var c = Client(new ClientConfig { OnResponse = [bad] });
try
{
    await c.Ticks.StreamAsync();
    Note("opened");
}
catch (HookException error)
{
    Note($"{error.GetType().Name}: {error.Message}");
}
using var plain = Client();
await using var s = await plain.Ticks.StreamAsync();
await foreach (var next in s)
{
    Note($"{next.Data.N}");
    break;
}`

describe.skipIf(!DOTNET)("an SSE open through a plain call's pipeline: the OnResponse hooks", SLOW, () => {
	/* ported: python sse.hooks.test.ts:138 */
	it("runs them in order on the open, and an error status's last body set is the one observed", async () => {
		/* a 2xx stream's body is never read at the open: its events come from the stream, whatever a hook set */
		const script: Script = { hooks: { response: [{}, { body: '{"message":"hooked"}' }] } }
		const { run } = await drive([TICK, NOPE], [ticks(), ticks()], script)
		expect({ observed: run.observed, order: steps(run.trace?.hooks) }, run.stderr).toEqual({
			observed: [TICKED, { body: { message: "hooked" }, errorKey: null, kind: "error", status: 404 }],
			order: "0 request 0 | 0 response 0 200 | 0 response 1 200 | 1 request 0 | 1 response 0 404 | 1 response 1 404",
		})
	})

	/* ported: python sse.hooks.test.ts:148 */
	it("ends the open as HookException when one throws: no stream, no later hook, the connection gone unread", async () => {
		const { run, streams } = await drive([HELD], [ticks()], { hooks: { response: [{ fail: "bad" }, {}] } })
		expect(
			{
				error: run.trace?.calls[0]?.error,
				gone: streams[0]?.clientGone,
				observed: run.observed,
				order: steps(run.trace?.hooks),
				stream: run.trace?.calls[0]?.stream,
			},
			run.stderr,
		).toEqual({
			error: plain({
				chain: ["HookException", "HoneyException"],
				inner: "InvalidOperationException",
				text: "hook: bad",
				type: "HookException",
			}),
			gone: true,
			observed: [null],
			order: "0 request 0 | 0 response 0 200",
			stream: undefined,
		})
	})

	/* ported: python sse.hooks.test.ts:166; red under M3 (OpenAsync's catch leaves the live response, §8.2) */
	it("lets the connection go at the throw, while the program runs on, not at its exit", async () => {
		const next = gone(TICK)
		const run = await served([HELD, next.reply], (server) =>
			consume("sse", "hook_fails", { base: server.url, body: HOOK_FAILS }),
		)
		expect({ ...seen(run), released: next.released() }, run.stderr).toEqual({
			out: ["HookException: hook: bad", "1"],
			ran: true,
			released: true,
		})
	})
})

describe.skipIf(!DOTNET)("an SSE open's 401: one refresh, its token the client's current one", SLOW, () => {
	/* ported: python sse.hooks.test.ts:182 */
	it("refreshes once and streams on the retry, every hook again with IsRetry, OnLog one exchange", async () => {
		const script: Script = { hooks: { response: [{}] }, log: true, onAuthExpired: { tokens: ["new"] } }
		const { hops, run } = await drive([EXPIRED, TICK], [ticks()], script, OLD)
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

	/* ported: python sse.hooks.test.ts:207 */
	it("sends the refreshed token on the next open, never the one the client was built with", async () => {
		const script: Script = { onAuthExpired: { tokens: ["new"] } }
		const { hops, run } = await drive([EXPIRED, TICK, TICK], [ticks(), ticks()], script, OLD)
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
const SECRET_TOKEN: Setup = { auth: { kind: "bearer", token: "tok-secret" } }

describe.skipIf(!DOTNET)(
	"an SSE open through a plain call's pipeline: OnLog, by the operation template only",
	SLOW,
	() => {
		/* ported: python sse.hooks.test.ts:232 */
		it("logs request_start, then response_received at info for a 2xx, warn plus an error entry for an error status", async () => {
			const calls = [
				ticks({ headers: { "x-tenant": "t-secret" }, search: { since: 987654321 } }),
				ticks(),
				pending("p-secret"),
			]
			const { hops, run } = await drive([TICK, NOPE, sse(["data: x\n\n"])], calls, { log: true }, SECRET_TOKEN)
			expect({ log: run.trace?.log, observed: run.observed }, run.stderr).toEqual({
				log: [
					start(TICKS),
					answered(TICKS, "info", 200),
					start(TICKS),
					answered(TICKS, "warn", 404),
					logged(TICKS, "error", "error", { error: "NotFoundException: HTTP 404: nope", status: 404 }),
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
			expect(hops.map((hop) => [hop.url, hop.headers["x-tenant"], hop.headers.authorization])).toEqual([
				["/ticks?since=987654321", "t-secret", "Bearer tok-secret"],
				["/ticks", undefined, "Bearer tok-secret"],
				["/pending/p-secret", undefined, "Bearer tok-secret"],
			])
			expect(leaked(run.trace?.log)).toEqual([])
		})

		/* ported: python sse.hooks.test.ts:265 */
		it("logs request_start then an error entry with no status when no answer arrives, naming no secret", async () => {
			const closed = REFUSED_URL
			const run = await sseSdk().runCalls(
				{ calls: [pending("p-secret")], setup: SECRET_TOKEN },
				{ url: closed },
				{ script: { log: true } },
			)
			expect({ log: run.trace?.log, observed: run.observed, status: run.status }, run.stderr).toEqual({
				log: [
					start(PENDING),
					logged(PENDING, "error", "error", { error: expect.stringMatching(/^ApiConnectionException: /) }),
				],
				observed: [null],
				status: 0,
			})
			expect(leaked(run.trace?.log)).toEqual([])
		})
	},
)
