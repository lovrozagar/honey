/**
 * A TypedWebSocket's socket in process (bit 16 phase d2a, K5, K7, K8; the reviewer's conditions 1–3 and the pong-clock
 * ruling): probes in the SDK's package drive the package-private `Socket` (the JDK listener, the one send gate, the
 * keepalive and the end) against a strict fake `java.net.http.WebSocket`. The fake fails a frame issued while another
 * send is pending, as the JDK does (W17, W19), so a gate bypass reds deterministically. Legs: no background reader
 * (demand 0 without receive); a ping each interval while pongs answer; no pong → the error path; no ping after any end;
 * the production interval, 20 s; a ping deferred behind a pending send, its pong clock started when it is sent; a close
 * under a pending send aborts it; one end event under a race; a receive pending on another thread ended by close(); a
 * server close while no read waits; the 16 MiB cap refused within one partial. The wire legs: `ws.test.ts`.
 */
import { describe, expect, it } from "vitest"
import { type DrivenJavaSdk, drivenJavaSdk } from "./__fixtures__/driven.ts"
import { withJava } from "./__fixtures__/java-env.ts"

/** Whether Java is pinned here: a missing toolchain fails where it is required and skips these legs elsewhere. */
const JAVA = withJava()
/** A cold gate compiles the SDK first. */
const SLOW = { timeout: 600_000 }

/** The `ws` SDK's package (the emitter's default), where the probes sit beside the package-private socket. */
const PACKAGE = "ai.anyrow"

let compiled: DrivenJavaSdk | undefined

/** The `ws` SDK, gated once per file; it must build. */
function sdk(): DrivenJavaSdk {
	compiled ??= drivenJavaSdk("ws")
	expect(compiled.built, compiled.diagnostics.join("\n")).toBe(true)
	return compiled
}

/**
 * The strict fake: every frame it is asked to send is recorded; a send's future completes at once unless `hold` is set,
 * when it stays pending until `release()`. A frame issued while another is pending fails with "Send pending" and closes
 * the output, the JDK's own contract (W17: a second data send behind a pending one throws "Send pending" on 17, 21 and
 * 25; W19: a ping or a close behind one is nondeterministic, often fatal): the SDK's gate must never let it happen.
 */
const FAKE = `final class Fake implements java.net.http.WebSocket {
  final java.util.List<String> frames = java.util.Collections.synchronizedList(new java.util.ArrayList<>());
  volatile long requested;
  volatile boolean hold;
  volatile boolean aborted;
  volatile boolean outputClosed;
  volatile String violation;
  private java.util.concurrent.CompletableFuture<java.net.http.WebSocket> pending;

  private synchronized java.util.concurrent.CompletableFuture<java.net.http.WebSocket> sent(String frame) {
    if (pending != null && !pending.isDone()) {
      violation = "Send pending: " + frame;
      outputClosed = true;
      return java.util.concurrent.CompletableFuture.failedFuture(new IllegalStateException("Send pending"));
    }
    frames.add(frame);
    pending = new java.util.concurrent.CompletableFuture<>();
    if (!hold) {
      pending.complete(this);
    }
    return pending;
  }

  synchronized void release() {
    hold = false;
    pending.complete(this);
  }

  synchronized void fail() {
    pending.completeExceptionally(new java.io.IOException("Output closed"));
  }

  long count(String prefix) {
    synchronized (frames) {
      return frames.stream().filter(f -> f.startsWith(prefix)).count();
    }
  }

  public java.util.concurrent.CompletableFuture<java.net.http.WebSocket> sendText(CharSequence data, boolean last) {
    return sent("text " + data.length());
  }

  public java.util.concurrent.CompletableFuture<java.net.http.WebSocket> sendBinary(java.nio.ByteBuffer data, boolean last) {
    return sent("binary " + data.remaining());
  }

  public java.util.concurrent.CompletableFuture<java.net.http.WebSocket> sendPing(java.nio.ByteBuffer message) {
    return sent("ping");
  }

  public java.util.concurrent.CompletableFuture<java.net.http.WebSocket> sendPong(java.nio.ByteBuffer message) {
    return sent("pong");
  }

  public java.util.concurrent.CompletableFuture<java.net.http.WebSocket> sendClose(int code, String reason) {
    return sent("close " + code + " " + reason);
  }

  public void request(long n) {
    requested += n;
  }

  public String getSubprotocol() {
    return "";
  }

  public boolean isOutputClosed() {
    return outputClosed;
  }

  public boolean isInputClosed() {
    return false;
  }

  public void abort() {
    aborted = true;
  }
}`

