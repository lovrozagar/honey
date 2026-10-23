/**
 * An SSE open runs through the exchange (bit 16 phase d1, J6; C#'s `sse.hooks.test.ts`, contract 50 §5.3): its typed
 * `<Op>Headers` fill at the open (J3), and onRequest, onResponse, the 401 refresh, the stale settle and onLog run on it
 * as on a plain call. A 2xx is never read, so its events come from the stream whatever a hook set, while a hook's body
 * replaces an error status's; a throwing hook ends the open as `HookException("hook: <its message>")` with the stream
 * unread and its live body closed, while the program runs on; the refreshed token is the client's current one, which a
 * later open sends; and every log entry names only the operation template, never a header value, query, path value or
 * token. Driven against the `sse` registry document; the release at the throw is a consumer program's (gone.ts).
 */
import { describe, expect, it } from "vitest"
import type { Call, Observed, Setup } from "../../../tests/integration/conformance/matrix.ts"
import { gone } from "../shared/__fixtures__/gone.ts"
import { sse as sseDocument } from "../shared/__fixtures__/documents-streams.ts"
import type { HookTrace, JavaError, LogTrace, Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, REFUSED_URL, served } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenJavaSdk, drivenJavaSdk, servedJavaSdk } from "./__fixtures__/driven.ts"
import { withJava } from "./__fixtures__/java-env.ts"

/** Whether Java is pinned here: a missing toolchain fails where it is required and skips these legs elsewhere. */
const JAVA = withJava()
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

/** `sdk`, which must build. */
function built(sdk: DrivenJavaSdk): DrivenJavaSdk {
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

/** `calls` under `script` and `setup` against a server answering `replies`: the run (which must exit 0), hops, streams and origin. */
async function drive(replies: readonly Reply[], calls: readonly Call[], script: Script, setup: Setup = {}) {
	return driveOn(built(drivenJavaSdk("sse")), replies, calls, { script, setup })
}

/** `calls` on `sdk` under `script` and `setup` against a server answering `replies`, as `drive` runs them. */
async function driveOn(
	sdk: DrivenJavaSdk,
	replies: readonly Reply[],
	calls: readonly Call[],
	{ script, setup }: { readonly script: Script; readonly setup: Setup },
) {
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

/** A Java error as the trace records it: no inner, not canceled, the method's own throw unless given, any display. */
const plain = (entry: Partial<JavaError>) => ({
	canceled: false,
	display: expect.any(String),
	inner: null,
	via: "return",
	...entry,
})

/** The stale fields of a client without invalidation, as every hook sees them. */
const OFF = { invalidatedBy: [], isRetry: false, isStale: false, selector: expect.any(String) }

/** An onLog entry as the trace records it, named by the operation template. */
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

describe.skipIf(!JAVA)("an SSE open's typed response headers and request hooks", SLOW, () => {
	/* new: C# sse.hooks.test.ts:100 */
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
			/* J3: the holder is filled at the open, its member under the header's declared wire name */
			stream: { headers: { "X-Stream-Id": "s-1" }, retry: [null], yields: 1 },
		})
	})
})

/**
 * A throwing onResponse hook on a held stream's open, then the program's next request, on a client without the hook:
 * the release point (gone.ts), its answer held until the first stream's client left. Nothing closes the hooked client's
 * stream, which the method never returned, so only the open's own release can let the first connection go in time.
 */
const HOOK_FAILS = (url: string) => `package probe;

import ai.anyrow.*;

public class Probe {
  public static void main(String[] args) {
    AnyrowClient hooked = AnyrowClient.builder().baseUrl("${url}")
        .onResponse(context -> {
          throw new IllegalStateException("bad");
        })
        .build();
    try {
      hooked.ticks().stream(TicksStreamParams.builder().build());
      System.out.println("opened");
    } catch (HookException error) {
      System.out.println(error.getClass().getSimpleName() + ": " + error.getMessage());
    }
    AnyrowClient plain = AnyrowClient.builder().baseUrl("${url}").build();
    try (EventStream<Tick> s = plain.ticks().stream(TicksStreamParams.builder().build())) {
      for (SseEvent<Tick> next : s) {
        System.out.println(next.data().n());
        break;
      }
    }
  }
}
`

