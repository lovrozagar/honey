/**
 * The Java test driver's streams (bit 16 phase d1; C#'s `sdk.driver.stream.test.ts`, contract 50 §4.4): an SSE
 * operation's call plan, the stream field's fold included; SSE events read with `take`, the typed headers, `retry` and
 * the stream's error; a `take` that lets the connection go while the run goes on (the driver closes at take, Java's
 * try-with-resources, so this is the SDK's own release); the reader's interrupt ending an open stream quietly, its
 * cancel traced; the 10 s watchdog; and what the driver refuses on a call, nothing sent. Driven against the `sse`
 * registry document; the refusals run on hand-written plans laid over it, refused before the SDK loads: a realtime
 * call's own (d2b) among them. The WebSocket and realtime observations: the d2a legs below, and `realtime.test.ts`.
 */
import { describe, expect, it } from "vitest"
import type { Call, Observed } from "../../../tests/integration/conformance/matrix.ts"
import { gone } from "../shared/__fixtures__/gone.ts"
import { createHash } from "node:crypto"
import { sse as sseDocument } from "../shared/__fixtures__/documents-streams.ts"
import type { Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { type DrivenJavaSdk, drivenJavaSdk } from "./__fixtures__/driven.ts"
import { withJava } from "./__fixtures__/java-env.ts"
import { javaCallPlans } from "./sdk.ts"

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
const text = (extra: Partial<Call> = {}): Call => ({ operation: "text.stream", route: route("GET", "/text"), ...extra })
const ROOMS: Call = { operation: "rooms.socket", params: { room: "r" }, route: route("GET", "/rooms/{room}") }
const LIVE: Call = { operation: "feed.live", route: route("GET", "/feed"), take: 1 }
const ECHO: Call = { operation: "echo.get", route: route("GET", "/echo") }
const tick = (n: number) => `data: {"n":${n}}\n\n`
const sse = (steps: readonly (string | { waitMs: number })[], end: "close" | "drop" | "hold" = "close"): Reply => ({
	sse: { end, steps },
	status: 200,
})
/** An untyped stream's events as observed: each text its event's data. */
const strings = (...texts: readonly string[]): Observed => ({ events: texts.map((data) => ({ data })), kind: "events" })
/** A stream's cancel as traced: the reader's interrupt ended it (J2), via the stream. */
const CANCELED = expect.objectContaining({ canceled: true, via: "stream" })
const CONNECTION = ["ApiConnectionException", "HoneyException"]

/** The `sse` registry SDK with the driver aimed at it, which must build. */
function on(): DrivenJavaSdk {
	const sdk = drivenJavaSdk("sse")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

/** `calls` run by `sdk` against a server answering `replies`, under `script` when given: the run, hops and streams. */
async function drive(sdk: DrivenJavaSdk, replies: readonly Reply[], calls: readonly Call[], script?: Script) {
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup: {} }, { url: server.url }, { script })
		return { hops: [...server.hops], run, streams: [...server.streams] }
	})
}

/** The `sse` document with ticks.stream also declaring a `Last-Event-ID` header and a `lastEventId` query param. */
function folded(): Record<string, unknown> {
	const document = structuredClone(sseDocument()) as { paths: { "/ticks": { get: { parameters: unknown[] } } } }
	document.paths["/ticks"].get.parameters.push(
		{ in: "header", name: "Last-Event-ID", schema: { type: "string" } },
		{ in: "query", name: "lastEventId", schema: { type: "string" } },
	)
	return document
}

describe("javaCallPlans: an SSE operation's plan", () => {
	/* new: C# sdk.driver.stream.test.ts:172 (J7: the stream field folds a declared Last-Event-ID; a clash claims …2) */
	it("names the stream kind, the typed headers, the cursor field and no idempotency key, and folds a declared Last-Event-ID", () => {
		const plan = javaCallPlans(FIXTURES.sse.document())["ticks.stream"]
		const fold = javaCallPlans(folded())["ticks.stream"]
		expect({
			fold: [fold?.headers, fold?.query, fold?.lastEventId],
			ticks: plan,
		}).toEqual({
			fold: [{ "x-tenant": "xTenant" }, { lastEventId: "lastEventId2", since: "since" }, "lastEventId"],
			ticks: expect.objectContaining({
				accessors: ["ticks"],
				idempotencyKey: null,
				lastEventId: "lastEventId",
				method: "stream",
				query: { since: "since" },
				responseHeaders: { fields: { "X-Stream-Id": "xStreamId" }, type: "TicksStreamHeaders" },
				stream: "sse",
			}),
		})
	})
})

