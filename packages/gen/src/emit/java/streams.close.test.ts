/**
 * How a Java EventStream ends (bit 16 phase d1, J1/J2/F3; C#'s `streams.close.test.ts`, contract 50 §5.8). First the
 * close leg: `close()` from the main thread ends a read pending on another thread quietly. Then the release legs (Go's
 * `sse.release.test.ts` pattern): one consumer program per exit path of an EventStream. Each program's next request is
 * the text stream, whose answer waits until stream 0's client left (gone.ts), so a connection let go only at the
 * program's exit fails. Each program reads by hand and never closes what its leg does not name, and keeps the stream
 * reachable to the end (`Reference.reachabilityFence`), so a collected socket cannot fake a release. Every release leg
 * names the mutant it turns red, and the leak control (R7) proves the check is not hollow. The interrupt's release (R3)
 * runs on Temurin 17 as well as 21: 17's own body stream ignores an interrupt, and the SDK's pump must not.
 */
import { describe, expect, it } from "vitest"
import { gone } from "../shared/__fixtures__/gone.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenJavaSdk, drivenJavaSdk } from "./__fixtures__/driven.ts"
import { withJava } from "./__fixtures__/java-env.ts"

/** Whether Java is pinned here: a missing toolchain fails where it is required and skips these legs elsewhere. */
const JAVA = withJava()
/** Every executed describe's bound: a cold gate builds the SDK first. */
const SLOW = { timeout: 600_000 }

type Step = string | { waitMs: number }
const sse = (steps: readonly Step[], end: "close" | "hold" = "close"): Reply => ({ sse: { end, steps }, status: 200 })
const tick = (n: number) => `data: {"n":${n}}\n\n`
/** A typed stream held open after its first event. */
const OPEN = sse([tick(1)], "hold")
/** A typed stream whose second event comes 5 s after its first: an interrupt at 300 ms lands while the read waits. */
const HELD = sse([tick(1), { waitMs: 5000 }, tick(2)], "hold")

/** The `sse` SDK, which must build. */
function sdk(): DrivenJavaSdk {
	const driven = drivenJavaSdk("sse")
	expect(driven.built, driven.diagnostics.join("\n")).toBe(true)
	return driven
}

/**
 * A consumer program on the `sse` client at `url` running `body`: `note(…)` prints a line, and `settled(reader, ms)`
 * waits at most `ms` for the read `reader` runs on its own thread: its value (`null` for none), `canceled` for a
 * CancellationException, `<type>: <message>` for another error, or `stalled` when the bound came first.
 */
const program = (url: string, body: string) => `package probe;

import ai.anyrow.*;
import java.lang.ref.Reference;
import java.util.Iterator;
import java.util.concurrent.*;

public class Probe {
  static final String BASE = "${url}";

  static void note(Object value) {
    System.out.println(value);
  }

  static String settled(Future<?> reader, long ms) throws InterruptedException {
    try {
      Object value = reader.get(ms, TimeUnit.MILLISECONDS);
      return String.valueOf(value);
    } catch (TimeoutException e) {
      return "stalled";
    } catch (ExecutionException e) {
      Throwable cause = e.getCause();
      return cause instanceof CancellationException
          ? "canceled"
          : cause.getClass().getSimpleName() + ": " + cause.getMessage();
    }
  }

  public static void main(String[] args) throws Exception {
    AnyrowClient c = AnyrowClient.builder().baseUrl(BASE).build();
${body
	.split("\n")
	.map((line) => `    ${line}`)
	.join("\n")}
    System.exit(0);
  }
}
`

/** The release point: the text stream opened and read on `c`, its answer held until stream 0's client left. */
const NEXT = `try (EventStream<String> next = c.text().stream(TextStreamParams.builder().build())) {
  for (SseEvent<String> ev : next) {
    note(ev.data());
  }
}`

/**
 * The `sse` consumer `body` against `first`, then the text stream held until stream 0's client left, on `jdk`'s java:
 * its output lines, its run, and whether the server saw that client go before it answered.
 */
async function released(first: Reply, body: string, jdk: 17 | 21 = 21) {
	const driven = sdk()
	const next = gone(sse(["data: z\n\n"]))
	const ran = await served([first, next.reply], (server) => driven.exec("probe.Probe", program(server.url, body), jdk))
	return {
		ran,
		verdict: { out: ran.stdout.split("\n").filter((l) => l !== ""), released: next.released(), status: ran.status },
	}
}

/** A typed stream's read pending on another thread while the main thread closes it; the next open is the release point. */
const CLOSED = `EventStream<Tick> s = c.ticks().stream(TicksStreamParams.builder().build());
Iterator<SseEvent<Tick>> e = s.iterator();
note(e.next().data().n());
ExecutorService pool = Executors.newSingleThreadExecutor();
Future<Boolean> reader = pool.submit(e::hasNext);
Thread.sleep(300);
s.close();
note(settled(reader, 2000));
${NEXT}
Reference.reachabilityFence(s);`

describe.skipIf(!JAVA)("an EventStream closed under a pending read", SLOW, () => {
	/* new: C# streams.close.test.ts:173 (P3b: close() from another thread ends the read) */
	it("ends a read pending on another thread quietly when close() runs: hasNext false, no error, the connection let go", async () => {
		/* mutant: close() cancels nothing under a pending read (the pump never woken) → "stalled", released false */
		const { ran, verdict } = await released(OPEN, CLOSED)
		expect(verdict, ran.stderr).toEqual({ out: ["1", "false", "z"], released: true, status: 0 })
	})
})

