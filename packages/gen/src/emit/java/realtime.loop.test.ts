/**
 * A realtime connection's open bound in process (bit 16 phase d2b, R4 and its binding refinement): probes in the SDK's
 * package open a `ResumableConnection` over a caller's adapter with the bound shortened (production: 30 s, as the
 * keepalive's interval is), the way `Realtime.open` opens a call. Legs: a chain that opens nothing within the bound is
 * ApiTimeoutException, its adapter interrupted; a caller's own interrupt during an open that succeeds survives it, and
 * the next receive is that cancel (the SDK never clears an interrupt it did not set); 200 rounds whose opens straddle
 * the bound leave no stray interrupt after a success and lose no caller interrupt; and a fire after the open is nothing.
 */
import { describe, expect, it } from "vitest"
import { type DrivenJavaSdk, drivenJavaSdk } from "./__fixtures__/driven.ts"
import { withJava } from "./__fixtures__/java-env.ts"

/** Whether Java is pinned here: a missing toolchain fails where it is required and skips these legs elsewhere. */
const JAVA = withJava()
/** A cold gate compiles the SDK first. */
const SLOW = { timeout: 600_000 }

let compiled: DrivenJavaSdk | undefined

/** The `realtime` SDK, gated once per file; it must build. */
function sdk(): DrivenJavaSdk {
	compiled ??= drivenJavaSdk("realtime")
	expect(compiled.built, compiled.diagnostics.join("\n")).toBe(true)
	return compiled
}

/**
 * The probe's adapters. `Spin` opens after `ms` of busy work that ignores an interrupt (a caller's adapter that swallows
 * one, R4's FLAG), records whether it saw one, and counts the conns it opened and closed; `Held` opens after a sleep an
 * interrupt ends (the default adapters' way). Each conn holds one message, then waits on its close.
 */
const DECLS = `
final class Conn implements TransportConnection {
  volatile boolean closed;
  private boolean read;

  @Override
  public TransportMessage receive() {
    if (!read) {
      read = true;
      return new TransportMessage("{}", null, null);
    }
    return null;
  }

  @Override
  public void send(String text) {}

  @Override
  public void close() {
    closed = true;
  }
}

final class Spin implements TransportAdapter {
  volatile long ms;
  final java.util.List<Conn> conns = new java.util.concurrent.CopyOnWriteArrayList<>();
  /* a probe's latch: counted down once an open is in progress, which then holds until held is set (10 s at most) */
  volatile CountDownLatch dialing;
  volatile java.util.concurrent.atomic.AtomicBoolean held;

  Spin(long ms) {
    this.ms = ms;
  }

  @Override
  public String name() {
    return "spin";
  }

  @Override
  public TransportKind kind() {
    return TransportKind.WS;
  }

  @Override
  public TransportConnection connect(String url, TransportOptions options) {
    long end = System.nanoTime() + ms * 1_000_000;
    if (dialing != null) {
      dialing.countDown();
      /* a spin, not a wait: an interrupt landing here stays set, as in the work below */
      long limit = System.nanoTime() + 10_000_000_000L;
      while (!held.get() && System.nanoTime() < limit) {
        Thread.onSpinWait();
      }
      if (!held.get()) {
        System.err.println("the hold cap was reached: the interrupter thread was starved for 10 s (a stalled scheduler, not the runtime)");
        System.exit(4);
      }
    }
    while (System.nanoTime() < end) {
      Thread.onSpinWait();
    }
    Conn conn = new Conn();
    conns.add(conn);
    return conn;
  }
}

final class Twice implements TransportAdapter {
  final java.util.concurrent.atomic.AtomicInteger connects = new java.util.concurrent.atomic.AtomicInteger();
  final java.util.concurrent.CountDownLatch dialing = new java.util.concurrent.CountDownLatch(1);
  volatile Hold held;
  private final boolean blocks;

  Twice(boolean blocks) {
    this.blocks = blocks;
  }

  @Override
  public String name() {
    return "twice";
  }

  @Override
  public TransportKind kind() {
    return TransportKind.WS;
  }

  @Override
  public TransportConnection connect(String url, TransportOptions options) {
    if (connects.incrementAndGet() == 1) {
      return new Conn();
    }
    dialing.countDown();
    if (!blocks) {
      held = new Hold();
      return held;
    }
    try {
      Thread.sleep(10_000);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new java.util.concurrent.CancellationException("the dial was canceled");
    }
    return new Conn();
  }
}

/** A conn that holds every read until it is closed; an interrupt is the read's cancel. */
final class Hold implements TransportConnection {
  private final java.util.concurrent.CountDownLatch gone = new java.util.concurrent.CountDownLatch(1);
  final java.util.concurrent.CountDownLatch waiting = new java.util.concurrent.CountDownLatch(1);

  @Override
  public TransportMessage receive() {
    waiting.countDown();
    try {
      gone.await();
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new java.util.concurrent.CancellationException("the read was canceled");
    }
    return null;
  }

  @Override
  public void send(String text) {}

  @Override
  public void close() {
    gone.countDown();
  }
}

final class Held implements TransportAdapter {
  volatile boolean interrupted;

  @Override
  public String name() {
    return "held";
  }

  @Override
  public TransportKind kind() {
    return TransportKind.SSE;
  }

  @Override
  public TransportConnection connect(String url, TransportOptions options) {
    try {
      Thread.sleep(10_000);
    } catch (InterruptedException e) {
      interrupted = true;
      Thread.currentThread().interrupt();
      throw new java.util.concurrent.CancellationException("the open was canceled");
    }
    return new Conn();
  }
}
`