describe.skipIf(!JAVA)("the Java test driver: SSE, EventStream<T>", SLOW, () => {
	/* new: C# sdk.driver.stream.test.ts:199 */
	it("observes typed events with event and id until take, and traces retry (null when unset) and the typed headers", async () => {
		const reply: Reply = {
			headers: { "x-stream-id": "s-1" },
			...sse(['retry: 3000\nid: 1\nevent: tick\ndata: {"n":1}\n\n', tick(2), { waitMs: 50 }, tick(3)], "hold"),
		}
		const call = ticks({ headers: { "x-tenant": "acme" }, lastEventId: "evt-5", search: { since: 5 }, take: 2 })
		const { hops, run, streams } = await drive(on(), [reply, sse(['data: {"a":1}\n\n'])], [call, text()], {})
		expect({ observed: run.observed, streams: run.trace?.calls.map((c) => c.stream) }, run.stderr).toEqual({
			observed: [
				{
					events: [
						{ data: { n: 1 }, event: "tick", id: "1" },
						{ data: { n: 2 }, id: "1" },
					],
					kind: "events",
				},
				strings('{"a":1}'),
			] satisfies Observed[],
			streams: [
				{ headers: { "X-Stream-Id": "s-1" }, retry: [3000, null], yields: 2 },
				{ retry: [null], yields: 1 },
			],
		})
		expect(hops[0]).toMatchObject({
			headers: { accept: "text/event-stream", "last-event-id": "evt-5", "x-tenant": "acme" },
			url: "/ticks?since=5",
		})
		expect(streams[0]?.clientGone).toBe(true)
	})

	/* new: C# sdk.driver.stream.test.ts:229 (the driver's close at take is Java's try-with-resources, the SDK's release) */
	it("lets a held stream's connection go at take while the run goes on: the SDK's close, not the driver's exit", async () => {
		const held = sse([tick(1), { waitMs: 100 }, tick(2), { waitMs: 100 }, tick(3)], "hold")
		/* the second call's answer waits until the first stream's client left (gone.ts): the driver still runs */
		const next = gone(sse([tick(9)]))
		const { run } = await drive(on(), [held, next.reply], [ticks({ take: 1 }), ticks()], {})
		expect({ observed: run.observed, released: next.released() }, run.stderr).toEqual({
			observed: [
				{ events: [{ data: { n: 1 } }], kind: "events" },
				{ events: [{ data: { n: 9 } }], kind: "events" },
			],
			released: true,
		})
	})
})

/** Two ticks, then the connection dropped: the events delivered and the stream's no-answer failure. */
const DROPPED = { events: [{ data: { n: 1 } }, { data: { n: 2 } }], failed: "transport", kind: "events" }

describe.skipIf(!JAVA)("the Java test driver: how an SSE call fails", SLOW, () => {
	/* new: C# sdk.driver.stream.test.ts:245 */
	/* bit 21 i0: a drop is no answer (f2), so the grid observes it as the stream's own `failed`, scripted or not */
	it("observes the events before a dropped connection and how it failed, the stream's error traced and counted, unscripted too", async () => {
		const sdk = on()
		const dropped = sse([tick(1), tick(2), { waitMs: 50 }], "drop")
		const { run } = await drive(sdk, [dropped], [ticks()], {})
		const call = run.trace?.calls[0]
		expect({ error: call?.error, observed: run.observed, stream: call?.stream }, run.stderr).toEqual({
			error: expect.objectContaining({
				chain: CONNECTION,
				text: "the event stream failed",
				type: "ApiConnectionException",
				via: "stream",
			}),
			observed: [DROPPED],
			stream: { retry: [null, null], yields: 3 },
		})
		const bare = await drive(sdk, [dropped], [ticks()])
		expect({ observed: bare.run.observed, status: bare.run.status }, bare.run.stderr).toEqual({
			observed: [DROPPED],
			status: 0,
		})
	})

	/* new: C# sdk.driver.stream.test.ts:269 */
	it("observes an error status at the open as error and a path failing before any stream as null, both via return", async () => {
		const replies: Reply[] = [{ json: { message: "nope" }, status: 404 }]
		const pending: Call = { operation: "pending.stream", params: { id: ".." }, route: route("GET", "/pending/{id}") }
		const { hops, run } = await drive(on(), replies, [ticks(), pending], {})
		const [status, path] = run.trace?.calls ?? []
		expect({ hops: hops.length, observed: run.observed }, run.stderr).toEqual({
			hops: 1,
			observed: [{ body: { message: "nope" }, errorKey: null, kind: "error", status: 404 }, null],
		})
		expect([status?.error?.via, status?.error?.type, status?.stream, path?.error?.type, path?.error?.via]).toEqual([
			"return",
			"NotFoundException",
			undefined,
			"PathParamException",
			"return",
		])
	})
})