/**
 * `body` as the probe's main beside the fake, with `ends(w)` recording each end handler run; its output lines. A probe
 * still running after 20 s prints `probe hung` and exits 3, so a mutant that never ends a socket reds at once.
 */
function probed(body: string): string[] {
	const source = `package ${PACKAGE};

import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.*;

final class SocketProbe {
  static List<String> ends(TypedWebSocket w) {
    List<String> runs = java.util.Collections.synchronizedList(new java.util.ArrayList<>());
    w.onClosed(c -> runs.add("closed " + c.status() + " " + c.reason()));
    w.onError(e -> runs.add("error " + e.getMessage()));
    return runs;
  }

  public static void main(String[] args) throws Exception {
    Thread watchdog = new Thread(() -> {
      try {
        Thread.sleep(20_000);
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

${FAKE}
`
	const run = sdk().run(`${PACKAGE}.SocketProbe`, source)
	expect({ diagnostics: run.diagnostics, status: run.status }, run.stderr).toEqual({ diagnostics: [], status: 0 })
	return run.stdout.split("\n").filter((line) => line !== "")
}

/** A socket over a fresh fake, its keepalive every `ms` ms, opened; `w` its TypedWebSocket, `runs` its ends. */
const OPEN = (ms: number) => `Fake fake = new Fake();
Socket socket = new Socket(Duration.ofMillis(${ms}));
TypedWebSocket w = new TypedWebSocket(socket);
List<String> runs = ends(w);
socket.onOpen(fake);`

describe.skipIf(!JAVA)("a socket's demand: no background reader (condition 1)", SLOW, () => {
	/* new: condition 1 (C# Ws.cs: a message fires as receive delivers it); red under a reader that asks ahead */
	it("asks for nothing more until receive() takes the message that waits", () => {
		expect(
			probed(`${OPEN(60_000)}
System.out.println("open " + fake.requested);
socket.onText(fake, "a", true);
socket.onText(fake, "b", true);
System.out.println("delivered " + fake.requested);
System.out.println("read " + w.receive().text() + " " + fake.requested);
System.out.println("read " + w.receive().text() + " " + fake.requested);`),
		).toEqual(["open 1", "delivered 1", "read a 2", "read b 3"])
	})
})

describe.skipIf(!JAVA)("the keepalive (K7): a ping each interval, a pong-less one ends the socket", SLOW, () => {
	/* new: K7 */
	it("pings each interval while pongs answer, and the socket stays open", () => {
		expect(
			probed(`${OPEN(50)}
for (int i = 0; i < 6; i++) {
  Thread.sleep(50);
  socket.onPong(fake, ByteBuffer.allocate(0));
}
System.out.println((fake.count("ping") >= 3) + " " + fake.aborted + " " + runs);
w.close();`),
		).toEqual(["true false []"])
	})

	/* new: K7 (the ruling: no timeout check → the hang leg reds) */
	it("aborts the socket and fires Error once when a ping goes unanswered for an interval", () => {
		expect(
			probed(`${OPEN(50)}
Thread.sleep(400);
System.out.println(fake.aborted + " " + runs);
try {
  w.receive();
  System.out.println("read");
} catch (RuntimeException e) {
  System.out.println(e.getClass().getSimpleName() + ": " + e.getMessage());
}
System.out.println(w.receive() + " " + runs);`),
		).toEqual([
			"true []",
			"ApiConnectionException: the WebSocket stopped answering pings",
			"null [error the WebSocket stopped answering pings]",
		])
	})
})

