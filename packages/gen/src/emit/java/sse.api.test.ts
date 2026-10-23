/**
 * An SSE operation through the Java SDK's public API (bit 16 phase d1; C#'s `sse.test.ts` consumer legs): consumer programs
 * on the `sse` client open, read and close `EventStream<T>` (J1), javac holds its types, a refused open's error body is
 * read at most 64 KiB (J4), `raw` fills at the open (J6), a stream is read once, and its cursor is the last delivered id.
 * The emitted text: a stream method ignores throwOnError, and its javadoc and EventStream's say that a for-each `break`
 * needs try-with-resources (F1, condition a). The driven legs: `sse.test.ts`.
 */
import { describe, expect, it } from "vitest"
import { gone } from "../shared/__fixtures__/gone.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import type { SseScript } from "../shared/__fixtures__/sse-steps.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { type DrivenJavaSdk, drivenJavaSdk } from "./__fixtures__/driven.ts"
import { withJava } from "./__fixtures__/java-env.ts"
import { generateJavaSdk } from "./sdk.ts"

/** Whether Java is pinned here: a missing toolchain fails where it is required and skips these legs elsewhere. */
const JAVA = withJava()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

type Step = string | { waitMs: number }
const sse = (steps: readonly Step[], end: SseScript["end"] = "close"): Reply => ({ sse: { end, steps }, status: 200 })
const TICK = sse(['data: {"n":1}\n\n'])

