/**
 * SSE framing through the emitted C# SDK (contract 50 §5.2, Python's `sse.parse.test.ts` analog), driven against
 * the registry `sse` document's `text.stream` and typed `ticks.stream`: CRLF, LF and CR line endings and no other
 * line break; a CR-terminated event dispatched at once; the same events however the stream is chunked, a UTF-8
 * sequence split across writes included; the 1 MiB line and 8 MiB event caps, counted in bytes, each raised once
 * as a `DecodeException`; the id and retry fields, comments, multi-line data and the BOM. The parser is internal,
 * so two consumer programs reach it through an in-memory `ClientConfig.Handler` handing out exactly the chunks
 * given: the events a capped chunk completed first, and data lines that join in linear time, timed in process.
 */
import { describe, expect, it } from "vitest"
import type { Call, Observed } from "../../../tests/integration/conformance/matrix.ts"
import type { CsError } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import type { SseScript, SseStep } from "../shared/__fixtures__/sse-steps.ts"
import { compiledCSharp } from "./__fixtures__/compiled.ts"
import { clientOf, program, type Run } from "./__fixtures__/consumer.ts"
import { withDotnet } from "./__fixtures__/csharp-env.ts"
import { type DrivenCSharpSdk, drivenCSharpSdk } from "./__fixtures__/driven.ts"

/** Whether .NET is here: a missing SDK fails where it is required and skips these legs elsewhere (csharp-env). */
const DOTNET = withDotnet()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

type Events = Extract<Observed, { kind: "events" }>

let compiled: DrivenCSharpSdk | undefined