describe.skipIf(!JAVA)("the keepalive (K7): it stops with the socket, and its production interval", SLOW, () => {
	/*
	 * new: K7 (the ruling: stop the scheduler on every close path); the pings before the end, each answered so the socket
	 * is alive when it ends, prove the keepalive ran; the echo answers close()'s own frame, so the local end is the one
	 */
	it("pings until close(), a server close, a drop or the cap, and sends no ping after", () => {
		expect(
			probed(`String[] ends = {"close", "server", "drop", "cap"};
for (String end : ends) {
  ${OPEN(30).split("\n").join("\n  ")}
  for (int i = 0; i < 8; i++) {
    Thread.sleep(10);
    socket.onPong(fake, ByteBuffer.allocate(0));
  }
  long before = fake.count("ping");
  boolean alive = !fake.aborted && runs.isEmpty();
  switch (end) {
    case "close" -> {
      CompletableFuture<Void> echo = CompletableFuture.runAsync(() -> {
        while (fake.count("close") == 0) {
          Thread.onSpinWait();
        }
        socket.onClose(fake, 1000, "");
      });
      w.close();
      echo.join();
    }
    case "server" -> socket.onClose(fake, 1001, "bye");
    case "drop" -> socket.onClose(fake, 1006, "");
    default -> socket.onBinary(fake, ByteBuffer.allocate((16 << 20) + 1), true);
  }
  long pings = fake.count("ping");
  Thread.sleep(200);
  System.out.println(end + " " + alive + " " + (before > 0) + " " + (fake.count("ping") - pings));
}`),
		).toEqual(["close true true 0", "server true true 0", "drop true true 0", "cap true true 0"])
	})

	/* new: K7 (the production interval the dial passes: C#'s KeepAliveInterval and KeepAliveTimeout) */
	it("keeps alive every 20 s in production", () => {
		expect(probed("System.out.println(Keepalive.EVERY);")).toEqual(["PT20S"])
	})
})

describe.skipIf(!JAVA)("the one send gate and the pong clock (K8, W17/W19, the pong-clock ruling)", SLOW, () => {
	/*
	 * new: the ruling (every frame through the gate); red under a ping that bypasses it, the fake's "Send pending"; the
	 * held ping goes out as the send frees the gate, 30 ms on, where the next tick is 150 ms away
	 */
	it("holds a keepalive ping behind a pending data send, then sends it as the send completes: the socket open", () => {
		expect(
			probed(`${OPEN(200)}
fake.hold = true;
CompletableFuture<Void> sending = CompletableFuture.runAsync(() -> w.send("x".repeat(64)));
Thread.sleep(250);
long during = fake.count("ping");
fake.release();
sending.join();
Thread.sleep(30);
long after = fake.count("ping");
socket.onPong(fake, ByteBuffer.allocate(0));
System.out.println(during + " " + after + " " + fake.violation + " " + fake.aborted + " " + runs);
w.close();`),
		).toEqual(["0 1 null false []"])
	})

	/* new: the pong-clock ruling: a send pending for three intervals is no dead peer; red under the clock at schedule */
	it("starts the pong clock when the ping is sent: a send pending three intervals, then a ping and its pong, stays open", () => {
		expect(
			probed(`${OPEN(50)}
fake.hold = true;
CompletableFuture<Void> sending = CompletableFuture.runAsync(() -> w.send("x"));
Thread.sleep(160);
System.out.println("pending " + fake.aborted + " " + runs);
fake.release();
sending.join();
Thread.sleep(70);
socket.onPong(fake, ByteBuffer.allocate(0));
Thread.sleep(30);
System.out.println("answered " + (fake.count("ping") >= 1) + " " + fake.aborted + " " + runs);
w.close();`),
		).toEqual(["pending false []", "answered true false []"])
	})
})