describe.skipIf(!JAVA)("the Java test driver: what ends an SSE call", SLOW, () => {
	/* new: C# sdk.driver.stream.test.ts:289 (the interrupt 1,000 ms in, after the first event, 4,000 ms before the second) */
	it("ends an open stream quietly when its reader is interrupted after it opened: the events so far, the cancel traced", async () => {
		const held = sse(["data: 1\n\n", { waitMs: 5000 }, "data: 2\n\n"], "hold")
		const script: Script = { calls: [null, { cancel: { afterMs: 1000 } }] }
		const warm = text({ take: 1, timeoutMs: 0 })
		const { run } = await drive(on(), [sse(["data: w\n\n"]), held], [warm, text({ take: 2 })], script)
		const call = run.trace?.calls[1]
		expect(
			{ error: call?.error, observed: run.observed, status: run.status, stream: call?.stream },
			run.stderr,
		).toEqual({
			error: CANCELED,
			observed: [strings("w"), strings("1")],
			status: 0,
			stream: { retry: [null], yields: 2 },
		})
		expect(call?.elapsedMs).toBeGreaterThanOrEqual(990)
		expect(call?.elapsedMs).toBeLessThan(4000)
	})

	/* new: C# sdk.driver.stream.test.ts:310 (the watchdog's own text proves it fired) */
	it("fails the run when a stream never ends: stream stalled, after 10 s", async () => {
		const { run } = await drive(on(), [sse([tick(1)], "hold")], [ticks()])
		expect({ status: run.status, stderr: run.stderr.trim() }).toEqual({
			status: 1,
			stderr: "driver: call 0 (ticks.stream): stream stalled: no end within 10s",
		})
	})
})

/** A plan written by hand for an operation the `sse` document lacks: refused before the SDK loads, so no type need exist. */
const handPlan = (operation: string, stream: string | null) => ({
	accessors: [operation.split(".")[0]],
	body: null,
	headers: {},
	idempotencyKey: null,
	lastEventId: null,
	method: "call",
	operation,
	options: true,
	params: "Params",
	path: [],
	query: {},
	required: [],
	response: "none",
	responseHeaders: null,
	stream,
	throws: true,
})
const PLANS = {
	"echo.get": handPlan("echo.get", null),
	"feed.live": handPlan("feed.live", "realtime"),
	"rooms.socket": handPlan("rooms.socket", "ws"),
}

