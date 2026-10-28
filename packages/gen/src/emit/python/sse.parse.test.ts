/**
 * SSE framing through the emitted Python SDK (contract 34 §6.2, Rust's `sse.parse.test.ts` analog), driven on
 * `AsyncSDK` (streams are its alone, G2) against the registry `sse` document's `text.stream` and typed
 * `ticks.stream`: CRLF, LF and CR line endings and no other line break; a CR-terminated event dispatched without
 * waiting for another byte; the same events however the stream is chunked, a UTF-8 sequence split across writes
 * included; the 1 MiB line and 8 MiB event caps, counted in bytes, and their errors, each raised once; and the id
 * and retry fields, comments, multi-line data and the BOM. Consumer programs on `sse` feed the shipped parser
 * (`_honey.sse.SseParser`) directly: the events a capped chunk completed first, and data lines that accumulate in
 * linear time.
 */
import { describe, expect, it } from "vitest"
import type { Call, Observed } from "../../../tests/integration/conformance/matrix.ts"
import type { PythonError } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import type { SseStep } from "../shared/__fixtures__/sse-steps.ts"
import { consume, once } from "./__fixtures__/consumer.ts"
import { type DrivenPythonSdk, drivenPythonSdk } from "./__fixtures__/driven.ts"
import { withPython } from "./__fixtures__/python-env.ts"

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()
/** Every executed describe's bound: a cold gate builds the venv and the package first. */
const SLOW = { timeout: 600_000 }

type Events = Extract<Observed, { kind: "events" }>

let compiled: DrivenPythonSdk | undefined

/** The registry `sse` SDK with the test driver, gated once per file; it must import. */
function sdk(): DrivenPythonSdk {
	compiled ??= drivenPythonSdk("sse")
	expect({ imported: compiled.imported }, compiled.stderr).toEqual({ imported: true })
	return compiled
}

const text = (extra: Partial<Call> = {}): Call => ({
	operation: "text.stream",
	route: { method: "GET", path: "/text" },
	...extra,
})
const ticks = (extra: Partial<Call> = {}): Call => ({
	operation: "ticks.stream",
	route: { method: "GET", path: "/ticks" },
	...extra,
})
const sse = (steps: readonly SseStep[], end: "close" | "drop" | "hold" = "close"): Reply => ({
	sse: { end, steps },
	status: 200,
})
/** A `bytes` step: these bytes written as one chunk, so a UTF-8 sequence can be split across writes. */
const bytes = (...chunk: readonly (number | string)[]): SseStep => ({
	bytes: Buffer.concat(
		chunk.map((part) => (typeof part === "string" ? Buffer.from(part) : Buffer.from([part]))),
	).toString("base64"),
})

/** `calls` run on `AsyncSDK` against a server answering `replies`, scripted so each call is traced: the run and its hops. */
async function drive(replies: readonly Reply[], calls: readonly Call[]) {
	const driven = sdk()
	return served(replies, async (server) => {
		const run = await driven.runCalls({ calls }, { url: server.url }, { client: "async", script: {} })
		return { hops: [...server.hops], run }
	})
}

/** A call's error as these legs pin it: its type, its text and where it came from. */
function errorOf(error: PythonError | undefined) {
	if (error === undefined) return undefined
	return { text: error.text, type: error.type, via: error.via }
}

/** `observed` with each event's data over 64 characters shown as its length, so a cap leg's diff stays readable. */
function shown(observed: readonly unknown[] | undefined) {
	return (observed as (Events | null)[] | undefined)?.map((o) =>
		o?.kind !== "events"
			? o
			: {
					...o,
					events: o.events.map((event) =>
						typeof event.data === "string" && event.data.length > 64
							? { ...event, data: `<${event.data.length} chars>` }
							: event,
					),
				},
	)
}

const MiB = 2 ** 20
const LINE_CAP = { text: "an event-stream line exceeds 1 MiB", type: "DecodeError", via: "stream" }
const EVENT_CAP = { text: "an event's data exceeds 8 MiB", type: "DecodeError", via: "stream" }

