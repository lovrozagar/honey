/**
 * SSE framing through the emitted Java SDK (bit 16 phase d1, J8; C#'s `sse.parse.test.ts`, contract 50 §5.2), driven
 * against the registry `sse` document's `text.stream` and typed `ticks.stream`: CRLF, LF and CR line endings and no
 * other line break; a CR-terminated event dispatched at once; the same events however the stream is chunked, a UTF-8
 * sequence split across writes included; the 1 MiB line and 8 MiB event caps, counted in bytes, each raised once as a
 * `DecodeException`; the id and retry fields, comments, multi-line data and the BOM. The in-process legs on the
 * package-private parser: `sse.parser.test.ts`.
 */
import { describe, expect, it } from "vitest"
import type { Call, Observed } from "../../../tests/integration/conformance/matrix.ts"
import type { JavaError } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import type { SseScript, SseStep } from "../shared/__fixtures__/sse-steps.ts"
import { type DrivenJavaSdk, drivenJavaSdk } from "./__fixtures__/driven.ts"
import { withJava } from "./__fixtures__/java-env.ts"

/** Whether Java is pinned here: a missing toolchain fails where it is required and skips these legs elsewhere. */
const JAVA = withJava()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

type Events = Extract<Observed, { kind: "events" }>

let compiled: DrivenJavaSdk | undefined

/** The registry `sse` SDK with the test driver, gated once per file; it must build. */
function sdk(): DrivenJavaSdk {
	compiled ??= drivenJavaSdk("sse")
	expect(compiled.built, compiled.diagnostics.join("\n")).toBe(true)
	return compiled
}

const route = (path: string) => ({ method: "GET", path })
const text = (extra: Partial<Call> = {}): Call => ({ operation: "text.stream", route: route("/text"), ...extra })
const ticks = (extra: Partial<Call> = {}): Call => ({ operation: "ticks.stream", route: route("/ticks"), ...extra })
const sse = (steps: readonly SseStep[], end: SseScript["end"] = "close"): Reply => ({
	sse: { end, steps },
	status: 200,
})
/** A `bytes` step: these bytes written as one chunk, so a UTF-8 sequence can be split across writes. */
const bytes = (...chunk: readonly (number | string)[]): SseStep => ({
	bytes: Buffer.concat(
		chunk.map((part) => (typeof part === "string" ? Buffer.from(part) : Buffer.from([part]))),
	).toString("base64"),
})
/** An untyped stream's events as observed: each text its event's data. */
const strings = (...texts: readonly string[]): Observed => ({ events: texts.map((data) => ({ data })), kind: "events" })
const NONE: Observed = { events: [], kind: "events" }

/** `calls` run on the one client against a server answering `replies`, scripted so each call is traced: the run and its hops. */
async function drive(replies: readonly Reply[], calls: readonly Call[]) {
	const driven = sdk()
	return served(replies, async (server) => {
		const run = await driven.runCalls({ calls, setup: {} }, { url: server.url }, { script: {} })
		return { hops: [...server.hops], run }
	})
}

/** A call's error as these legs pin it: its type, its text and where it came from. */
const errorOf = (error?: JavaError) => error && { text: error.text, type: error.type, via: error.via }
/** An event with data over 64 characters shown as its length, so a cap leg's diff stays readable. */
const sized = (event: Events["events"][number]) =>
	typeof event.data === "string" && event.data.length > 64 ? { ...event, data: `<${event.data.length} chars>` } : event

/** Call `i` of `run` as the legs pin it: its observed events (sized), its stream trace and its error. */
function callOf(run: Awaited<ReturnType<typeof drive>>["run"], i = 0) {
	const call = run.trace?.calls[i]
	const seen = run.observed?.[i] as Events | null | undefined
	const observed = seen?.kind === "events" ? { ...seen, events: seen.events.map(sized) } : seen
	return { error: errorOf(call?.error), observed, stream: call?.stream }
}

const MiB = 2 ** 20
const LINE_CAP = { text: "an event-stream line exceeds 1 MiB", type: "DecodeException", via: "stream" }
const EVENT_CAP = { text: "an event's data exceeds 8 MiB", type: "DecodeException", via: "stream" }
/** A payload leg's bound on each capped call's own time (the driver's `elapsedMs`, never the process's spawn). */
const PAYLOAD_MS = 30_000