/** The `sse` registry SDK, which must build. */
function driven(): DrivenJavaSdk {
	const sdk = drivenJavaSdk("sse")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

/** A consumer program on the `sse` client at `url` running `body`, each `note(…)` one line of its output. */
const consumer = (url: string, body: string) => `package probe;

import ai.anyrow.*;
import java.util.Iterator;

public class Probe {
  static void note(Object value) {
    System.out.println(value);
  }

  public static void main(String[] args) throws Exception {
    AnyrowClient c = AnyrowClient.builder().baseUrl("${url}").build();
${body
	.split("\n")
	.map((line) => `    ${line}`)
	.join("\n")}
  }
}
`

/** `body` run as a consumer program against a server answering `replies`: its output lines and exit status. */
async function consume(replies: readonly Reply[], body: string) {
	const sdk = driven()
	return served(replies, async (server) => {
		const ran = await sdk.exec("probe.Probe", consumer(server.url, body))
		return { out: ran.stdout.split("\n").filter((line) => line !== ""), ran, url: server.url }
	})
}

/**
 * A typed stream and two text ones, opened and read through the public API: the cursor before and after an id, the
 * stream as an `Iterable<SseEvent<Tick>>`. Each next open is the release point of the stream before it (gone.ts): the
 * typed one ends by try-with-resources alone (its iterator never ends), the second by a `break` inside
 * try-with-resources, and the third is read to its end.
 */
const TYPED = `try (EventStream<Tick> s = c.ticks().stream(TicksStreamParams.builder().build())) {
  note("[" + s.lastEventId() + "]");
  Iterator<SseEvent<Tick>> e = s.iterator();
  SseEvent<Tick> ev = e.next();
  note(ev.data().n() + " " + ev.id() + " " + s.lastEventId());
  Object o = s;
  note(o instanceof Iterable<?>);
}
try (EventStream<String> t = c.text().stream(TextStreamParams.builder().build())) {
  for (SseEvent<String> ev : t) {
    note(ev.data());
    break;
  }
}
EventStream<String> last = c.text().stream(TextStreamParams.builder().build());
for (SseEvent<String> ev : last) {
  note(ev.data());
}`

describe.skipIf(!JAVA)("an SSE method: it opens EventStream<T>, read once as an Iterable", SLOW, () => {
	/* new: C# sse.test.ts:131 (await using and break become try-with-resources, F1) */
	it("reads a typed event with its id and the stream's cursor; try-with-resources, with or without a break, lets the connection go", async () => {
		/* the second stream's answer waits until the typed stream's client left, the third's until the second's */
		const [afterTyped, afterText] = [gone(sse(["data: a\n\n"], "hold")), gone(sse(["data: z\n\n"]), { stream: 1 })]
		const replies = [sse(['id: 7\ndata: {"n":1}\n\n'], "hold"), afterTyped.reply, afterText.reply]
		const { out, ran } = await consume(replies, TYPED)
		const released = [afterTyped.released(), afterText.released()]
		expect({ out, released, status: ran.status }, ran.stderr).toEqual({
			out: ["[]", "1 7 7", "true", "a", "z"],
			released: [true, true],
			status: 0,
		})
	})

	/* new: C# sse.test.ts:145 (javac holds the types; a WebSocket cursor is no Params field) */
	it("types the methods EventStream<Tick> and EventStream<String>, and has no WebSocket cursor", () => {
		const source = consumer(
			"http://127.0.0.1:1",
			[
				"EventStream<String> s = c.ticks().stream(TicksStreamParams.builder().build());",
				'c.ticks().stream(TicksStreamParams.builder().reconnectToken("x").build());',
				'EventStream<Tick> u = c.ticks().stream(TicksStreamParams.builder().since(5L).lastEventId("7").build());',
				"for (SseEvent<Tick> ev : u) {",
				"  Tick data = ev.data();",
				"  String name = ev.event();",
				"  String id = ev.id();",
				"  java.time.Duration retry = ev.retry();",
				"}",
				"String cursor = u.lastEventId();",
				"EventStream<String> t = c.text().stream(TextStreamParams.builder().build());",
			].join("\n"),
		)
		const run = driven().run("probe.Probe", source)
		const errors = run.diagnostics.filter((line) => / error: /.test(line)).map((line) => line.replace(/^.*error: /, ""))
		expect(errors).toEqual([
			"incompatible types: EventStream<Tick> cannot be converted to EventStream<String>",
			"cannot find symbol",
		])
		expect(run.diagnostics.join("\n")).toMatch(/symbol: +method reconnectToken\(String\)/)
	})
})
describe.skipIf(!JAVA)("a refused SSE open's error body", SLOW, () => {
	/* new: ruling 3 (C# Exchange.cs:18, :209): a refused open's body is read at most 64 KiB */
	it("reads a refused open's error body at most 64 KiB: a 200 KiB body is cut, its status exception thrown", async () => {
		const big: Reply = { headers: { "content-type": "text/plain" }, status: 404, text: "x".repeat(200 * 1024) }
		const { out, ran } = await consume(
			[big],
			[
				"try {",
				"  c.text().stream(TextStreamParams.builder().build());",
				"} catch (ApiException e) {",
				'  note(e.getClass().getSimpleName() + " " + e.status() + " " + e.body().length);',
				"}",
			].join("\n"),
		)
		expect({ out, status: ran.status }, ran.stderr).toEqual({ out: ["NotFoundException 404 65536"], status: 0 })
	})
})

/** The `sse` SDK's files in throw mode or safe mode. */
const files = (throwOnError: boolean) => generateJavaSdk(FIXTURES.sse.document(), { throwOnError }).files
const TICKS_RESOURCE = "src/main/java/ai/anyrow/TicksResource.java"
/** Each stream method's lines in the files: every line from its signature to its closing brace. */
const streamMethods = (all: Readonly<Record<string, string>>) =>
	Object.values(all).flatMap((source) =>
		[...source.matchAll(/^ {2}public EventStream<[\s\S]*?^ {2}\}$/gm)].map((match) => match[0]),
	)
/** F1's doc obligation: the sentence every stream method's javadoc and EventStream's carry. */
const RELEASE = "Open it in try-with-resources: a for-each break without one keeps the connection."