describe.skipIf(!JAVA)("an SSE open through a plain call's pipeline: the onResponse hooks", SLOW, () => {
	/* new: C# sse.hooks.test.ts:148 */
	it("runs them in order on the open, and an error status's last body set is the one observed", async () => {
		/* a 2xx stream's body is never read at the open: its events come from the stream, whatever a hook set */
		const script: Script = { hooks: { response: [{}, { body: '{"message":"hooked"}' }] } }
		const { run } = await drive([TICK, NOPE], [ticks(), ticks()], script)
		expect({ observed: run.observed, order: steps(run.trace?.hooks) }, run.stderr).toEqual({
			observed: [TICKED, { body: { message: "hooked" }, errorKey: null, kind: "error", status: 404 }],
			order: "0 request 0 | 0 response 0 200 | 0 response 1 200 | 1 request 0 | 1 response 0 404 | 1 response 1 404",
		})
	})

	/* new: C# sse.hooks.test.ts:159 */
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
				inner: "IllegalStateException",
				text: "hook: bad",
				type: "HookException",
			}),
			gone: true,
			observed: [null],
			order: "0 request 0 | 0 response 0 200",
			stream: undefined,
		})
	})

	/* new: C# sse.hooks.test.ts:185 (R5's consumer form) */
	it("lets the connection go at the throw, while the program runs on, not at its exit", async () => {
		const next = gone(TICK)
		const sdk = built(drivenJavaSdk("sse"))
		const ran = await served([HELD, next.reply], (server) => sdk.exec("probe.Probe", HOOK_FAILS(server.url)))
		expect(
			{ out: ran.stdout.split("\n").filter((l) => l !== ""), released: next.released(), status: ran.status },
			ran.stderr,
		).toEqual({ out: ["HookException: hook: bad", "1"], released: true, status: 0 })
	})
})

describe.skipIf(!JAVA)("an SSE open's 401: one refresh, its token the client's current one", SLOW, () => {
	/* new: C# sse.hooks.test.ts:200 */
	it("refreshes once and streams on the retry, every hook again with isRetry, onLog one exchange", async () => {
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

	/* new: C# sse.hooks.test.ts:224 */
	it("sends the refreshed token on the next open, never the one the client was built with", async () => {
		const script: Script = { onAuthExpired: { tokens: ["new"] } }
		const { hops, run } = await drive([EXPIRED, TICK, TICK], [ticks(), ticks()], script, OLD)
		expect(
			{ auth: hops.map((hop) => hop.headers.authorization), expired: run.trace?.authExpired, observed: run.observed },
			run.stderr,
		).toEqual({ auth: ["Bearer old", "Bearer new", "Bearer new"], expired: 1, observed: [TICKED, TICKED] })
	})
})

/** The `sse` document with `ticks.reset`, a mutation whose x-invalidate names the stream's read. */
function staleDocument(): Record<string, unknown> {
	const document = structuredClone(sseDocument()) as { paths: Record<string, Record<string, unknown>> }
	document.paths["/ticks"] = {
		...document.paths["/ticks"],
		post: { operationId: "ticks.reset", responses: { 204: { description: "reset" } }, "x-invalidate": ["GET /ticks"] },
	}
	return document
}

describe.skipIf(!JAVA)("an SSE open's stale settle (ruling 3: the open runs it as a plain call does)", SLOW, () => {
	/* new: ruling 3; an SSE read after a mutation that invalidates it is stale to its hooks, and the open's own settle
	 * (a read clears its mark, as a plain call's does) leaves the next open fresh */
	it("shows an SSE open after an invalidating mutation as stale to its hooks, and its own settle clears the mark for the next", async () => {
		const reset: Call = { operation: "ticks.reset", route: route("POST", "/ticks") }
		const script: Script = { config: { invalidation: { staleTimeMs: 60_000 } }, hooks: { request: [{}] } }
		const sdk = built(servedJavaSdk(staleDocument()))
		const replies = [{ status: 204 }, TICK, TICK]
		const { run } = await driveOn(sdk, replies, [reset, ticks(), ticks()], { script, setup: {} })
		/* each open's request hook: what it saw of its selector's staleness */
		const opens = [1, 2].map((call) => run.trace?.hooks.find((hook) => hook.call === call))
		expect(
			{ observed: run.observed, opens: opens.map((open) => open && [open.selector, open.isStale, open.invalidatedBy]) },
			run.stderr,
		).toEqual({
			observed: [{ data: null, kind: "data", status: 204 }, TICKED, TICKED],
			opens: [
				["GET /ticks", true, ["POST /ticks"]],
				["GET /ticks", false, []],
			],
		})
	})
})

/* values no log entry may carry: a header value, a query value, a path value and the token */
const SECRETS = ["t-secret", "987654321", "p-secret", "tok-secret"]
/** The secrets `logs` carry, as JSON: [] when they are clean (redaction). */
const leaked = (...logs: (readonly LogTrace[] | undefined)[]) =>
	SECRETS.filter((value) => JSON.stringify(logs).includes(value))
const SECRET_TOKEN: Setup = { auth: { kind: "bearer", token: "tok-secret" } }

describe.skipIf(!JAVA)(
	"an SSE open through a plain call's pipeline: onLog, by the operation template only",
	SLOW,
	() => {
		/* new: C# sse.hooks.test.ts:250 */
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

		/* new: C# sse.hooks.test.ts:283 */
		it("logs request_start then an error entry with no status when no answer arrives, naming no secret", async () => {
			const run = await built(drivenJavaSdk("sse")).runCalls(
				{ calls: [pending("p-secret")], setup: SECRET_TOKEN },
				{ url: REFUSED_URL },
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