describe.skipIf(!PY)("SSE framing through the emitted Python SDK: line endings", SLOW, () => {
	it("strips a leading BOM, keeps a value's trailing space, and ends lines on CR alone", async () => {
		const { run } = await drive([sse(["﻿data: first\n\ndata: tok \n\ndata: cr\r\r"])], [text()])
		expect({ observed: run.observed, stream: run.trace?.calls[0]?.stream }, run.stderr).toEqual({
			observed: [
				{ events: [{ data: "first" }, { data: "tok " }, { data: "cr" }], kind: "events" },
			] satisfies Observed[],
			stream: { retry: [null, null, null], yields: 3 },
		})
		expect(run.trace?.calls[0]?.error).toBeUndefined()
	})

	it("splits events on CRLF and on LF alike, and discards a final event without its blank line", async () => {
		const { hops, run } = await drive([sse(["data: a\r\n\r\ndata: b\n\ndata: partial"])], [text()])
		expect({ observed: run.observed, stream: run.trace?.calls[0]?.stream }, run.stderr).toEqual({
			observed: [{ events: [{ data: "a" }, { data: "b" }], kind: "events" }] satisfies Observed[],
			stream: { retry: [null, null], yields: 2 },
		})
		expect({ error: run.trace?.calls[0]?.error, hops: hops.length }).toEqual({ error: undefined, hops: 1 })
	})

	it("ends a line on CR alone between data lines, and a CR CR or CRLF CRLF ends the event", async () => {
		const { run } = await drive([sse(["data: a\rdata: b\r\rdata: c\r\n\r\n"])], [text()])
		expect(run.observed, run.stderr).toEqual([
			{ events: [{ data: "a\nb" }, { data: "c" }], kind: "events" },
		] satisfies Observed[])
		expect(run.trace?.calls[0]?.error).toBeUndefined()
	})

	/* v0's H55 value (U+2028), then every other line break Python's str.splitlines honors and the stream does not */
	// v0: 21fa9e2b0d
	it("splits lines only on CR and LF: U+2028, U+2029, NEL, VT, FF and FS stay inside the data", async () => {
		const breaks = [" ", " ", "\u0085", "\u000B", "\u000C", "\u001C"]
		const steps = breaks.map((mark) => `data: {"t":"a${mark}b"}\n\n`)
		const { run } = await drive([sse(steps)], [text()])
		expect({ observed: run.observed, stream: run.trace?.calls[0]?.stream }, run.stderr).toEqual({
			observed: [
				{ events: breaks.map((mark) => ({ data: `{"t":"a${mark}b"}` })), kind: "events" },
			] satisfies Observed[],
			stream: { retry: breaks.map(() => null), yields: breaks.length },
		})
		expect(run.trace?.calls[0]?.error).toBeUndefined()
	})
})

describe.skipIf(!PY)(
	"SSE framing through the emitted Python SDK: a CR-terminated event dispatches at once",
	SLOW,
	() => {
		it("yields an event ended by CR CR on a held stream without waiting for another byte, string and typed", async () => {
			const replies = [sse(["data: a\r\r"], "hold"), sse(['data: {"n":1}\r\r'], "hold")]
			const { run } = await drive(replies, [text({ take: 1 }), ticks({ take: 1 })])
			expect(run.observed, run.stderr).toEqual([
				{ events: [{ data: "a" }], kind: "events" },
				{ events: [{ data: { n: 1 } }], kind: "events" },
			] satisfies Observed[])
			const calls = run.trace?.calls ?? []
			expect(calls.map((call) => [call.error, call.elapsedMs < 1000])).toEqual([
				[undefined, true],
				[undefined, true],
			])
		})
	},
)

