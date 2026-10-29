/**
 * SSE framing through the emitted Rust SDK (contract 20 §5.3, the Go `sse.parse.test.ts` analog), driven
 * against the registry `sse` document's `text.stream` and typed `ticks.stream`: CRLF, LF and CR line
 * endings; a CR-terminated event dispatched without waiting for another byte; the same events however
 * the stream is chunked, a UTF-8 sequence split across writes included; the 1 MiB line and 8 MiB event
 * caps and their errors (and, fed to the shipped parser directly, the events a capped chunk completed
 * first); the id and retry fields; comments, multi-line data and the BOM.
 */
import { describe, expect, it } from "vitest"
import type { Call, Observed } from "../../../tests/integration/conformance/matrix.ts"
import type { RustError } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import type { SseStep } from "../shared/__fixtures__/sse-steps.ts"
import { compiledRust } from "./__fixtures__/compiled.ts"
import { type DrivenRustSdk, drivenRustSdk } from "./__fixtures__/driven.ts"
import { withRust } from "./__fixtures__/rust-env.ts"

/** Whether Rust is here: a missing toolchain fails where it is required and skips these legs elsewhere (rust-env). */
const RUST = withRust()
const rustDescribe = describe.skipIf(!RUST)

type Events = Extract<Observed, { kind: "events" }>

let compiled: DrivenRustSdk | undefined

/** The registry `sse` SDK with the test driver, compiled once per file; it must build. */
function sdk(): DrivenRustSdk {
	compiled ??= drivenRustSdk("sse")
	expect({ built: compiled.built }, compiled.stderr).toEqual({ built: true })
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

/** `calls` run against a server answering `replies`, scripted so each call is traced: the run and its hops. */
async function drive(replies: readonly Reply[], calls: readonly Call[]) {
	const driven = sdk()
	return served(replies, async (server) => {
		const run = await driven.runCalls({ calls }, server, {})
		return { hops: [...server.hops], run }
	})
}

/** A call's error as these legs pin it: its variant, its text and where it came from. */
function errorOf(error: RustError | undefined) {
	if (error === undefined) return undefined
	return { text: error.text, variant: error.variant, via: error.via }
}

const MiB = 2 ** 20
const LINE_CAP = { text: "decode: an event-stream line exceeds 1 MiB", variant: "Decode", via: "stream" }
const EVENT_CAP = { text: "decode: an event's data exceeds 8 MiB", variant: "Decode", via: "stream" }

rustDescribe("SSE framing through the emitted Rust SDK: line endings", () => {
	// v0: 8d24ba163e
	it("strips a leading BOM, keeps a value's trailing space, and ends lines on CR alone (v0's values)", async () => {
		const { run } = await drive([sse(["﻿data: first\n\ndata: tok \n\ndata: cr\r\r"])], [text()])
		expect({ observed: run.observed, stream: run.trace?.calls[0]?.stream }, run.stderr).toEqual({
			observed: [
				{ events: [{ data: "first" }, { data: "tok " }, { data: "cr" }], kind: "events" },
			] satisfies Observed[],
			stream: { retry: [null, null, null], yields: 3 },
		})
		expect(run.trace?.calls[0]?.error).toBeUndefined()
	}, 600_000)

	it("splits events on CRLF and on LF alike, and discards a final event without its blank line", async () => {
		const { hops, run } = await drive([sse(["data: a\r\n\r\ndata: b\n\ndata: partial"])], [text()])
		expect({ observed: run.observed, stream: run.trace?.calls[0]?.stream }, run.stderr).toEqual({
			observed: [{ events: [{ data: "a" }, { data: "b" }], kind: "events" }] satisfies Observed[],
			stream: { retry: [null, null], yields: 2 },
		})
		expect({ error: run.trace?.calls[0]?.error, hops: hops.length }).toEqual({ error: undefined, hops: 1 })
	}, 600_000)

	it("ends a line on CR alone between data lines, and a CR CR or CRLF CRLF ends the event", async () => {
		const { run } = await drive([sse(["data: a\rdata: b\r\rdata: c\r\n\r\n"])], [text()])
		expect(run.observed, run.stderr).toEqual([
			{ events: [{ data: "a\nb" }, { data: "c" }], kind: "events" },
		] satisfies Observed[])
		expect(run.trace?.calls[0]?.error).toBeUndefined()
	}, 600_000)
})

rustDescribe("SSE framing through the emitted Rust SDK: a CR-terminated event dispatches at once", () => {
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
	}, 600_000)
})

/** The stream every chunking below writes: a CRLF event, a CR-split one with an id, a comment, then two multi-byte events. */
const WHOLE = "data: a\r\n\r\nid: 7\ndata: b\rdata: c\r\r: note\r\ndata: é\n\ndata: 😀\n\n"
const CHUNKED_EVENTS = [{ data: "a" }, { data: "b\nc", id: "7" }, { data: "é", id: "7" }, { data: "😀", id: "7" }]