describe("generateJavaSdk: an SSE method in safe mode, and its javadoc", () => {
	/* new: C# sse.test.ts:278 */
	it("emits each stream method as throw mode does: a stream ignores throwOnError and answers no Result", () => {
		const [thrown, safe] = [streamMethods(files(true)), streamMethods(files(false))]
		expect({
			count: safe.length,
			result: safe.filter((method) => method.includes("Result<")),
			safe,
		}).toEqual({ count: 9, result: [], safe: thrown })
	})

	/* pin: reviewer condition (a) on F1: the emitted method and EventStream say how a stream lets go */
	it("says in each stream method's javadoc and in EventStream's that a for-each break needs try-with-resources", () => {
		const all = files(true)
		const docs = (all[TICKS_RESOURCE] ?? "").split("\n").filter((line) => line.includes("try-with-resources"))
		expect({
			eventStream: (all["src/main/java/ai/anyrow/EventStream.java"] ?? "").replace(/\s*\n\s*\*\s*/g, " "),
			method: docs.length,
		}).toEqual({ eventStream: expect.stringContaining(RELEASE), method: 3 })
	})
})
describe.skipIf(!JAVA)("an EventStream's open, its cursor and its one reader, through the public API", SLOW, () => {
	/* new: C# sse.test.ts:459 */
	it("fills RequestOptions.raw at the open: the 200, the URL sent, its content type and an empty body", async () => {
		const { out, ran, url } = await consume(
			[TICK],
			[
				"RawResponse raw = new RawResponse();",
				"try (EventStream<Tick> s = c.ticks().stream(",
				"    TicksStreamParams.builder().since(5L).build(), RequestOptions.builder().raw(raw).build())) {",
				'  note(raw.status() + " " + raw.url() + " " + raw.headers().get("content-type") + " " + raw.body().length);',
				"  for (SseEvent<Tick> ev : s) {",
				"    note(ev.data().n());",
				"  }",
				"}",
			].join("\n"),
		)
		expect({ out, status: ran.status }, ran.stderr).toEqual({
			out: [`200 ${url}/ticks?since=5 text/event-stream 0`, "1"],
			status: 0,
		})
	})

	/* new: C# sse.test.ts:468 (J1: a live connection has one cursor) */
	it("is read once: a second iterator() throws IllegalStateException", async () => {
		const { out, ran } = await consume(
			[sse(["data: a\n\n", "data: b\n\n"])],
			[
				"EventStream<String> s = c.text().stream(TextStreamParams.builder().build());",
				"for (SseEvent<String> ev : s) {",
				"  note(ev.data());",
				"}",
				"try {",
				"  s.iterator();",
				'  note("read again");',
				"} catch (IllegalStateException e) {",
				'  note(e.getClass().getSimpleName() + ": " + e.getMessage());',
				"}",
			].join("\n"),
		)
		expect({ out, status: ran.status }, ran.stderr).toEqual({
			out: ["a", "b", "IllegalStateException: an EventStream is read once"],
			status: 0,
		})
	})
})

describe.skipIf(!JAVA)("an EventStream's cursor: the last delivered id", SLOW, () => {
	/* new: ruling 3 (C# Events.cs:85): the cursor is the last DELIVERED id; an id a block without data set is not one */
	it("keeps lastEventId() at the last delivered id, empty before any: an id parsed in a block without data is no cursor", async () => {
		const { out, ran } = await consume(
			[sse(["id: 1\ndata: a\n\n", "id: 9\n\n"])],
			[
				"EventStream<String> s = c.text().stream(TextStreamParams.builder().build());",
				'note("[" + s.lastEventId() + "]");',
				"for (SseEvent<String> ev : s) {",
				'  note(ev.data() + " " + s.lastEventId());',
				"}",
				'note("end " + s.lastEventId());',
			].join("\n"),
		)
		expect({ out, status: ran.status }, ran.stderr).toEqual({ out: ["[]", "a 1", "end 1"], status: 0 })
	})
})