/**
 * `body` as the probe's main beside DECLS, under a watchdog of `seconds` (20 by default); `open(adapter, ms)` a
 * connection bounded at `ms`.
 */
function probed(body: string, seconds = 20): string[] {
	const source = `package ai.anyrow;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.*;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.JsonNode;

final class LoopProbe {
  static ResumableConnection<JsonNode> open(TransportAdapter adapter, long ms) {
    return new ResumableConnection<>("http://t/rt", List.of(adapter), new TypeReference<JsonNode>() {}, null, Duration.ofMillis(ms));
  }

  public static void main(String[] args) throws Exception {
    Thread watchdog = new Thread(() -> {
      try {
        Thread.sleep(${seconds * 1000});
      } catch (InterruptedException e) {
        return;
      }
      System.out.println("probe hung");
      System.exit(3);
    });
    watchdog.setDaemon(true);
    watchdog.start();
${body
	.split("\n")
	.map((line) => `    ${line}`)
	.join("\n")}
    System.exit(0);
  }
}
${DECLS}`
	const run = sdk().run("ai.anyrow.LoopProbe", source)
	expect({ diagnostics: run.diagnostics, status: run.status }, run.stderr).toEqual({ diagnostics: [], status: 0 })
	return run.stdout.split("\n").filter((line) => line !== "")
}

describe.skipIf(!JAVA)("the open bound (R4): no transport within it is ApiTimeoutException", SLOW, () => {
	/* new: RealtimeLoop.cs:16 (C#'s OpenLimit), shortened in process; red with the bound removed (the watchdog) */
	it("ends a chain that opens nothing within the bound: ApiTimeoutException, the adapter interrupted, no interrupt left", () => {
		expect(
			probed(`Held held = new Held();
ResumableConnection<JsonNode> rc = open(held, 100);
long started = System.nanoTime();
try {
  rc.open();
  System.out.println("opened");
} catch (RuntimeException e) {
  long ms = (System.nanoTime() - started) / 1_000_000;
  System.out.println(e.getClass().getSimpleName() + ": " + e.getMessage() + " " + (ms >= 90 && ms < 2000));
}
System.out.println(held.interrupted + " " + Thread.currentThread().isInterrupted() + " " + rc.state());`),
		).toEqual(["ApiTimeoutException: no transport opened within 100 ms true", "true false DISCONNECTED"])
	})

	/* new: the refinement (1): an open that returned past the bound closes what it opened and is the timeout */
	it("closes what an open returned past the bound and throws the timeout, no interrupt left", () => {
		expect(
			probed(`Spin spin = new Spin(400);
ResumableConnection<JsonNode> rc = open(spin, 50);
try {
  rc.open();
  System.out.println("opened");
} catch (RuntimeException e) {
  System.out.println(e.getClass().getSimpleName() + ": " + e.getMessage());
}
System.out.println(spin.conns.size() + " " + spin.conns.get(0).closed + " " + Thread.currentThread().isInterrupted() + " " + rc.state());`),
		).toEqual(["ApiTimeoutException: no transport opened within 50 ms", "1 true false DISCONNECTED"])
	})
})

/**
 * The 200 rounds: bound 50 ms, opens of 45–55 ms, a caller's interrupt inside the open on odd rounds; the misses
 * counted. The interrupter waits on the open's latch (the adapter has the dial), and the open holds until it has landed,
 * so every odd round probes, whatever the load: no timer races the open. A probe is the interrupt landing inside the
 * open; a caller interrupt is lost when an open that succeeded no longer has it set (a timeout consumes it, by design).
 */