rustDescribe("SSE framing through the emitted Rust SDK: the same events however the stream is chunked", () => {
	// v0: 919373a9a2
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
		const replies = [sse([WHOLE]), sse(split), sse(bytewise)]
		const { run } = await drive(replies, [text(), text(), text()])
		const seen = { events: CHUNKED_EVENTS, kind: "events" } satisfies Observed
		expect(run.observed, run.stderr).toEqual([seen, seen, seen])
		expect(run.trace?.calls.map((call) => [call.error, call.stream?.yields])).toEqual([
			[undefined, 4],
			[undefined, 4],
			[undefined, 4],
		])
	}, 600_000)

	// v0: 919373a9a2
	it("decodes a two-byte sequence written in two halves as one character, never two replacement characters", async () => {
		const reply = sse([bytes("data: ", 0xc3), { waitMs: 50 }, bytes(0xa9, "\n\n")])
		const { run } = await drive([reply], [text()])
		expect({ error: run.trace?.calls[0]?.error, observed: run.observed }, run.stderr).toEqual({
			error: undefined,
			observed: [{ events: [{ data: "é" }], kind: "events" }] satisfies Observed[],
		})
	}, 600_000)
})

rustDescribe("SSE framing through the emitted Rust SDK: the 1 MiB line cap", () => {
	// v0: b603d680f0
	it("refuses v0's 3 MiB line with the line cap's error and no event, never buffering it whole", async () => {
		const chunk = "x".repeat(64 * 1024)
		const steps = ["data: ", ...Array.from({ length: 48 }, () => chunk), "\n\n"]
		const started = Date.now()
		const { run } = await drive([sse(steps)], [text()])
		const call = run.trace?.calls[0]
		expect({ observed: run.observed, stream: call?.stream }, run.stderr).toEqual({
			observed: [{ events: [], kind: "events" }] satisfies Observed[],
			stream: { yields: 1 },
		})
		expect(errorOf(call?.error)).toEqual(LINE_CAP)
		expect(Date.now() - started).toBeLessThan(30_000)
	}, 600_000)

	it("delivers a line of exactly 1 MiB, and ends a longer one with the line cap's error after the events before it", async () => {
		const exact = "x".repeat(MiB - "data: ".length)
		const replies = [sse(["data: ok\n\n", `data: ${exact}x\n\n`, "data: never\n\n"]), sse([`data: ${exact}\n\n`])]
		const { run } = await drive(replies, [text(), text()])
		const [over, fits] = run.trace?.calls ?? []
		const [overSeen, fitsSeen] = (run.observed ?? []) as Events[]
		expect({ over: overSeen, stream: over?.stream }, run.stderr).toEqual({
			over: { events: [{ data: "ok" }], kind: "events" },
			stream: { retry: [null], yields: 2 },
		})
		expect(errorOf(over?.error)).toEqual(LINE_CAP)
		expect({
			error: fits?.error,
			events: fitsSeen?.events.map((event) => event.data === exact),
			stream: fits?.stream,
		}).toEqual({ error: undefined, events: [true], stream: { retry: [null], yields: 1 } })
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

rustDescribe("SSE framing through the emitted Rust SDK: the 8 MiB event cap", () => {
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
	}, 600_000)
})

rustDescribe("SSE framing through the emitted Rust SDK: a cap keeps the events completed before it", () => {
	/*
	 * V0BUG: v0's SseParser::feed returned Err for the whole chunk, dropping the events it had completed in
	 * it (v0 at 1a968f1: src/client-rust/sse.rs:42-67), and phase b kept that shape (sse.rs feed). Over the wire this
	 * leg pins the outcome only: hyper hands over at most 417,792 B a read (DEFAULT_MAX_BUFFER_SIZE), and
	 * the event ends at least 1 MiB before the cap is crossed, so the two never share a chunk.
	 */
	it("delivers a complete event written in the same write as an over-cap line or event, then the cap's error", async () => {
		const line = `data: ok\n\ndata: ${"x".repeat(MiB - "data: ".length + 1)}\n\n`
		const event = `data: ok\n\n${eventOf(8 * MiB + 1).text}`
		const { run } = await drive([sse([line]), sse([event])], [text(), text()])
		expect({ observed: run.observed, streams: run.trace?.calls.map((call) => call.stream) }, run.stderr).toEqual({
			observed: [
				{ events: [{ data: "ok" }], kind: "events" },
				{ events: [{ data: "ok" }], kind: "events" },
			] satisfies Observed[],
			streams: [
				{ retry: [null], yields: 2 },
				{ retry: [null], yields: 2 },
			],
		})
		expect(run.trace?.calls.map((call) => errorOf(call.error))).toEqual([LINE_CAP, EVENT_CAP])
	}, 600_000)
})

/**
 * The shipped `sse.rs` alone in a bin of the crate copy (`src/bin/<name>.rs`, so `../sse.rs` is the crate's own),
 * beside a stub of the one error it builds. Each case is fed as given, then one empty chunk, where a deferred error
 * surfaces; `Fed` reads either shape `feed` may return. It prints each case's event data and the first error's text.
 */
const PARSER = `#[allow(dead_code)]
#[path = "../sse.rs"]
mod sse;

mod errors {
    #[derive(Debug)]
    pub enum Error {
        Decode(String),
    }

    impl Error {
        pub fn decode(m: impl std::fmt::Display) -> Self {
            Error::Decode(m.to_string())
        }
    }
}

use errors::Error;
use sse::{SseEvent, SseParser};

trait Fed {
    fn split(self) -> (Vec<SseEvent>, Option<Error>);
}

impl Fed for Result<Vec<SseEvent>, Error> {
    fn split(self) -> (Vec<SseEvent>, Option<Error>) {
        match self {
            Ok(events) => (events, None),
            Err(e) => (Vec::new(), Some(e)),
        }
    }
}

impl Fed for (Vec<SseEvent>, Option<Error>) {
    fn split(self) -> (Vec<SseEvent>, Option<Error>) {
        self
    }
}

fn run(chunks: &[String]) -> serde_json::Value {
    let mut parser = SseParser::default();
    let (mut data, mut error) = (Vec::new(), None);
    for chunk in chunks.iter().map(String::as_bytes).chain([&b""[..]]) {
        let (events, failed) = parser.feed(chunk).split();
        data.extend(events.into_iter().map(|e| e.data));
        error = failed.map(|Error::Decode(m)| m);
        if error.is_some() {
            break;
        }
    }
    serde_json::json!({ "data": data, "error": error })
}

fn main() {
    let ok = String::from("data: ok\\n\\n");
    let line = format!("data: {}\\n\\n", "x".repeat((1 << 20) - "data: ".len() + 1));
    let event = format!("{}\\n", format!("data: {}\\n", "x".repeat(1_000_000)).repeat(9));
    let cases = serde_json::json!({
        "event": run(&[format!("{ok}{event}")]),
        "eventApart": run(&[ok.clone(), event.clone()]),
        "line": run(&[format!("{ok}{line}")]),
        "lineApart": run(&[ok, line]),
    });
    println!("{cases}");
}
`

rustDescribe("the shipped event-stream parser: a cap keeps the events its chunk completed before it", () => {
	/* V0BUG: v0's SseParser::feed returned Err for the whole chunk, dropping the events it had completed in it (v0 at 1a968f1: src/client-rust/sse.rs:42-67); phase b kept that shape */
	it("yields the event one chunk completed before an over-cap line or event, then the cap's error, as when fed apart", async () => {
		const crate = compiledRust("sse", { programs: { parser: PARSER } })
		expect({ built: crate.built }, crate.stderr).toEqual({ built: true })
		const ran = await crate.exec("parser", "")
		expect({ status: ran.status }, ran.stderr).toEqual({ status: 0 })
		const line = { data: ["ok"], error: "an event-stream line exceeds 1 MiB" }
		const event = { data: ["ok"], error: "an event's data exceeds 8 MiB" }
		expect(JSON.parse(ran.stdout)).toEqual({ event, eventApart: event, line, lineApart: line })
	}, 600_000)
})

rustDescribe("SSE framing through the emitted Rust SDK: the id and retry fields", () => {
	// v0: 92e893617f
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
	}, 600_000)

	// v0: 9b8877d863
	it("takes retry from ASCII digits only, per event: a negative, fractional, non-numeric or empty value is none", async () => {
		const values = ["3000", "-1", "1.5", "x", "0042", "", " 7"]
		const steps = values.map((value, i) => `${value === "" ? "retry:" : `retry: ${value}`}\ndata: ${i}\n\n`)
		const { run } = await drive([sse([...steps, "data: none\n\n"])], [text()])
		expect({ observed: run.observed, stream: run.trace?.calls[0]?.stream }, run.stderr).toEqual({
			observed: [
				{ events: [...values.map((_, i) => ({ data: String(i) })), { data: "none" }], kind: "events" },
			] satisfies Observed[],
			stream: { retry: [3000, null, null, null, 42, null, null, null], yields: 8 },
		})
		expect(run.trace?.calls[0]?.error).toBeUndefined()
	}, 600_000)
})

rustDescribe("SSE framing through the emitted Rust SDK: the rest of the WHATWG interpretation", () => {
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
	}, 600_000)

	it("strips a BOM only at the stream's start: one before a later field leaves that line an unknown field", async () => {
		const { run } = await drive([sse(["data: a\n\n﻿data: b\n\ndata: c\n\n"])], [text()])
		expect(run.observed, run.stderr).toEqual([
			{ events: [{ data: "a" }, { data: "c" }], kind: "events" },
		] satisfies Observed[])
	}, 600_000)
})