/** Each control a call cannot take as its operation streams (or does not), its script when it is one, and the reason. */
const STREAM_REFUSALS: readonly (readonly [Call, Script | undefined, string])[] = [
	[ticks({ send: ["x"] }), undefined, "send on an SSE operation: only a WebSocket or realtime call sends"],
	[
		ticks({ reconnectToken: "t" }),
		undefined,
		"reconnectToken on an SSE operation: only a WebSocket or realtime call resumes by token",
	],
	[
		ticks(),
		{ calls: [{ protocols: ["v1"] }] },
		"protocols on an SSE operation: only a WebSocket or realtime dial offers subprotocols",
	],
	[ticks(), { calls: [{ realtime: {} }] }, "a realtime script on an SSE operation"],
	[ticks(), { calls: [{ ws: { on: true } }] }, "a ws script on an SSE operation"],
	[ticks({ raw: true }), undefined, "raw: true on an SSE operation, which has no single response to read"],
	[
		{ ...ROOMS, lastEventId: "1" },
		undefined,
		"lastEventId on a WebSocket operation: only an SSE or realtime call resumes by event id",
	],
	[ROOMS, { calls: [{ realtime: { maxReconnectAttempts: 1 } }] }, "a realtime script on a WebSocket operation"],
	[{ ...ROOMS, raw: true }, undefined, "raw: true on a WebSocket operation, which has no single response to read"],
	[
		{ operation: "feed.live", route: route("GET", "/feed") },
		undefined,
		"a realtime call needs take: the connection never ends by itself",
	],
	[LIVE, { calls: [{ ws: { on: true } }] }, "a ws script on a realtime operation"],
	[{ ...LIVE, raw: true }, undefined, "raw: true on a realtime operation, which has no single response to read"],
	[{ ...ECHO, take: 1 }, undefined, "take on an operation that does not stream"],
	[{ ...ECHO, send: ["x"] }, undefined, "send on an operation that does not stream"],
	[{ ...ECHO, lastEventId: "1" }, undefined, "lastEventId on an operation that does not stream"],
	[{ ...ECHO, reconnectToken: "t" }, undefined, "reconnectToken on an operation that does not stream"],
	[ECHO, { calls: [{ protocols: ["v1"] }] }, "protocols on an operation that does not stream"],
	[ECHO, { calls: [{ realtime: {} }] }, "a realtime script on an operation that does not stream"],
	[ECHO, { calls: [{ ws: {} }] }, "a ws script on an operation that does not stream"],
]
const REFUSALS = STREAM_REFUSALS.map(
	([call, script, reason]) => [call, script, `call 0 (${call.operation}): ${reason}`] as const,
)

/** What the script decoding refuses for good, before any call: another driver's controls. */
const SCRIPT_REFUSALS: readonly (readonly [Script, string])[] = [
	[
		{ calls: [{ taskCancel: { afterMs: 150 } }] },
		"script: call 0: taskCancel is a Python AsyncSDK task's; a Java call ends by its thread's interrupt (cancel)",
	],
	[
		{ calls: [{ isErrors: ["ErrSSELineTooLong"] }] },
		"script: call 0: isErrors is Go's errors.Is; the Java trace records the type and text",
	],
	[
		{ calls: [{ ws: { readLimit: 1024 } }] },
		"script: call 0: ws.readLimit is Go's SetReadLimit; a Java socket caps a message at 16 MiB",
	],
	[
		{ calls: [{ ws: { send: [{ json: 1, text: "t" } as never] } }] },
		"script: call 0: ws.send: a message holds exactly one of json, text and bytes",
	],
	[{ calls: [{ ws: { lines: 1 } as never }] }, "script: unknown member lines"],
	[{ calls: [{ realtime: { retries: 1 } as never }] }, "script: call 0: unknown member retries"],
]

describe.skipIf(!JAVA)("the Java test driver: what it refuses on a call, nothing sent", SLOW, () => {
	/* new: C# sdk.driver.stream.test.ts:321 (d2b: a realtime call needs take, and takes no ws script and no raw) */
	it("exits 1 naming each stream control the operation cannot take, and what is another driver's alone, before the SDK loads", async () => {
		const sdk = on()
		const cases = [...REFUSALS, ...SCRIPT_REFUSALS.map(([script, reason]) => [ticks(), script, reason] as const)]
		const { hops, runs } = await served([], async (server) => {
			const ran = []
			for (const [call, script] of cases)
				ran.push(await sdk.runCalls({ calls: [call] }, { url: server.url }, { plans: PLANS, script }))
			return { hops: server.hops.length, runs: ran }
		})
		expect({ hops, runs: runs.map((run) => [run.status, run.stderr.trim(), run.observed]) }).toEqual({
			hops: 0,
			runs: cases.map(([, , reason]) => [1, `driver: ${reason}`, undefined]),
		})
	})
})

const ws = (steps: NonNullable<Reply["ws"]>["steps"]): Reply => ({ status: 101, ws: { steps } })
const rooms = (extra: Partial<Call> = {}): Call => ({ ...ROOMS, ...extra })

