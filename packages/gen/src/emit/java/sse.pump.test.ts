/**
 * The pump an event stream's body is read through (bit 16 phase d1, J2; the reviewer's pump conditions P1–P3): the
 * SDK opens with `BodyHandlers.ofPublisher()` and subscribes its own `Pump`, an InputStream over a queue whose `take()`
 * any JDK interrupts (17's own body stream ignores an interrupt). In process, in the SDK's package, against a recording
 * subscription: demand is bounded (one request per buffer taken, so at most one buffer waits in the queue beside the one
 * being read); a close that lands before onSubscribe still cancels; an error surfaces once and is never repeated; and
 * close cancels once however often it runs. The release through a real connection: `streams.close.test.ts`.
 */
import { describe, expect, it } from "vitest"
import { type DrivenJavaSdk, drivenJavaSdk } from "./__fixtures__/driven.ts"
import { withJava } from "./__fixtures__/java-env.ts"

/** Whether Java is pinned here: a missing toolchain fails where it is required and skips these legs elsewhere. */
const JAVA = withJava()
/** A cold gate compiles the SDK first. */
const SLOW = { timeout: 600_000 }

/** The `sse` SDK's package (the emitter's default), where the probe sits beside the package-private pump. */
const PACKAGE = "ai.anyrow"

/** The `sse` SDK, which must build. */
function sdk(): DrivenJavaSdk {
	const driven = drivenJavaSdk("sse")
	expect(driven.built, driven.diagnostics.join("\n")).toBe(true)
	return driven
}

/** A subscription that records the demand asked of it and each cancel. */
const RECORDING = `final class Recording implements java.util.concurrent.Flow.Subscription {
  long requested;
  int canceled;

  @Override
  public void request(long n) {
    requested += n;
  }

  @Override
  public void cancel() {
    canceled++;
  }
}`

/** `body` as the probe's main, with `chunk(text)` a one-buffer item and Recording beside it; its output lines. */
function probed(body: string): string[] {
	const source = `package ${PACKAGE};

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.List;

final class PumpProbe {
  static List<ByteBuffer> chunk(String text) {
    return List.of(ByteBuffer.wrap(text.getBytes(StandardCharsets.US_ASCII)));
  }

  static String read(Pump pump, int n) throws java.io.IOException {
    byte[] buffer = new byte[n];
    int got = pump.read(buffer, 0, n);
    return got < 0 ? "end" : new String(buffer, 0, got, StandardCharsets.US_ASCII);
  }

  public static void main(String[] args) throws Exception {
${body
	.split("\n")
	.map((line) => `    ${line}`)
	.join("\n")}
  }
}

${RECORDING}
`
	const run = sdk().run(`${PACKAGE}.PumpProbe`, source)
	expect({ diagnostics: run.diagnostics, status: run.status }, run.stderr).toEqual({ diagnostics: [], status: 0 })
	return run.stdout.split("\n").filter((line) => line !== "")
}

describe.skipIf(!JAVA)("the event stream's pump, in process: its demand", SLOW, () => {
	/* new: P1: request(1) only once take() consumed the item before, so at most one buffer waits in the queue */
	it("asks for one buffer at the subscription, the next only once the reader takes one: at most one waits", () => {
		const out = probed(`Pump pump = new Pump(null);
Recording s = new Recording();
pump.onSubscribe(s);
System.out.println("subscribed " + s.requested);
pump.onNext(chunk("ab"));
System.out.println("delivered " + s.requested);
System.out.println("read " + read(pump, 1) + " " + s.requested);
pump.onNext(chunk("cd"));
System.out.println("rest " + read(pump, 8) + " " + s.requested);
System.out.println("next " + read(pump, 8) + " " + s.requested);`)
		expect(out).toEqual(["subscribed 1", "delivered 1", "read a 2", "rest b 2", "next cd 3"])
	})

	/* new: P2: a close (or an interrupt's cancel) before onSubscribe is held and applied when the subscription arrives */
	it("cancels a subscription that arrives after the pump was closed, and asks it for nothing", () => {
		const out = probed(`Pump pump = new Pump(null);
pump.close();
Recording s = new Recording();
pump.onSubscribe(s);
System.out.println("canceled " + s.canceled + " requested " + s.requested + " read " + read(pump, 4));`)
		expect(out).toEqual(["canceled 1 requested 0 read end"])
	})
})

describe.skipIf(!JAVA)("the event stream's pump, in process: its ends", SLOW, () => {
	/* new: P3: an onError surfaces once as the read's IOException with its cause, then the end; never swallowed */
	it("raises an onError once, after the buffers before it, then reads the end; a later onComplete changes nothing", () => {
		const out = probed(`Pump pump = new Pump(null);
Recording s = new Recording();
pump.onSubscribe(s);
pump.onNext(chunk("ok"));
pump.onError(new IllegalStateException("broke"));
pump.onComplete();
System.out.println("first " + read(pump, 8));
try {
  read(pump, 8);
  System.out.println("no error");
} catch (java.io.IOException e) {
  System.out.println("error " + e.getCause().getClass().getSimpleName() + ": " + e.getCause().getMessage());
}
System.out.println("then " + read(pump, 8));`)
		expect(out).toEqual(["first ok", "error IllegalStateException: broke", "then end"])
	})

	/* new: P3: close is idempotent: one cancel however often it runs, and a closed pump reads the end */
	it("cancels once however often it is closed, and a closed pump reads the end", () => {
		const out = probed(`Pump pump = new Pump(null);
Recording s = new Recording();
pump.onSubscribe(s);
pump.onNext(chunk("x"));
pump.close();
pump.close();
System.out.println("canceled " + s.canceled + " read " + read(pump, 4));`)
		expect(out).toEqual(["canceled 1 read end"])
	})

	/* new: P3/J2: an interrupt under a pending take() cancels the subscription and reads as InterruptedIOException */
	it("cancels the subscription and throws InterruptedIOException when the reader is interrupted under a pending read", () => {
		const out = probed(`Pump pump = new Pump(null);
Recording s = new Recording();
pump.onSubscribe(s);
Thread reader = Thread.currentThread();
new Thread(() -> {
  try {
    Thread.sleep(200);
  } catch (InterruptedException e) {
    return;
  }
  reader.interrupt();
}).start();
try {
  read(pump, 4);
  System.out.println("read");
} catch (java.io.InterruptedIOException e) {
  System.out.println("interrupted canceled " + s.canceled + " flag " + Thread.interrupted());
}`)
		expect(out).toEqual(["interrupted canceled 1 flag true"])
	})
})