describe.skipIf(!JAVA)("Java SSE framing: line endings", SLOW, () => {
	/* new: C# sse.parse.test.ts:87 */
	it("strips a leading BOM, keeps a value's trailing space, and ends lines on CR alone", async () => {
		const { run } = await drive([sse(["﻿data: first\n\ndata: tok \n\ndata: cr\r\r"])], [text()])
		expect(callOf(run), run.stderr).toEqual({
			observed: strings("first", "tok ", "cr"),
			stream: { retry: [null, null, null], yields: 3 },
		})
	})

	/* new: C# sse.parse.test.ts:96 */
	it("splits events on CRLF and on LF alike, and discards a final event without its blank line", async () => {
		const { hops, run } = await drive([sse(["data: a\r\n\r\ndata: b\n\ndata: partial"])], [text()])
		expect({ ...callOf(run), hops: hops.length }, run.stderr).toEqual({
			hops: 1,
			observed: strings("a", "b"),
			stream: { retry: [null, null], yields: 2 },
		})
	})

	/* new: C# sse.parse.test.ts:106 */
	it("ends a line on CR alone between data lines, and a CR CR or CRLF CRLF ends the event", async () => {
		const { run } = await drive([sse(["data: a\rdata: b\r\rdata: c\r\n\r\n"])], [text()])
		expect(callOf(run), run.stderr).toEqual({
			observed: strings("a\nb", "c"),
			stream: { retry: [null, null], yields: 2 },
		})
	})

	/* new: C# sse.parse.test.ts:116 (U+2028, then the breaks other runtimes honor: NEL, FF, U+2029, VT, FS) */
	it("splits lines only on CR and LF: U+2028, U+2029, NEL, VT, FF and FS stay inside the data", async () => {
		const breaks = [" ", " ", "\u0085", "\u000B", "\u000C", "\u001C"]
		const steps = breaks.map((mark) => `data: {"t":"a${mark}b"}\n\n`)
		const { run } = await drive([sse(steps)], [text()])
		expect(callOf(run), run.stderr).toEqual({
			observed: strings(...breaks.map((mark) => `{"t":"a${mark}b"}`)),
			stream: { retry: breaks.map(() => null), yields: breaks.length },
		})
	})
})

describe.skipIf(!JAVA)("Java SSE framing: a CR-terminated event dispatches at once", SLOW, () => {
	/* new: C# sse.parse.test.ts:130 (one unbounded open first, so each timed open is a later one) */
	it("yields an event ended by CR CR on a held stream without waiting for another byte, string and typed", async () => {
		const replies = [sse(["data: w\n\n"]), sse(["data: a\r\r"], "hold"), sse(['data: {"n":1}\r\r'], "hold")]
		const { run } = await drive(replies, [text({ timeoutMs: 0 }), text({ take: 1 }), ticks({ take: 1 })])
		const typed: Observed = { events: [{ data: { n: 1 } }], kind: "events" }
		expect(run.observed, run.stderr).toEqual([strings("w"), strings("a"), typed])
		/* each timed open's error, else whether its event came within a second */
		expect(run.trace?.calls.slice(1).map((call) => call.error ?? call.elapsedMs < 1000)).toEqual([true, true])
	})
})

/** The stream every chunking below writes: a CRLF event, a CR-split one with an id, a comment, then two multi-byte events. */
const WHOLE = "data: a\r\n\r\nid: 7\ndata: b\rdata: c\r\r: note\r\ndata: é\n\ndata: 😀\n\n"
const CHUNKED_EVENTS = [{ data: "a" }, { data: "b\nc", id: "7" }, { data: "é", id: "7" }, { data: "😀", id: "7" }]