describe.skipIf(!JAVA)("the pong clock and a close under a pending send", SLOW, () => {
	/* new: the pong-clock ruling's reverse: a ping that went out and no pong → the error path */
	it("ends the socket when a ping that went out gets no pong within the interval", () => {
		expect(
			probed(`${OPEN(50)}
fake.hold = true;
CompletableFuture<Void> sending = CompletableFuture.runAsync(() -> w.send("x"));
Thread.sleep(100);
fake.release();
sending.join();
Thread.sleep(250);
System.out.println(fake.count("ping") + " " + fake.aborted + " " + runs);
try {
  w.receive();
} catch (RuntimeException e) {
  System.out.println(e.getMessage() + " " + runs);
}`),
		).toEqual(["1 true []", "the WebSocket stopped answering pings [error the WebSocket stopped answering pings]"])
	})

	/* new: condition 2 (C#'s abort mid-frame): red under a close that waits on the pending send */
	it("aborts a pending send when close() runs on another thread: the send fails, Closed fires once with the client's code", () => {
		expect(
			probed(`${OPEN(60_000)}
fake.hold = true;
CompletableFuture<String> sending = CompletableFuture.supplyAsync(() -> {
  try {
    w.send("x");
    return "sent";
  } catch (RuntimeException e) {
    return e.getClass().getSimpleName() + ": " + e.getMessage();
  }
});
Thread.sleep(100);
w.close(4000, "bye");
fake.fail();
System.out.println(sending.get(2, TimeUnit.SECONDS));
System.out.println(fake.aborted + " " + fake.count("close") + " " + runs);`),
		).toEqual(["ApiConnectionException: the WebSocket send failed: IOException", "true 0 [closed 4000 bye]"])
	})
})

describe.skipIf(!JAVA)("a socket's ends: one event, a pending receive, a server close, the cap", SLOW, () => {
	/* new: condition 3; red under an end that two threads both fire */
	it("fires exactly one end when the server's close and a local close() race, closedBy stable, 200 rounds", () => {
		expect(
			probed(`int doubled = 0;
int unstable = 0;
for (int round = 0; round < 200; round++) {
  ${OPEN(60_000).split("\n").join("\n  ")}
  CountDownLatch go = new CountDownLatch(1);
  CompletableFuture<Void> server = CompletableFuture.runAsync(() -> {
    try {
      go.await();
    } catch (InterruptedException e) {
      return;
    }
    socket.onClose(fake, 1001, "bye");
  });
  CompletableFuture<Void> local = CompletableFuture.runAsync(() -> {
    try {
      go.await();
    } catch (InterruptedException e) {
      return;
    }
    w.close();
  });
  go.countDown();
  CompletableFuture.allOf(server, local).join();
  w.receive();
  if (runs.size() != 1) {
    doubled++;
  }
  WsClose first = w.closedBy();
  Thread.sleep(1);
  if (first != w.closedBy()) {
    unstable++;
  }
}
System.out.println(doubled + " " + unstable);`),
		).toEqual(["0 0"])
	})

	/* new: C# streams.close.test.ts:180; the echo answers close()'s own frame, so the local end is the one */
	it("ends a receive pending on another thread with null when close() runs: one close, no Error", () => {
		expect(
			probed(`${OPEN(60_000)}
CompletableFuture<WsMessage> reader = CompletableFuture.supplyAsync(w::receive);
Thread.sleep(150);
CompletableFuture<Void> echo = CompletableFuture.runAsync(() -> {
  while (fake.count("close") == 0) {
    Thread.onSpinWait();
  }
  socket.onClose(fake, 1000, "");
});
w.close();
echo.join();
System.out.println(reader.get(2, TimeUnit.SECONDS) + " " + fake.count("close") + " " + runs);`),
		).toEqual(["null 1 [closed 1000 ]"])
	})
})