/** R1: one event, then `break` inside try-with-resources; the next open on `c` timed. */
const BROKEN = `try (EventStream<Tick> s = c.ticks().stream(TicksStreamParams.builder().build())) {
  for (SseEvent<Tick> ev : s) {
    note(ev.data().n());
    break;
  }
}
long clock = System.nanoTime();
${NEXT}
note("ms " + (System.nanoTime() - clock) / 1_000_000);`

/** R2: the stream opened and left by try-with-resources, never read. */
const UNREAD = `try (EventStream<Tick> s = c.ticks().stream(TicksStreamParams.builder().build())) {
  note("opened" + s.lastEventId());
}
${NEXT}`

/** R3: the reader's thread interrupted at 300 ms under a pending read; nothing closed; 3 s for the read to end. */
const INTERRUPTED = `EventStream<Tick> s = c.ticks().stream(TicksStreamParams.builder().build());
Iterator<SseEvent<Tick>> e = s.iterator();
note(e.next().data().n());
ExecutorService pool = Executors.newSingleThreadExecutor();
Future<Boolean> reader = pool.submit(e::hasNext);
Thread.sleep(300);
pool.shutdownNow();
note(settled(reader, 3000));
${NEXT}
Reference.reachabilityFence(s);`

/** R4: a typed stream whose first event does not decode, read by hand and never closed. */
const UNDECODED = `EventStream<Tick> s = c.ticks().stream(TicksStreamParams.builder().build());
Iterator<SseEvent<Tick>> e = s.iterator();
try {
  while (e.hasNext()) {
    note(e.next().data().n());
  }
} catch (HoneyException error) {
  note(error.getClass().getSimpleName());
}
${NEXT}
Reference.reachabilityFence(s);`

/** R5: an onResponse hook that throws on the 2xx open, so no stream is ever returned; the next open on a plain client. */
const HOOKED = `AnyrowClient hooked = AnyrowClient.builder().baseUrl(BASE)
    .onResponse(context -> {
      throw new IllegalStateException("bad");
    })
    .build();
try {
  hooked.ticks().stream(TicksStreamParams.builder().build());
  note("opened");
} catch (HoneyException error) {
  note(error.getClass().getSimpleName() + ": " + error.getMessage());
}
${NEXT}`

/** R7: the leak: one event read, then the stream kept open and reachable past the next open. */
const KEPT = `EventStream<Tick> s = c.ticks().stream(TicksStreamParams.builder().build());
Iterator<SseEvent<Tick>> e = s.iterator();
note(e.next().data().n());
${NEXT}
Reference.reachabilityFence(e);
Reference.reachabilityFence(s);`

describe.skipIf(!JAVA)("an EventStream's connection let go by each of its ends, the SDK's own release", SLOW, () => {
	/* new: C# streams.close.test.ts:350 (F1: Java's break releases only inside try-with-resources) */
	it("R1: lets it go at once when a try-with-resources body breaks, the next answer within 1 s of the break", async () => {
		/* mutant: EventStream.close() leaves the body open → released false */
		const { ran, verdict } = await released(OPEN, BROKEN)
		const ms = Number(verdict.out.find((line) => line.startsWith("ms "))?.slice(3))
		expect({ ...verdict, out: verdict.out.filter((line) => !line.startsWith("ms ")) }, ran.stderr).toEqual({
			out: ["1", "z"],
			released: true,
			status: 0,
		})
		expect(ms, ran.stderr).toBeLessThan(1000)
	})

	/* new: C# streams.close.test.ts:361 */
	it("R2: lets it go when try-with-resources leaves a stream never read", async () => {
		/* mutant: close() lets the body go only through an iterator, and none was taken → released false */
		const { ran, verdict } = await released(OPEN, UNREAD)
		expect(verdict, ran.stderr).toEqual({ out: ["opened", "z"], released: true, status: 0 })
	})

	/* new: C# streams.close.test.ts:368 (J2: the reader's interrupt; condition b: on 17 and 21) */
	it.each([17, 21] as const)(
		"R3: lets it go when the reader is interrupted under a pending read, the stream never closed (JDK %i)",
		async (jdk) => {
			/* mutant: the body read through ofInputStream → on 17 "stalled", released false; 21 stays green */
			const { ran, verdict } = await released(HELD, INTERRUPTED, jdk)
			expect(verdict, ran.stderr).toEqual({ out: ["1", "canceled", "z"], released: true, status: 0 })
		},
	)

	/* new: C# streams.close.test.ts:375 */
	it("R4: lets it go when an event does not decode, close() never called", async () => {
		/* mutant: the decode error is thrown but leaves the body to a close the program never makes → released false */
		const { ran, verdict } = await released(sse(["data: nope\n\n"], "hold"), UNDECODED)
		expect(verdict, ran.stderr).toEqual({ out: ["DecodeException", "z"], released: true, status: 0 })
	})

	/* new: C# streams.close.test.ts:382 (J6: any throw after the 2xx closes the live body first) */
	it("R5: lets the 2xx open go when an onResponse hook throws, no stream ever returned", async () => {
		/* mutant: the open's catch leaves the live body → released false */
		const { ran, verdict } = await released(OPEN, HOOKED)
		expect(verdict, ran.stderr).toEqual({ out: ["HookException: hook: bad", "z"], released: true, status: 0 })
	})

	/* new: C# streams.close.test.ts:396 (gone.ts's own control, for Java) */
	it("R7: sees no release from a program that keeps the stream open: the check is not hollow", async () => {
		/* the control's mutant is the check itself: a gone() blind to a held Java connection reads true here */
		const { ran, verdict } = await released(OPEN, KEPT)
		expect(verdict, ran.stderr).toEqual({ out: ["1", "z"], released: false, status: 0 })
	})
})