/** The registry `sse` SDK with the test driver, gated once per file; it must build. */
function sdk(): DrivenCSharpSdk {
	compiled ??= drivenCSharpSdk("sse")
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
const errorOf = (error?: CsError) => error && { text: error.text, type: error.type, via: error.via }
/** An event with data over 64 characters shown as its length, so a cap leg's diff stays readable. */
const sized = (event: Events["events"][number]) =>
	typeof event.data === "string" && event.data.length > 64 ? { ...event, data: `<${event.data.length} chars>` } : event

/**
 * Call `i` of `run` as the legs pin it: its observed events (sized), its stream trace and its error. toEqual skips
 * an undefined member, so an expected value without `error` holds only when the call raised none.
 */
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

describe.skipIf(!DOTNET)("C# SSE framing: line endings", SLOW, () => {
	/* ported: python sse.parse.test.ts:93 */
	it("strips a leading BOM, keeps a value's trailing space, and ends lines on CR alone", async () => {
		const { run } = await drive([sse(["﻿data: first\n\ndata: tok \n\ndata: cr\r\r"])], [text()])
		expect(callOf(run), run.stderr).toEqual({
			observed: strings("first", "tok ", "cr"),
			stream: { retry: [null, null, null], yields: 3 },
		})
	})

	/* ported: python sse.parse.test.ts:104 */
	it("splits events on CRLF and on LF alike, and discards a final event without its blank line", async () => {
		const { hops, run } = await drive([sse(["data: a\r\n\r\ndata: b\n\ndata: partial"])], [text()])
		expect({ ...callOf(run), hops: hops.length }, run.stderr).toEqual({
			hops: 1,
			observed: strings("a", "b"),
			stream: { retry: [null, null], yields: 2 },
		})
	})

	/* ported: python sse.parse.test.ts:113 */
	it("ends a line on CR alone between data lines, and a CR CR or CRLF CRLF ends the event", async () => {
		const { run } = await drive([sse(["data: a\rdata: b\r\rdata: c\r\n\r\n"])], [text()])
		expect(callOf(run), run.stderr).toEqual({
			observed: strings("a\nb", "c"),
			stream: { retry: [null, null], yields: 2 },
		})
	})

	/* ported: python sse.parse.test.ts:123 (v0's H55 value U+2028, then the line breaks .NET's
	 * string.ReplaceLineEndings honors (NEL, FF, U+2029) and Python's splitlines adds (VT, FS)) */
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

describe.skipIf(!DOTNET)("C# SSE framing: a CR-terminated event dispatches at once", SLOW, () => {
	/* ported: python sse.parse.test.ts:141. One unbounded open first (per-call timeout 0): .NET's first request
	 * on a starved core pays JIT and the connect inside the timed window, so each timed open is a later one */
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

describe.skipIf(!DOTNET)("C# SSE framing: the same events however the stream is chunked", SLOW, () => {
	/* ported: python sse.parse.test.ts:165 */
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

	/* ported: python sse.parse.test.ts:206 */
	it("decodes a two-byte sequence written in two halves as one character, never two replacement characters", async () => {
		const { run } = await drive([sse([bytes("data: ", 0xc3), { waitMs: 50 }, bytes(0xa9, "\n\n")])], [text()])
		expect(callOf(run), run.stderr).toEqual({ observed: strings("é"), stream: { retry: [null], yields: 1 } })
	})
})

describe.skipIf(!DOTNET)("C# SSE framing: the 1 MiB line cap, in bytes", SLOW, () => {
	/* ported: python sse.parse.test.ts:219 (b603d680f0's value: a parser that raised its cap on every chunk past
	 * it, then delivered the 3 MiB line once its blank line came) */
	it("refuses v0's 3 MiB line with the line cap's error, raised once, and no event", async () => {
		const chunk = "x".repeat(64 * 1024)
		const { run } = await drive([sse(["data: ", ...Array.from({ length: 48 }, () => chunk), "\n\n"])], [text()])
		expect(callOf(run), run.stderr).toEqual({ error: LINE_CAP, observed: NONE, stream: { yields: 1 } })
		expect(run.trace?.calls[0]?.elapsedMs).toBeLessThan(PAYLOAD_MS)
	})

	/* ported: python sse.parse.test.ts:233 */
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

	/* ported: python sse.parse.test.ts:253 (V0BUG: v0's _sse.py counted a line's characters, not its bytes). Red
	 * under M16, a line cap counted in chars (string.Length or a decoded char buffer): 400,000 chars pass it */
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

describe.skipIf(!DOTNET)("C# SSE framing: the 8 MiB event cap, and the events a cap keeps", SLOW, () => {
	/* ported: python sse.parse.test.ts:276 (V0BUG: v0's _sse.py counted a newline after every data line, one more
	 * than the join holds, so an event of exactly 8 MiB was refused) */
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

	/* ported: python sse.parse.test.ts:313. Over the wire this pins the outcome only: a socket read need not hold
	 * the event and the crossing together; the in-process leg below hands them over as one chunk (M5) */
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

/**
 * Beside `Program`: a primary that answers every request 200 `text/event-stream` over `Chunks`, a body that hands
 * out the given chunks one per read (a chunk larger than the reader's buffer as consecutive reads, never two
 * chunks in one read), in memory: no socket, no server.
 */
const CHUNKED = `
internal sealed class Chunked(byte[][] chunks) : System.Net.Http.HttpMessageHandler
{
    protected override Task<System.Net.Http.HttpResponseMessage> SendAsync(System.Net.Http.HttpRequestMessage request, System.Threading.CancellationToken token)
    {
        var content = new System.Net.Http.StreamContent(new Chunks(chunks));
        content.Headers.ContentType = new("text/event-stream");
        return Task.FromResult(new System.Net.Http.HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = content, RequestMessage = request });
    }
}

internal sealed class Chunks(byte[][] chunks) : System.IO.Stream
{
    private int _at;
    private int _offset;
    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override int Read(Span<byte> buffer)
    {
        if (_at == chunks.Length) return 0;
        var n = Math.Min(buffer.Length, chunks[_at].Length - _offset);
        chunks[_at].AsSpan(_offset, n).CopyTo(buffer);
        _offset += n;
        if (_offset == chunks[_at].Length) (_at, _offset) = (_at + 1, 0);
        return n;
    }
    public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));
    public override ValueTask<int> ReadAsync(Memory<byte> buffer, System.Threading.CancellationToken token = default) => new(Read(buffer.Span));
    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, System.Threading.CancellationToken token) => Task.FromResult(Read(buffer.AsSpan(offset, count)));
    public override void Flush() { }
    public override long Seek(long offset, System.IO.SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}
`

/** Consumer program `name` on `sse` (`body` in `Main`, CHUNKED beside `Program`), every answer in memory: its run. */
async function inMemory(name: string, body: string): Promise<Run> {
	const built = compiledCSharp("sse")
	if (!built.built) return { out: undefined, ran: false, stderr: built.diagnostics.join("\n") }
	const { client, namespace } = clientOf(built)
	const source = `// consumer ${name}: a test program, never shipped\n${program(namespace, client, body)}${CHUNKED}`
	const ran = await built.exec(source, "")
	const out = ran.status === 0 ? (JSON.parse(ran.stdout) as Record<string, string[]>) : undefined
	return { out, ran: ran.status === 0, stderr: ran.stderr }
}

/**
 * Each case's chunks in its own section through `Text.StreamAsync`: each event's data (over 16 characters, as its
 * length) until the end (`end`) or the first `HoneyException` (`<type>: <message>`).
 */
const PARSER = `var MiB = 1 << 20;
byte[] Ascii(string s) => System.Text.Encoding.ASCII.GetBytes(s);
byte[] Joined(byte[] a, byte[] b) => [.. a, .. b];
var ok = Ascii("data: ok\\n\\n");
var line = Ascii($"data: {new string('x', MiB - 6 + 1)}\\n\\n");
var oneEvent = Ascii(new System.Text.StringBuilder().Insert(0, $"data: {new string('x', 1_000_000)}\\n", 9).Append('\\n').ToString());
async Task Fed(string section, params byte[][] chunks)
{
    Section(section);
    using var c = Client(new ClientConfig { Handler = new Chunked(chunks) });
    try
    {
        await foreach (var e in await c.Text.StreamAsync())
        {
            Note(e.Data.Length <= 16 ? e.Data : $"<{e.Data.Length} chars>");
        }
        Note("end");
    }
    catch (HoneyException e) { Note($"{e.GetType().Name}: {e.Message}"); }
}
await Fed("event", Joined(ok, oneEvent));
await Fed("eventApart", ok, oneEvent);
await Fed("line", Joined(ok, line));
await Fed("lineApart", ok, line);`

/**
 * 1,024 events of 12,500 `data: x` lines and 64 of 200,000 (the same 12.8 M lines, 16x longer events), in memory in
 * 64 KiB chunks as a socket hands them over; per size, the best of five rounds (one, once a round passes 5 s) of the
 * process CPU time (TotalProcessorTime, never the wall clock, which a loaded core time-slices) to enumerate the
 * streams, all opened before it starts (the parse and the join, never the open or any wire); each size's event
 * lengths, then the per-line cost at 16x the event length over the per-line cost at 1x, then each size's CPU ms.
 */
const LINES = `Section("lines");
var best = new List<double>();
var cpu = new List<string>();
foreach (var (lines, streams) in new[] { (12_500, 1024), (200_000, 64) })
{
    var body = System.Text.Encoding.ASCII.GetBytes(new System.Text.StringBuilder().Insert(0, "data: x\\n", lines).Append('\\n').ToString());
    var chunks = new List<byte[]>();
    for (var at = 0; at < body.Length; at += 65536)
    {
        chunks.Add(body[at..Math.Min(at + 65536, body.Length)]);
    }
    using var c = Client(new ClientConfig { Handler = new Chunked([.. chunks]) });
    var (fastest, sizes) = (double.MaxValue, new SortedSet<int>());
    for (var round = 0; round < 5; round++)
    {
        var opened = new List<EventStream<string>>();
        for (var i = 0; i < streams; i++)
        {
            opened.Add(await c.Text.StreamAsync());
        }
        var started = System.Diagnostics.Process.GetCurrentProcess().TotalProcessorTime;
        foreach (var stream in opened)
        {
            await foreach (var e in stream)
            {
                sizes.Add(e.Data.Length);
            }
        }
        var took = (System.Diagnostics.Process.GetCurrentProcess().TotalProcessorTime - started).TotalSeconds;
        fastest = Math.Min(fastest, took);
        if (took > 5) break;
    }
    Note($"{lines} lines: [{string.Join(", ", sizes)}]");
    cpu.Add($"{fastest * 1000:F0}");
    best.Add(fastest / ((double)lines * streams));
}
Note($"ratio {(best[1] / best[0]).ToString("F2", System.Globalization.CultureInfo.InvariantCulture)}");
Section("cpu");
foreach (var ms in cpu) Note(ms);`

describe.skipIf(!DOTNET)("C# SSE framing: the shipped parser in process, caps and data lines", SLOW, () => {
	/* ported: python sse.parse.test.ts:402. Red under M5, a cap checked after the chunk's events are dropped:
	 * together, the cap's chunk also completed "ok" */
	it("yields the event one chunk completed before an over-cap line or event, then the cap's error, as when fed apart", async () => {
		const run = await inMemory("parser", PARSER)
		const line = ["ok", "DecodeException: an event-stream line exceeds 1 MiB"]
		const event = ["ok", "DecodeException: an event's data exceeds 8 MiB"]
		expect({ out: run.out, ran: run.ran }, run.stderr).toEqual({
			out: { event, eventApart: event, line, lineApart: line },
			ran: true,
		})
	})

	/* ported: python sse.parse.test.ts:413. Red under M4, a `string +` data join (Q-d13: per-line ratio 27.93
	 * against 0.71 linear). A per-line cost that holds at 16× the lines is linear, one that grows 16× is
	 * quadratic, so the guard allows 4× and needs no machine's absolute speed; timed in process, no HTTP hides it */
	it("accumulates data lines in linear time: 16× the lines cost a line under 4× more", async () => {
		const run = await inMemory("lines", LINES)
		const notes = run.out?.lines ?? []
		const ratio = Number(/^ratio (\S+)$/.exec(notes.at(-1) ?? "")?.[1])
		/* each window well above the CPU clock's tick (about 15 ms), or the short one quantizes */
		expect(
			(run.out?.cpu ?? []).map((ms) => Number(ms) >= 30),
			notes.join("\n"),
		).toEqual([true, true])
		expect({ ran: run.ran, sizes: notes.slice(0, -1) }, run.stderr).toEqual({
			ran: true,
			sizes: ["12500 lines: [24999]", "200000 lines: [399999]"],
		})
		expect(ratio, notes.join("\n")).toBeLessThan(4)
	})
})

describe.skipIf(!DOTNET)("C# SSE framing: the id and retry fields", SLOW, () => {
	/* ported: python sse.parse.test.ts:426 */
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

	/* ported: python sse.parse.test.ts:441 (char.IsDigit takes "٣", int.Parse takes " 7" and "-1": neither is
	 * ASCII digits only) */
	it("takes retry from ASCII digits only, per event: a negative, fractional, non-numeric, non-ASCII or empty value is none", async () => {
		const values = ["3000", "-1", "1.5", "x", "0042", "", " 7", "²", "٣"]
		const steps = values.map((value, i) => `${value === "" ? "retry:" : `retry: ${value}`}\ndata: ${i}\n\n`)
		const { run } = await drive([sse([...steps, "data: none\n\n"])], [text()])
		expect(callOf(run), run.stderr).toEqual({
			observed: strings(...values.map((_, i) => String(i)), "none"),
			stream: { retry: [3000, null, null, null, 42, null, null, null, null, null], yields: 10 },
		})
	})
})

describe.skipIf(!DOTNET)("C# SSE framing: the rest of the WHATWG interpretation", SLOW, () => {
	/* ported: python sse.parse.test.ts:456 */
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

	/* ported: python sse.parse.test.ts:479 */
	it("strips a BOM only at the stream's start: one before a later field leaves that line an unknown field", async () => {
		const { run } = await drive([sse(["data: a\n\n﻿data: b\n\ndata: c\n\n"])], [text()])
		expect(callOf(run), run.stderr).toEqual({ observed: strings("a", "c"), stream: { retry: [null, null], yields: 2 } })
	})
})