describe.skipIf(!JAVA)("a socket's ends: a server close, the cap", SLOW, () => {
	/* new: C# streams.close.test.ts:187 (K6: the echo carries the code and reason) */
	it("reads a server's close while no read waits as null, closedBy its code and reason, the echo sent with both", () => {
		expect(
			probed(`${OPEN(60_000)}
socket.onClose(fake, 4001, "bye");
System.out.println(w.receive() + " " + w.closedBy() + " " + fake.frames + " " + runs);`),
		).toEqual(["null WsClose[status=4001, reason=bye] [close 4001 bye] [closed 4001 bye]"])
	})

	/* new: the JDK's onError (a broken input, not W12's 1006 drop): the error path, no close frame, closedBy null */
	it("ends on the JDK's onError as ApiConnectionException at the read, Error once, nothing sent", () => {
		expect(
			probed(`${OPEN(60_000)}
socket.onError(fake, new java.io.IOException("reset"));
try {
  w.receive();
  System.out.println("read");
} catch (RuntimeException e) {
  System.out.println(e.getClass().getSimpleName() + ": " + e.getMessage() + " " + e.getCause().getMessage());
}
System.out.println(w.receive() + " " + w.closedBy() + " " + fake.frames + " " + runs);`),
		).toEqual(["ApiConnectionException: the WebSocket failed reset", "null null [] [error the WebSocket failed]"])
	})

	/* new: the W13 ruling (refused within one partial of the cap, never after buffering it all): 1 MiB partials */
	it("refuses a message crossing 16 MiB at the partial that crosses it, closing 1008 and asking for no more", () => {
		expect(
			probed(`${OPEN(60_000)}
CompletableFuture<String> reader = CompletableFuture.supplyAsync(() -> {
  try {
    return String.valueOf(w.receive());
  } catch (RuntimeException e) {
    return e.getMessage();
  }
});
Thread.sleep(50);
int fed = 0;
while (fake.count("close") == 0 && fed < 20) {
  socket.onBinary(fake, ByteBuffer.allocate(1 << 20), false);
  fed++;
}
System.out.println(fed + " " + fake.requested + " " + fake.frames + " " + reader.get(2, TimeUnit.SECONDS));`),
		).toEqual(["17 17 [close 1008 Message too big] the WebSocket ended: 1008 Message too big"])
	})
})

describe.skipIf(!JAVA)("the close codes a client may send (W20: 1000, 1001, 1008, 1011, 3000-4999)", SLOW, () => {
	/* new: W20 (b): a server close a client can't send back is echoed 1000, its reason kept; closedBy the server's code */
	it("echoes a server close of 1003 as 1000 with its reason, closedBy keeping 1003", () => {
		expect(
			probed(`${OPEN(60_000)}
socket.onClose(fake, 1003, "unsupported");
System.out.println(w.receive() + " " + w.closedBy() + " " + fake.frames + " " + runs);`),
		).toEqual(["null WsClose[status=1003, reason=unsupported] [close 1000 unsupported] [closed 1003 unsupported]"])
	})

	/* new: W20 (b): a close frame with no status reads as 1005, which no client may send: echoed 1000, empty */
	it("echoes a server close with no status as 1000 with no reason, closedBy 1005", () => {
		expect(
			probed(`${OPEN(60_000)}
socket.onClose(fake, 1005, "");
System.out.println(w.receive() + " " + w.closedBy() + " " + fake.frames + " " + runs);`),
		).toEqual(["null WsClose[status=1005, reason=] [close 1000 ] [closed 1005 ]"])
	})

	/* new: W20 (c): a status no client may send is refused before any frame, the socket left open */
	it("refuses close(1005) as ConfigException, no frame sent and the socket still open", () => {
		expect(
			probed(`${OPEN(60_000)}
try {
  w.close(1005, "x");
  System.out.println("closed");
} catch (RuntimeException e) {
  System.out.println(e.getClass().getSimpleName() + ": " + e.getMessage());
}
w.send("still open");
System.out.println(fake.frames + " " + runs);`),
		).toEqual([
			"ConfigException: a WebSocket client can't close with status 1005: 1000, 1001, 1008, 1011 or 3000-4999",
			"[text 10] []",
		])
	})
})