/** The stream every chunking below writes: a CRLF event, a CR-split one with an id, a comment, then two multi-byte events. */
const WHOLE = "data: a\r\n\r\nid: 7\ndata: b\rdata: c\r\r: note\r\ndata: é\n\ndata: 😀\n\n"
const CHUNKED_EVENTS = [{ data: "a" }, { data: "b\nc", id: "7" }, { data: "é", id: "7" }, { data: "😀", id: "7" }]

describe.skipIf(!PY)(
	"SSE framing through the emitted Python SDK: the same events however the stream is chunked",
	SLOW,
	() => {
		it("parses a field name, a CRLF and a UTF-8 sequence split across writes as it parses the whole stream", async () => {
			const pause = { waitMs: 50 }
			const [e1, e2] = [...Buffer.from("é")] as [number, number]
			const [f1, f2, f3, f4] = [...Buffer.from("😀")] as [number, number, number, number]
			const split: SseStep[] = [
				"da",
				pause,
				"ta: a\r",
				pause,
				"\n\r",
				pause,
				"\nid: 7\ndata: b\r",
				pause,
				"data: c\r",
				pause,
				"\r: no",
				pause,
				"te\r\n",
				bytes("data: ", e1),
				pause,
				bytes(e2, "\n\ndata: ", f1),
				pause,
				bytes(f2, f3),
				pause,
				bytes(f4, "\n\n"),
			]
			const joined = split.map((s) =>
				typeof s === "string" ? Buffer.from(s) : "bytes" in s ? Buffer.from(s.bytes, "base64") : "",
			)
			expect(Buffer.concat(joined.filter((b) => b !== "")).toString()).toBe(WHOLE)
			const bytewise = [...Buffer.from(WHOLE)].map((b) => bytes(b))
			const { run } = await drive([sse([WHOLE]), sse(split), sse(bytewise)], [text(), text(), text()])
			const seen = { events: CHUNKED_EVENTS, kind: "events" } satisfies Observed
			expect(run.observed, run.stderr).toEqual([seen, seen, seen])
			expect(run.trace?.calls.map((call) => [call.error, call.stream?.yields])).toEqual([
				[undefined, 4],
				[undefined, 4],
				[undefined, 4],
			])
		})

		it("decodes a two-byte sequence written in two halves as one character, never two replacement characters", async () => {
			const { run } = await drive([sse([bytes("data: ", 0xc3), { waitMs: 50 }, bytes(0xa9, "\n\n")])], [text()])
			expect({ error: run.trace?.calls[0]?.error, observed: run.observed }, run.stderr).toEqual({
				error: undefined,
				observed: [{ events: [{ data: "é" }], kind: "events" }] satisfies Observed[],
			})
		})
	},
)

