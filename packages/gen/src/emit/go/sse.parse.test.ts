import { describe, expect, it } from "vitest"
import type { Call, Observed } from "../../../tests/integration/conformance/matrix.ts"
import { type CallScript, compiledSdk, type DrivenSdk, type GoError, type Script } from "./__fixtures__/compiled.ts"
import { withGo } from "./__fixtures__/go-env.ts"
import { type Reply, served } from "./__fixtures__/recording-server.ts"

/** Whether Go is here: a missing one fails where it is required and skips the Go tests elsewhere (go-env). */
const GO = withGo()
const goDescribe = describe.skipIf(!GO)

type Json = Record<string, unknown>

const events = (schema: Json) => ({ 200: { content: { "text/event-stream": { schema } }, description: "ok" } })

/** A string event stream and a typed one (`$ref Tick`): SSE framing as the emitted SDK parses it. */
const DOC: Json = {
	components: { schemas: { Tick: { properties: { n: { type: "integer" } }, required: ["n"], type: "object" } } },
	info: { title: "SSE parse", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/events": { get: { operationId: "events.list", responses: events({ type: "string" }) } },
		"/ticks": { get: { operationId: "ticks.stream", responses: events({ $ref: "#/components/schemas/Tick" }) } },
	},
}

let compiled: DrivenSdk | undefined

/** The DOC SDK with the test driver, compiled once per file. */
function sdk(): DrivenSdk {
	compiled ??= compiledSdk(DOC, { modulePath: "example.com/sseparse" })
	expect({ built: compiled.built, vet: compiled.vet }, compiled.stderr).toEqual({ built: true, vet: [] })
	return compiled
}

const list = (extra: Partial<Call> = {}): Call => ({
	operation: "events.list",
	route: { method: "GET", path: "/events" },
	...extra,
})
const ticks = (extra: Partial<Call> = {}): Call => ({
	operation: "ticks.stream",
	route: { method: "GET", path: "/ticks" },
	...extra,
})
const sse = (steps: readonly (string | { waitMs: number })[], end: "close" | "drop" | "hold" = "close"): Reply => ({
	sse: { end, steps },
	status: 200,
})

/** `calls` run against a server answering `replies`, under `script` (a scripted run traces each call): the run, hops and streams. */
async function drive(replies: readonly Reply[], calls: readonly Call[], script: Script = {}) {
	const driven = sdk()
	return served(replies, async (server) => {
		const run = await driven.runCalls({ calls }, server, script)
		return { hops: [...server.hops], run, streams: [...server.streams] }
	})
}

/** A call's error as these legs pin it: the sentinels asked, the text, where it came from, and the `*sdk.` types in its chain. */
function errorOf(error: GoError | undefined) {
	if (error === undefined) return undefined
	const sdkTypes = error.chain.filter((type) => type.startsWith("*sdk."))
	return { sdkTypes, sentinels: error.sentinels, text: error.text, via: error.via }
}

const CAPS: CallScript = { isErrors: ["ErrSSELineTooLong", "ErrSSEEventTooLarge"] }
const MiB = 2 ** 20

goDescribe("SSE framing through the emitted SDK: line endings", () => {
	// v0: 20a72dddef
	it("splits events on CRLF and on LF alike, and discards a final event without its blank line", async () => {
		const { hops, run } = await drive([sse(["data: a\r\n\r\ndata: b\n\ndata: partial"])], [list()])
		expect({ observed: run.observed, stream: run.trace?.calls[0]?.stream }, run.stderr).toEqual({
			observed: [{ events: [{ data: "a" }, { data: "b" }], kind: "events" }] satisfies Observed[],
			stream: { retry: [0, 0], yields: 2 },
		})
		expect({ error: run.trace?.calls[0]?.error, hops: hops.length }).toEqual({ error: undefined, hops: 1 })
	}, 600_000)

	it("ends a line on CR alone, and skips the LF of a CRLF split across writes instead of reading a blank line", async () => {
		const replies = [
			sse(["data: a\rdata: b\r\rdata: c\r\n\r\n"]),
			sse(["data: a\r", { waitMs: 100 }, "\ndata: b\r\n", { waitMs: 100 }, "\r", { waitMs: 100 }, "\ndata: c\n\n"]),
		]
		const { run } = await drive(replies, [list(), list()])
		expect(run.observed, run.stderr).toEqual([
			{ events: [{ data: "a\nb" }, { data: "c" }], kind: "events" },
			{ events: [{ data: "a\nb" }, { data: "c" }], kind: "events" },
		] satisfies Observed[])
		expect(run.trace?.calls.map((call) => call.error)).toEqual([undefined, undefined])
	}, 600_000)
})