/** The `ws` registry SDK with the driver aimed at it, which must build. */
function onWs(): DrivenJavaSdk {
	const sdk = drivenJavaSdk("ws")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

describe("javaCallPlans: a WebSocket operation's plan", () => {
	/* new: C# sdk.driver.stream.test.ts:172 (K2: a declared reconnect_token query folds into the token field) */
	it("names the ws stream kind, the protocols and token fields, the folded query, and no idempotency key", () => {
		expect(javaCallPlans(FIXTURES.ws.document())["rooms.socket"]).toEqual(
			expect.objectContaining({
				accessors: ["rooms"],
				idempotencyKey: null,
				lastEventId: null,
				method: "socket",
				protocols: "protocols",
				query: { since: "since" },
				reconnectToken: "reconnectToken",
				stream: "ws",
			}),
		)
	})
})

describe.skipIf(!JAVA)("the Java test driver: a WebSocket, TypedWebSocket", SLOW, () => {
	/* new: C# sdk.driver.stream.test.ts:341 */
	it("records handlers, sends the grid's text then the scripted JSON, text and bytes, reads take frames, and closes as scripted", async () => {
		const send = [{ json: { a: 1 } }, { text: "t" }, { bytes: 3 }]
		const script: Script = { calls: [{ ws: { close: { code: 1001, reason: "bye" }, on: true, send } }] }
		const reply = ws([{ receive: 4 }, { json: { ok: true } }])
		const { run, streams } = await drive(onWs(), [reply], [rooms({ send: ['{"x":1}'], take: 1 })], script)
		expect({ observed: run.observed, stream: run.trace?.calls[0]?.stream }, run.stderr).toEqual({
			observed: [{ frames: [{ ok: true }], kind: "frames" }],
			stream: {
				handlers: [
					{ data: '{"ok":true}', event: "message" },
					{ data: "bye", event: "close" },
				],
				yields: 1,
			},
		})
		const three = createHash("sha256")
			.update(Buffer.from([0, 1, 2]))
			.digest("hex")
		expect(streams[0]?.received).toEqual([
			{ kind: "text", text: '{"x":1}' },
			{ kind: "text", text: '{"a":1}' },
			{ kind: "text", text: "t" },
			{ kind: "binary", sha256: three, size: 3 },
			{ code: 1001, kind: "close", reason: "bye" },
		])
	})
})

describe.skipIf(!JAVA)("the Java test driver: how a WebSocket read ends", SLOW, () => {
	/* new: C# sdk.driver.stream.test.ts:382 */
	it("ends on the server's close frame as closedBy, and on a drop with the error traced via stream, each end fired once", async () => {
		const replies = [
			ws([{ close: { code: 1000, reason: "done" } }]),
			ws([{ text: "one" }, { waitMs: 50 }, { drop: true }]),
		]
		const script: Script = { calls: [{ ws: { on: true } }, { ws: { on: true } }] }
		const { run } = await drive(onWs(), replies, [rooms(), rooms()], script)
		const ends = (run.trace?.calls ?? []).map(({ error, stream }) => ({
			chain: error?.chain,
			closeError: stream?.closeError,
			closedBy: stream?.closedBy,
			handlers: stream?.handlers?.map((h) => `${h.event} ${h.data}`),
			via: error?.via,
		}))
		expect(run.observed, run.stderr).toEqual([
			{ frames: [], kind: "frames" },
			{ frames: ["one"], kind: "frames" },
		])
		expect(ends).toEqual([
			{
				chain: undefined,
				closeError: undefined,
				closedBy: { code: 1000, reason: "done" },
				handlers: ["close done"],
				via: undefined,
			},
			{
				chain: CONNECTION,
				closeError: undefined,
				closedBy: undefined,
				handlers: ["message one", "error the WebSocket failed"],
				via: "stream",
			},
		])
	})

	/* new: C# sdk.driver.stream.test.ts:418 */
	it("keeps reading after a send fails: the server's close frame still waiting is closedBy, the send's error traced", async () => {
		const reply = ws([{ close: { code: 4401, hangUp: true, reason: "unauthorized" } }])
		const script: Script = { calls: [{ ws: { on: true, send: [{ bytes: 12 << 20 }] } }] }
		const { run } = await drive(onWs(), [reply], [rooms()], script)
		const call = run.trace?.calls[0]
		const seen = {
			closedBy: call?.stream?.closedBy,
			error: [call?.error?.type, call?.error?.via],
			yields: call?.stream?.yields,
		}
		expect({ ...seen, observed: run.observed }, run.stderr).toEqual({
			closedBy: { code: 4401, reason: "unauthorized" },
			error: ["ApiConnectionException", "stream"],
			observed: [{ frames: [], kind: "frames" }],
			yields: 0,
		})
	})
})