describe.skipIf(!PY)("SSE framing through the emitted Python SDK: the 1 MiB line cap, in bytes", SLOW, () => {
	/* b603d680f0's value (a Rust id): the committed parser raised its cap on every chunk past it, and then
	 * delivered the 3 MiB line as an event once its blank line came (contract 34 §3.4 #6) */
	it("refuses v0's 3 MiB line with the line cap's error, raised once, and no event", async () => {
		const chunk = "x".repeat(64 * 1024)
		const steps = ["data: ", ...Array.from({ length: 48 }, () => chunk), "\n\n"]
		const started = Date.now()
		const { run } = await drive([sse(steps)], [text()])
		const call = run.trace?.calls[0]
		expect({ observed: shown(run.observed), stream: call?.stream }, run.stderr).toEqual({
			observed: [{ events: [], kind: "events" }],
			stream: { yields: 1 },
		})
		expect(errorOf(call?.error)).toEqual(LINE_CAP)
		expect(Date.now() - started).toBeLessThan(30_000)
	})

	it("delivers a line of exactly 1 MiB, and ends a longer one with the line cap's error after the events before it", async () => {
		const exact = "x".repeat(MiB - "data: ".length)
		const replies = [sse(["data: ok\n\n", `data: ${exact}x\n\n`, "data: never\n\n"]), sse([`data: ${exact}\n\n`])]
		const { run } = await drive(replies, [text(), text()])
		const [over, fits] = run.trace?.calls ?? []
		const fitsSeen = run.observed?.[1] as Events | undefined
		expect({ over: shown(run.observed)?.[0], stream: over?.stream }, run.stderr).toEqual({
			over: { events: [{ data: "ok" }], kind: "events" },
			stream: { retry: [null], yields: 2 },
		})
		expect(errorOf(over?.error)).toEqual(LINE_CAP)
		expect({
			error: fits?.error,
			events: fitsSeen?.events.map((event) => event.data === exact),
			stream: fits?.stream,
		}).toEqual({ error: undefined, events: [true], stream: { retry: [null], yields: 1 } })
	})

	/* V0BUG: v0's _sse.py counted a line's characters, not its bytes (v0 at 1a968f1: src/client-python/_sse.py:84-87), and
	 * raised a RuntimeError that reconnected a realtime stream (N-SSE-CAP); the committed parser kept the count */
	it("counts the line cap in bytes: 400,000 three-byte characters (1.2 MB, under 1 Mi characters) are refused", async () => {
		const { run } = await drive([sse([`data: ${"€".repeat(400_000)}\n\n`, "data: never\n\n"])], [text()])
		const call = run.trace?.calls[0]
		expect({ observed: shown(run.observed), stream: call?.stream }, run.stderr).toEqual({
			observed: [{ events: [], kind: "events" }],
			stream: { yields: 1 },
		})
		expect(errorOf(call?.error)).toEqual(LINE_CAP)
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

describe.skipIf(!PY)("SSE framing through the emitted Python SDK: the 8 MiB event cap", SLOW, () => {
	/* V0BUG: v0's _sse.py counted a newline after every data line, one more than the join holds, so an event of
	 * exactly 8 MiB was refused (v0 at 1a968f1: src/client-python/_sse.py:103-105); the committed parser kept the count */
	it("delivers an event of exactly 8 MiB, its joining newlines counted, and ends one over it with the event cap's error and no event", async () => {
		const limit = eventOf(8 * MiB)
		const over = eventOf(8 * MiB + 1)
		const nine = `${Array.from({ length: 9 }, () => `data: ${"x".repeat(1_000_000)}\n`).join("")}\n`
		const replies = [sse([limit.text]), sse([over.text]), sse([nine, "data: after\n\n"])]
		const started = Date.now()
		const { run } = await drive(replies, [text(), text(), text()])
		const seen = ((run.observed ?? []) as Events[]).map((o) => ({
			kind: o.kind,
			sizes: o.events.map((event) => (typeof event.data === "string" ? event.data.length : -1)),
		}))
		expect(seen, run.stderr).toEqual([
			{ kind: "events", sizes: [8 * MiB] },
			{ kind: "events", sizes: [] },
			{ kind: "events", sizes: [] },
		])
		const [fits, tooLarge, nineLines] = run.trace?.calls ?? []
		const first = (run.observed?.[0] as Events | undefined)?.events[0]
		expect({ error: fits?.error, exact: first?.data === limit.data, stream: fits?.stream }).toEqual({
			error: undefined,
			exact: true,
			stream: { retry: [null], yields: 1 },
		})
		expect([tooLarge, nineLines].map((call) => [errorOf(call?.error), call?.stream])).toEqual([
			[EVENT_CAP, { yields: 1 }],
			[EVENT_CAP, { yields: 1 }],
		])
		expect(Date.now() - started).toBeLessThan(30_000)
	})
})

describe.skipIf(!PY)(
	"SSE framing through the emitted Python SDK: a cap keeps the events completed before it",
	SLOW,
	() => {
		/* Over the wire this pins the outcome only: httpx2 hands over a socket read at a time, so the event and the
		 * crossing need not share a chunk; the shipped parser's leg below feeds them as one */
		it("delivers a complete event written in the same write as an over-cap line or event, then the cap's error", async () => {
			const line = `data: ok\n\ndata: ${"x".repeat(MiB - "data: ".length + 1)}\n\n`
			const event = `data: ok\n\n${eventOf(8 * MiB + 1).text}`
			const { run } = await drive([sse([line]), sse([event])], [text(), text()])
			expect(
				{ observed: shown(run.observed), streams: run.trace?.calls.map((call) => call.stream) },
				run.stderr,
			).toEqual({
				observed: [
					{ events: [{ data: "ok" }], kind: "events" },
					{ events: [{ data: "ok" }], kind: "events" },
				],
				streams: [
					{ retry: [null], yields: 2 },
					{ retry: [null], yields: 2 },
				],
			})
			expect(run.trace?.calls.map((call) => errorOf(call.error))).toEqual([LINE_CAP, EVENT_CAP])
		})
	},
)

/**
 * The shipped `_honey.sse` fed in process. `run` feeds each case's chunks, then one empty chunk, collecting each
 * event's data (over 16 characters, as its length) until the first error, kept as `<type>: <text>`.
 */
const PARSER = `import importlib

parsing = importlib.import_module(f"{sdk.__name__}._honey.sse")
MiB = 1 << 20


def run(chunks: list[bytes]) -> dict[str, object]:
    parser, data, error = parsing.SseParser(), [], None
    for chunk in [*chunks, b""]:
        try:
            for event in parser.feed(chunk):
                data.append(event.data if len(event.data) <= 16 else f"<{len(event.data)} chars>")
        except Exception as e:
            error = f"{type(e).__name__}: {e}"
            break
    return {"data": data, "error": error}


ok = b"data: ok\\n\\n"
line = b"data: " + b"x" * (MiB - len(b"data: ") + 1) + b"\\n\\n"
event = (b"data: " + b"x" * 1_000_000 + b"\\n") * 9 + b"\\n"
note({"event": run([ok + event]), "eventApart": run([ok, event]), "line": run([ok + line]), "lineApart": run([ok, line])})`

/**
 * Data lines through the shipped parser, in 64 KiB chunks as a socket hands them over: an event of 12,500
 * `data: x` lines and one of 200,000 (16×), the best of five rounds each (one, once a round passes 5 s). Each
 * size's event lengths, then the per-line cost at 16× the lines over the per-line cost at 1×.
 */
const LINES = `import gc
import importlib
import time

parsing = importlib.import_module(f"{sdk.__name__}._honey.sse")


def fed(lines: int) -> tuple[float, list[int]]:
    body, parser, sizes = b"data: x\\n" * lines + b"\\n", parsing.SseParser(), []
    started = time.perf_counter()
    for at in range(0, len(body), 65536):
        sizes.extend(len(event.data) for event in parser.feed(body[at : at + 65536]))
    return time.perf_counter() - started, sizes


best = []
gc.disable()
for lines in (12_500, 200_000):
    fastest, sizes = float("inf"), []
    for _ in range(5):
        took, sizes = fed(lines)
        fastest = min(fastest, took)
        if took > 5:
            break
    note(f"{lines} lines: {sizes}")
    best.append(fastest / lines)
gc.enable()
note(f"ratio {best[1] / best[0]:.2f}")`

const parser = once(() => consume("sse", "parser", { body: PARSER }))
const lines = once(() => consume("sse", "lines", { body: LINES }))

describe.skipIf(!PY)("the shipped event-stream parser: caps and data lines", SLOW, () => {
	/* The committed parser checked the line cap only on the line still held when a chunk ended, so an over-cap
	 * line completed inside one chunk passed (contract 34 §3.4 #4; v0's _append checked every part) */
	it("yields the event one chunk completed before an over-cap line or event, then the cap's error, as when fed apart", async () => {
		const run = await parser()
		expect({ ran: run.ran }, run.stderr).toEqual({ ran: true })
		const line = { data: ["ok"], error: "DecodeError: an event-stream line exceeds 1 MiB" }
		const event = { data: ["ok"], error: "DecodeError: an event's data exceeds 8 MiB" }
		expect(JSON.parse(run.out?.main?.[0] ?? "null")).toEqual({ event, eventApart: event, line, lineApart: line })
	})

	/* The committed parser rebuilt the data list on every line (contract 34 §3.4 #7: 200,000 lines took 15.7 s);
	 * v0 appended. A per-line cost that holds at 16× the lines is linear, one that grows 16× is quadratic, so the
	 * guard allows 4× and needs no machine's absolute speed */
	it("accumulates data lines in linear time: 16× the lines cost a line under 4× more", async () => {
		const run = await lines()
		const notes = run.out?.main ?? []
		const ratio = Number(/^ratio (\S+)$/.exec(notes.at(-1) ?? "")?.[1])
		expect({ ran: run.ran, sizes: notes.slice(0, -1) }, run.stderr).toEqual({
			ran: true,
			sizes: ["12500 lines: [24999]", "200000 lines: [399999]"],
		})
		expect(ratio, notes.join("\n")).toBeLessThan(4)
	})
})

describe.skipIf(!PY)("SSE framing through the emitted Python SDK: the id and retry fields", SLOW, () => {
	it("keeps the id sticky across events, ignores an id holding NUL, and clears it on an empty id", async () => {
		const steps = ["id: 1\ndata: a\n\nid: x\0y\ndata: b\n\ndata: c\n\nid:\ndata: d\n\n"]
		const { run } = await drive([sse(steps)], [text()])
		expect({ observed: run.observed, stream: run.trace?.calls[0]?.stream }, run.stderr).toEqual({
			observed: [
				{
					events: [{ data: "a", id: "1" }, { data: "b", id: "1" }, { data: "c", id: "1" }, { data: "d" }],
					kind: "events",
				},
			] satisfies Observed[],
			stream: { retry: [null, null, null, null], yields: 4 },
		})
		expect(run.trace?.calls[0]?.error).toBeUndefined()
	})

	it("takes retry from ASCII digits only, per event: a negative, fractional, non-numeric, non-ASCII or empty value is none", async () => {
		const values = ["3000", "-1", "1.5", "x", "0042", "", " 7", "²", "٣"]
		const steps = values.map((value, i) => `${value === "" ? "retry:" : `retry: ${value}`}\ndata: ${i}\n\n`)
		const { run } = await drive([sse([...steps, "data: none\n\n"])], [text()])
		expect({ observed: run.observed, stream: run.trace?.calls[0]?.stream }, run.stderr).toEqual({
			observed: [
				{ events: [...values.map((_, i) => ({ data: String(i) })), { data: "none" }], kind: "events" },
			] satisfies Observed[],
			stream: { retry: [3000, null, null, null, 42, null, null, null, null, null], yields: 10 },
		})
		expect(run.trace?.calls[0]?.error).toBeUndefined()
	})
})

describe.skipIf(!PY)("SSE framing through the emitted Python SDK: the rest of the WHATWG interpretation", SLOW, () => {
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
		expect({ observed: run.observed, stream: run.trace?.calls[0]?.stream }, run.stderr).toEqual({
			observed: [
				{
					events: [{ data: "a" }, { data: "x\ny" }, { data: "" }, { data: " two ", event: "named" }, { data: "tight" }],
					kind: "events",
				},
			] satisfies Observed[],
			stream: { retry: [null, null, null, null, null], yields: 5 },
		})
		expect(run.trace?.calls[0]?.error).toBeUndefined()
	})

	it("strips a BOM only at the stream's start: one before a later field leaves that line an unknown field", async () => {
		const { run } = await drive([sse(["data: a\n\n﻿data: b\n\ndata: c\n\n"])], [text()])
		expect(run.observed, run.stderr).toEqual([
			{ events: [{ data: "a" }, { data: "c" }], kind: "events" },
		] satisfies Observed[])
	})
})