goDescribe("SSE framing through the emitted SDK: a CR-terminated event dispatches at once", () => {
	it("yields an event ended by CR CR on a held stream without waiting for another byte, string and typed", async () => {
		const replies = [sse(["data: a\r\r"], "hold"), sse(['data: {"n":1}\r\r'], "hold")]
		const { run } = await drive(replies, [list({ take: 1 }), ticks({ take: 1 })])
		expect(run.observed, run.stderr).toEqual([
			{ events: [{ data: "a" }], kind: "events" },
			{ events: [{ data: { n: 1 } }], kind: "events" },
		] satisfies Observed[])
		const calls = run.trace?.calls ?? []
		expect(calls.map((call) => [call.error, call.elapsedMs < 1000])).toEqual([
			[undefined, true],
			[undefined, true],
		])
	}, 600_000)
})

goDescribe("SSE framing through the emitted SDK: the 1 MiB line cap", () => {
	// v0: b111408001
	it("delivers a line of exactly 1 MiB, and ends a longer one with ErrSSELineTooLong after the events before it", async () => {
		const exact = "x".repeat(MiB - "data: ".length)
		const replies = [sse(["data: ok\n\n", `data: ${exact}x\n\n`, "data: never\n\n"]), sse([`data: ${exact}\n\n`])]
		const { run } = await drive(replies, [list(), list()], { calls: [CAPS, CAPS] })
		const [over, fits] = run.trace?.calls ?? []
		const [overSeen, fitsSeen] = (run.observed ?? []) as Extract<Observed, { kind: "events" }>[]
		expect({ over: overSeen, stream: over?.stream }, run.stderr).toEqual({
			over: { events: [{ data: "ok" }], kind: "events" },
			stream: { retry: [0], yields: 2 },
		})
		expect(errorOf(over?.error)).toEqual({
			sdkTypes: [],
			sentinels: { ErrSSEEventTooLarge: false, ErrSSELineTooLong: true },
			text: "honey: sse line exceeds 1 MiB",
			via: "stream",
		})
		expect({
			error: fits?.error,
			events: fitsSeen?.events.map((event) => event.data === exact),
			stream: fits?.stream,
		}).toEqual({ error: undefined, events: [true], stream: { retry: [0], yields: 1 } })
	}, 600_000)
})

/** One event's `data:` lines whose values join (with LF) to exactly `size` bytes of `x`, each line under the line cap. */
function eventOf(size: number): { data: string; text: string } {
	const lines = 9
	const values = Array.from({ length: lines }, () => Math.floor((size - (lines - 1)) / lines))
	values[lines - 1] = size - (lines - 1) - (values[0] as number) * (lines - 1)
	const parts = values.map((n) => "x".repeat(n))
	return { data: parts.join("\n"), text: `${parts.map((part) => `data: ${part}\n`).join("")}\n` }
}

goDescribe("SSE framing through the emitted SDK: the 8 MiB event cap", () => {
	// v0: b111408001
	it("delivers an event of exactly 8 MiB, and ends one over it with ErrSSEEventTooLarge and no event", async () => {
		const limit = eventOf(8 * MiB)
		const over = eventOf(8 * MiB + 1)
		const nine = `${Array.from({ length: 9 }, () => `data: ${"x".repeat(1_000_000)}\n`).join("")}\n`
		const replies = [sse([limit.text]), sse([over.text]), sse([nine, "data: after\n\n"])]
		const script: Script = { calls: [CAPS, CAPS, CAPS] }
		const started = Date.now()
		const { run } = await drive(replies, [list(), list(), list()], script)
		const seen = ((run.observed ?? []) as Extract<Observed, { kind: "events" }>[]).map((o) => ({
			kind: o.kind,
			sizes: o.events.map((event) => (typeof event.data === "string" ? event.data.length : -1)),
		}))
		expect(seen, run.stderr).toEqual([
			{ kind: "events", sizes: [8 * MiB] },
			{ kind: "events", sizes: [] },
			{ kind: "events", sizes: [] },
		])
		const [fits, tooLarge, nineLines] = run.trace?.calls ?? []
		const first = (run.observed?.[0] as Extract<Observed, { kind: "events" }> | undefined)?.events[0]
		expect({ error: fits?.error, exact: first?.data === limit.data, stream: fits?.stream }).toEqual({
			error: undefined,
			exact: true,
			stream: { retry: [0], yields: 1 },
		})
		const capped = {
			sdkTypes: [],
			sentinels: { ErrSSEEventTooLarge: true, ErrSSELineTooLong: false },
			text: "honey: sse event exceeds 8 MiB",
			via: "stream",
		}
		expect([tooLarge, nineLines].map((call) => [errorOf(call?.error), call?.stream])).toEqual([
			[capped, { yields: 1 }],
			[capped, { yields: 1 }],
		])
		expect(Date.now() - started).toBeLessThan(30_000)
	}, 600_000)
})