const ROUNDS = `int stray = 0;
int lost = 0;
int succeeded = 0;
int timedOut = 0;
int probed = 0;
for (int round = 0; round < 200; round++) {
  Spin spin = new Spin(45 + round % 11);
  ResumableConnection<JsonNode> rc = open(spin, 50);
  boolean caller = round % 2 == 1;
  /* the caller's interrupt, marked under one lock as it lands */
  Object lock = new Object();
  java.util.concurrent.atomic.AtomicBoolean fired = new java.util.concurrent.atomic.AtomicBoolean();
  CountDownLatch landed = new CountDownLatch(caller ? 1 : 0);
  if (caller) {
    Thread self = Thread.currentThread();
    CountDownLatch dialing = new CountDownLatch(1);
    spin.dialing = dialing;
    spin.held = fired;
    new Thread(() -> {
      try {
        dialing.await();
      } catch (InterruptedException e) {
        return;
      }
      synchronized (lock) {
        self.interrupt();
        fired.set(true);
      }
      landed.countDown();
    }).start();
  }
  try {
    rc.open();
    succeeded++;
    synchronized (lock) {
      boolean set = Thread.currentThread().isInterrupted();
      if (caller && fired.get()) {
        probed++;
      }
      if (caller && fired.get() && !set) {
        lost++;
      }
      if (!caller && set) {
        stray++;
      }
    }
  } catch (ApiTimeoutException e) {
    timedOut++;
    if (caller && fired.get()) {
      probed++;
    }
    if (!caller && Thread.currentThread().isInterrupted()) {
      stray++;
    }
  }
  /* a late caller interrupt lands before the round ends, so it never reaches the next round's open */
  while (true) {
    try {
      landed.await();
      break;
    } catch (InterruptedException e) {
      /* the caller's own interrupt, landing as the round waits for it */
    }
  }
  Thread.interrupted();
  /* a fire after the open is nothing: wait past the bound, then look again */
  try {
    Thread.sleep(60);
  } catch (InterruptedException e) {
    if (!caller) {
      stray++;
    }
  }
  if (!caller && Thread.interrupted()) {
    stray++;
  }
  Thread.interrupted();
  rc.close();
}
/* non-vacuity: every odd round probes, its interrupt landing inside the open */
System.out.println(stray + " " + lost + " " + (succeeded > 0) + " " + (timedOut > 0) + " " + probed);`

describe.skipIf(!JAVA)("the backoff is capped at the open bound (C#'s OpenLimit)", SLOW, () => {
	/* new: RealtimeLoop.cs:131 (Math.Min(…, OpenLimit)); red under an uncapped backoff, which sleeps a 1 h delay's half */
	it("reconnects within the bound after a clean end, whatever the delay: a 1 h delay under a 100 ms bound", () => {
		expect(
			probed(`Spin spin = new Spin(0);
TransportOptions slow = TransportOptions.builder().reconnectDelay(Duration.ofHours(1)).build();
ResumableConnection<JsonNode> rc = new ResumableConnection<>("http://t/rt", List.of(spin), new TypeReference<JsonNode>() {}, slow, Duration.ofMillis(100));
rc.connect();
rc.receive();
long started = System.nanoTime();
JsonNode next = rc.receive();
long ms = (System.nanoTime() - started) / 1_000_000;
System.out.println(next + " " + (ms < 2000) + " " + spin.conns.size() + " " + rc.state());`),
		).toEqual(["{} true 2 CONNECTED"])
	})
})

describe.skipIf(!JAVA)("a for-each over the connection (R1): not read once", SLOW, () => {
	/* new: R1 (C#'s await foreach keeps the connection when a loop is left); each conn holds one message, then ends */
	it("reads by for-each through receive, and a loop left by break keeps the connection for the next read", () => {
		expect(
			probed(`Spin spin = new Spin(0);
TransportOptions quick = TransportOptions.builder().reconnectDelay(Duration.ofMillis(1)).build();
ResumableConnection<JsonNode> rc = new ResumableConnection<>("http://t/rt", List.of(spin), new TypeReference<JsonNode>() {}, quick, Duration.ofSeconds(5));
rc.connect();
int read = 0;
for (JsonNode message : rc) {
  read++;
  if (read == 3) {
    break;
  }
}
System.out.println(read + " " + rc.receive() + " " + spin.conns.size() + " " + rc.state());`),
		).toEqual(["3 {} 4 CONNECTED"])
	})
})