describe.skipIf(!JAVA)("Java SSE framing: the same events however the stream is chunked", SLOW, () => {
	/* new: C# sse.parse.test.ts:146 */
	it("parses a field name, a CRLF and a UTF-8 sequence split across writes as it parses the whole stream", async () => {
		const [e1, e2] = [...Buffer.from("é")] as [number, number]
		const [f1, f2, f3, f4] = [...Buffer.from("😀")] as [number, number, number, number]
		/* the writes, 50 ms apart; "te\r\n" and the first byte of "é" go in one pause's window */
		const writes: SseStep[][] = [
			..."da|ta: a\r|\n\r|\nid: 7\ndata: b\r|data: c\r|\r: no".split("|").map((part) => [part]),
			["te\r\n", bytes("data: ", e1)],
			[bytes(e2, "\n\ndata: ", f1)],
			[bytes(f2, f3)],
			[bytes(f4, "\n\n")],
		]
		const split = writes.flatMap((group, i) => (i === 0 ? group : [{ waitMs: 50 }, ...group]))
		const joined = split.map((s) =>
			typeof s === "string" ? Buffer.from(s) : "bytes" in s ? Buffer.from(s.bytes, "base64") : "",
		)
		expect(Buffer.concat(joined.filter((b) => b !== "")).toString()).toBe(WHOLE)
		const bytewise = [...Buffer.from(WHOLE)].map((b) => bytes(b))
		const { run } = await drive([sse([WHOLE]), sse(split), sse(bytewise)], [text(), text(), text()])
		const seen = { events: CHUNKED_EVENTS, kind: "events" } satisfies Observed
		expect(run.observed, run.stderr).toEqual([seen, seen, seen])
		expect(run.trace?.calls.map((call) => call.error ?? call.stream?.yields)).toEqual([4, 4, 4])
	})

	/* new: C# sse.parse.test.ts:170 */
	it("decodes a two-byte sequence written in two halves as one character, never two replacement characters", async () => {
		const { run } = await drive([sse([bytes("data: ", 0xc3), { waitMs: 50 }, bytes(0xa9, "\n\n")])], [text()])
		expect(callOf(run), run.stderr).toEqual({ observed: strings("é"), stream: { retry: [null], yields: 1 } })
	})
})

describe.skipIf(!JAVA)("Java SSE framing: the 1 MiB line cap, in bytes", SLOW, () => {
	/* new: C# sse.parse.test.ts:179 (a parser that raised its cap on every chunk past it, then delivered the line) */
	it("refuses v0's 3 MiB line with the line cap's error, raised once, and no event", async () => {
		const chunk = "x".repeat(64 * 1024)
		const { run } = await drive([sse(["data: ", ...Array.from({ length: 48 }, () => chunk), "\n\n"])], [text()])
		expect(callOf(run), run.stderr).toEqual({ error: LINE_CAP, observed: NONE, stream: { yields: 1 } })
		expect(run.trace?.calls[0]?.elapsedMs).toBeLessThan(PAYLOAD_MS)
	})

	/* new: C# sse.parse.test.ts:187 */
	it("delivers a line of exactly 1 MiB, and ends a longer one with the line cap's error after the events before it", async () => {
		const exact = "x".repeat(MiB - "data: ".length)
		const replies = [sse(["data: ok\n\n", `data: ${exact}x\n\n`, "data: never\n\n"]), sse([`data: ${exact}\n\n`])]
		const { run } = await drive(replies, [text(), text()])
		const fits = (run.observed?.[1] as Events | undefined)?.events
		expect({ exact: fits?.map((event) => event.data === exact), fits: callOf(run, 1), over: callOf(run, 0) }).toEqual({
			exact: [true],
			fits: { observed: strings(`<${exact.length} chars>`), stream: { retry: [null], yields: 1 } },
			over: { error: LINE_CAP, observed: strings("ok"), stream: { retry: [null], yields: 2 } },
		})
	})

	/* new: C# sse.parse.test.ts:201 (red under a line cap counted in chars: 400,000 chars pass it) */
	it("counts the line cap in bytes: 400,000 three-byte characters (1.2 MB, under 1 Mi characters) are refused", async () => {
		const { run } = await drive([sse([`data: ${"€".repeat(400_000)}\n\n`, "data: never\n\n"])], [text()])
		expect(callOf(run), run.stderr).toEqual({ error: LINE_CAP, observed: NONE, stream: { yields: 1 } })
	})
})

/** One event's `data:` lines whose values join (with LF) to exactly `size` bytes of `x`, each line under the line cap. */
function eventOf(size: number): { data: string; text: string } {
	const lines = 9
	const values = Array.from({ length: lines }, () => Math.floor((size - (lines - 1)) / lines))
	values[lines - 1] = size - (lines - 1) - (values[0] as number) * (lines - 1)
	const parts = values.map((n) => "x".repeat(n))
	return { data: parts.join("\n"), text: `${parts.map((part) => `data: ${part}\n`).join("")}\n` }
}