goDescribe("SSE framing through the emitted SDK: the id and retry fields", () => {
	// v0: 6b81305c6b
	it("keeps the id sticky across events, ignores an id holding NUL, and clears it on an empty id", async () => {
		const steps = ["id: 1\ndata: a\n\nid: x\0y\ndata: b\n\ndata: c\n\nid:\ndata: d\n\n"]
		const { run } = await drive([sse(steps)], [list()])
		expect({ observed: run.observed, stream: run.trace?.calls[0]?.stream }, run.stderr).toEqual({
			observed: [
				{
					events: [{ data: "a", id: "1" }, { data: "b", id: "1" }, { data: "c", id: "1" }, { data: "d" }],
					kind: "events",
				},
			] satisfies Observed[],
			stream: { retry: [0, 0, 0, 0], yields: 4 },
		})
		expect(run.trace?.calls[0]?.error).toBeUndefined()
	}, 600_000)

	// v0: 5c9b887b0f
	it("takes retry from ASCII digits only, per event: a negative, fractional, non-numeric or empty value is 0", async () => {
		const values = ["3000", "-1", "1.5", "x", "0042", "", " 7"]
		const steps = values.map((value, i) => `retry: ${value}\ndata: ${i}\n\n`)
		const { run } = await drive([sse([...steps, "data: none\n\n"])], [list()])
		expect({ observed: run.observed, stream: run.trace?.calls[0]?.stream }, run.stderr).toEqual({
			observed: [
				{ events: [...values.map((_, i) => ({ data: String(i) })), { data: "none" }], kind: "events" },
			] satisfies Observed[],
			stream: { retry: [3000, 0, 0, 0, 42, 0, 0, 0], yields: 8 },
		})
		expect(run.trace?.calls[0]?.error).toBeUndefined()
	}, 600_000)
})

goDescribe("SSE framing through the emitted SDK: the rest of the WHATWG interpretation", () => {
	it("skips a leading BOM and comments, joins data lines, reads a bare field name, and drops a block without data", async () => {
		const steps = [
			"﻿data: a\n\n",
			": ping\n",
			"data: x\ndata: y\n\n",
			"event: e\n\n",
			"data\n\n",
			"foo: bar\nevent: named\ndata:  two \n\n",
			"data:tight\n\n",
		]
		const { run } = await drive([sse(steps)], [list()])
		expect({ observed: run.observed, stream: run.trace?.calls[0]?.stream }, run.stderr).toEqual({
			observed: [
				{
					events: [{ data: "a" }, { data: "x\ny" }, { data: "" }, { data: " two ", event: "named" }, { data: "tight" }],
					kind: "events",
				},
			] satisfies Observed[],
			stream: { retry: [0, 0, 0, 0, 0], yields: 5 },
		})
		expect(run.trace?.calls[0]?.error).toBeUndefined()
	}, 600_000)

	it("strips a BOM only at the stream's start: one before a later field leaves that line an unknown field", async () => {
		const { run } = await drive([sse(["data: a\n\n﻿data: b\n\ndata: c\n\n"])], [list()])
		expect(run.observed, run.stderr).toEqual([
			{ events: [{ data: "a" }, { data: "c" }], kind: "events" },
		] satisfies Observed[])
	}, 600_000)
})