/**
 * A reconnect reached on another thread: the first conn delivers one message, then ends; the next connect blocks until
 * interrupted (`blocks`) or opens a conn that holds its read. `close()` runs once the second connect started, after
 * `before` on the closing thread; the line: the read's end, its flag after, whether it ended within 2 s, the state, the
 * connects, and the closing thread's flag.
 */
const reconnecting = (blocks: boolean, before = "") => `Twice twice = new Twice(${blocks});
TransportOptions quick = TransportOptions.builder().reconnectDelay(Duration.ofMillis(1)).build();
ResumableConnection<JsonNode> rc = new ResumableConnection<>("http://t/rt", List.of(twice), new TypeReference<JsonNode>() {}, quick, Duration.ofSeconds(30));
rc.connect();
rc.receive();
CompletableFuture<String> reader = new CompletableFuture<>();
Thread thread = new Thread(() -> {
  try {
    JsonNode value = rc.receive();
    reader.complete(value + " " + Thread.currentThread().isInterrupted());
  } catch (RuntimeException e) {
    reader.complete(e.getClass().getSimpleName() + " " + Thread.currentThread().isInterrupted());
  }
});
thread.start();
twice.dialing.await(5, TimeUnit.SECONDS);
${blocks ? "Thread.sleep(50);" : "while (twice.held == null) {\n  Thread.onSpinWait();\n}\ntwice.held.waiting.await(5, TimeUnit.SECONDS);"}
${before}long started = System.nanoTime();
rc.close();
boolean kept = Thread.interrupted();
String got;
try {
  got = reader.get(5, TimeUnit.SECONDS);
} catch (TimeoutException e) {
  got = "stalled";
}
long ms = (System.nanoTime() - started) / 1_000_000;
System.out.println(got + " " + (ms < 2000) + " " + rc.state() + " " + twice.connects.get() + " " + kept);`

describe.skipIf(!JAVA)("close() ends a pending reconnect's open (the close-cancel ruling)", SLOW, () => {
	/* new: the ruling (C# links _closing into each reconnect's token, RealtimeLoop.cs:61/134); red under a close() that
	 * leaves the dial to finish: the read stalls past the 5 s wait, inside the probe's 20 s watchdog and the 30 s bound */
	it("ends a receive whose reconnect's dial is pending with null, at once: DISCONNECTED, its flag clear, no further dial", () => {
		expect(probed(reconnecting(true))).toEqual(["null false true DISCONNECTED 2 false"])
	})

	/* new: the ruling's (b): close() never takes the closing thread's own interrupt */
	it("keeps the closing thread's own interrupt: set before close(), still set after it", () => {
		expect(probed(reconnecting(true, "Thread.currentThread().interrupt();\n"))).toEqual([
			"null false true DISCONNECTED 2 true",
		])
	})

	/* new: the ruling's cancel guard: a close() after the reconnect's open finished interrupts no one; red under a cancel
	 * without the opening check, which interrupts the reader in its held read */
	it("interrupts no reader when close() comes after the reconnect's open finished: the held read ends with null", () => {
		expect(probed(reconnecting(false))).toEqual(["null false true DISCONNECTED 2 false"])
	})
})

describe.skipIf(!JAVA)("the open bound never takes a caller's interrupt (R4 refinement 2–4)", SLOW, () => {
	/* new: refinement (3); red under a disarm that clears the flag unconditionally */
	it("keeps a caller's interrupt that lands during an open that succeeds: still set after it, and the next receive is the cancel", () => {
		expect(
			probed(`Spin spin = new Spin(60);
ResumableConnection<JsonNode> rc = open(spin, 1_000);
Thread self = Thread.currentThread();
CompletableFuture.delayedExecutor(15, TimeUnit.MILLISECONDS).execute(self::interrupt);
rc.open();
System.out.println(rc.state() + " " + Thread.currentThread().isInterrupted());
try {
  rc.receive();
  System.out.println("read");
} catch (CancellationException e) {
  System.out.println("canceled " + Thread.interrupted() + " " + rc.state());
}`),
		).toEqual(["CONNECTED true", "canceled true RECONNECTING"])
	})

	/* new: refinement (3)'s 200 rounds at the boundary: bound 50 ms, opens of 45–55 ms, a caller interrupt on odd rounds */
	it("leaves no stray interrupt after a successful open and loses no caller interrupt, 200 rounds at the boundary", () => {
		/* 200 rounds of about 110 ms each: a 60 s watchdog; a starved interrupter ends the probe at its first capped round */
		expect(probed(ROUNDS, 60)).toEqual(["0 0 true true 100"])
	})
})