describe.skipIf(!JAVA)("Java SSE framing: the 8 MiB event cap, and the events a cap keeps", SLOW, () => {
	/* new: C# sse.parse.test.ts:219 */
	it("delivers an event of exactly 8 MiB, its joining newlines counted, and ends one over it with the event cap's error and no event", async () => {
		const limit = eventOf(8 * MiB)
		const nine = `${Array.from({ length: 9 }, () => `data: ${"x".repeat(1_000_000)}\n`).join("")}\n`
		const replies = [sse([limit.text]), sse([eventOf(8 * MiB + 1).text]), sse([nine, "data: after\n\n"])]
		const { run } = await drive(replies, [text(), text(), text()])
		const capped = { error: EVENT_CAP, observed: NONE, stream: { yields: 1 } }
		expect(
			[0, 1, 2].map((i) => callOf(run, i)),
			run.stderr,
		).toEqual([{ observed: strings(`<${8 * MiB} chars>`), stream: { retry: [null], yields: 1 } }, capped, capped])
		expect((run.observed?.[0] as Events | undefined)?.events[0]?.data === limit.data).toBe(true)
		expect(run.trace?.calls.map((call) => call.elapsedMs < PAYLOAD_MS)).toEqual([true, true, true])
	})

	/* new: C# sse.parse.test.ts:235 (over the wire this pins the outcome; the in-process leg below pins M5) */
	it("delivers a complete event written in the same write as an over-cap line or event, then the cap's error", async () => {
		const line = `data: ok\n\ndata: ${"x".repeat(MiB - "data: ".length + 1)}\n\n`
		const event = `data: ok\n\n${eventOf(8 * MiB + 1).text}`
		const { run } = await drive([sse([line]), sse([event])], [text(), text()])
		const ok = { observed: strings("ok"), stream: { retry: [null], yields: 2 } }
		expect([callOf(run, 0), callOf(run, 1)], run.stderr).toEqual([
			{ ...ok, error: LINE_CAP },
			{ ...ok, error: EVENT_CAP },
		])
	})
})

describe.skipIf(!JAVA)("Java SSE framing: the id and retry fields", SLOW, () => {
	/* new: C# sse.parse.test.ts:413 */
	it("keeps the id sticky across events, ignores an id holding NUL, and clears it on an empty id", async () => {
		const { run } = await drive([sse(["id: 1\ndata: a\n\nid: x\0y\ndata: b\n\ndata: c\n\nid:\ndata: d\n\n"])], [text()])
		expect(callOf(run), run.stderr).toEqual({
			observed: {
				events: [{ data: "a", id: "1" }, { data: "b", id: "1" }, { data: "c", id: "1" }, { data: "d" }],
				kind: "events",
			},
			stream: { retry: [null, null, null, null], yields: 4 },
		})
	})

	/* new: C# sse.parse.test.ts:426 (Character.isDigit takes "٣", Long.parseLong takes "-1" and "+7": neither is
	 * ASCII digits only) */
	it("takes retry from ASCII digits only, per event: a negative, fractional, non-numeric, non-ASCII or empty value is none", async () => {
		const values = ["3000", "-1", "1.5", "x", "0042", "", " 7", "²", "٣", "+7"]
		const steps = values.map((value, i) => `${value === "" ? "retry:" : `retry: ${value}`}\ndata: ${i}\n\n`)
		const { run } = await drive([sse([...steps, "data: none\n\n"])], [text()])
		expect(callOf(run), run.stderr).toEqual({
			observed: strings(...values.map((_, i) => String(i)), "none"),
			stream: { retry: [3000, null, null, null, 42, null, null, null, null, null, null], yields: 11 },
		})
	})
})

describe.skipIf(!JAVA)("Java SSE framing: the rest of the WHATWG interpretation", SLOW, () => {
	/* new: C# sse.parse.test.ts:439 */
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
		const { run } = await drive([sse(steps)], [text()])
		expect(callOf(run), run.stderr).toEqual({
			observed: {
				events: [{ data: "a" }, { data: "x\ny" }, { data: "" }, { data: " two ", event: "named" }, { data: "tight" }],
				kind: "events",
			},
			stream: { retry: [null, null, null, null, null], yields: 5 },
		})
	})

	/* new: C# sse.parse.test.ts:460 */
	it("strips a BOM only at the stream's start: one before a later field leaves that line an unknown field", async () => {
		const { run } = await drive([sse(["data: a\n\n﻿data: b\n\ndata: c\n\n"])], [text()])
		expect(callOf(run), run.stderr).toEqual({ observed: strings("a", "c"), stream: { retry: [null, null], yields: 2 } })
	})
})
