/**
 * The in-process socket probe (bit 16 d2a, moved out of ws.socket.test.ts at bit 19 d1): a probe in the SDK's package
 * drives the package-private `Socket` (the JDK listener, the one send gate, the keepalive and the end) against a strict
 * fake `java.net.http.WebSocket`, which fails a frame issued while another send is pending, as the JDK does (W17, W19).
 */
import { expect } from "vitest"
import type { DrivenJavaSdk } from "./driven.ts"

/** The `ws` SDK's package (the emitter's default), where the probes sit beside the package-private socket. */
const PACKAGE = "ai.anyrow"

/**
 * The strict fake: every frame it is asked to send is recorded; a send's future completes at once unless `hold` is set,
 * when it stays pending until `release()`. A frame issued while another is pending fails with "Send pending" and closes
 * the output, the JDK's own contract (W17: a second data send behind a pending one throws "Send pending" on 17, 21 and
 * 25; W19: a ping or a close behind one is nondeterministic, often fatal): the SDK's gate must never let it happen.
 */
export const FAKE = `final class Fake implements java.net.http.WebSocket {
  final java.util.List<String> frames = java.util.Collections.synchronizedList(new java.util.ArrayList<>());
  volatile long requested;
  volatile boolean hold;
  volatile boolean aborted;
  volatile boolean outputClosed;
  volatile String violation;
  volatile java.net.http.WebSocket.Listener echo; // a fast peer: its pong before the ping's send completes
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
    java.util.concurrent.CompletableFuture<java.net.http.WebSocket> ping = sent("ping");
    if (echo != null) echo.onPong(this, java.nio.ByteBuffer.allocate(0));
    return ping;
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
 * A prober over `sdk` (the `ws` SDK, built once by its caller): `body` as the probe's main beside the fake, with `ends(w)` recording each end handler run; its output lines. A probe
 * still running after 20 s prints `probe hung` and exits 3, so a mutant that never ends a socket reds at once.
 */
export const prober =
	(sdk: () => DrivenJavaSdk) =>
	(body: string): string[] => {
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
export const OPEN = (ms: number) => `Fake fake = new Fake();
Socket socket = new Socket(Duration.ofMillis(${ms}));
TypedWebSocket w = new TypedWebSocket(socket);
List<String> runs = ends(w);
socket.onOpen(fake);`
