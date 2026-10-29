/**
 * The Java deadline (bit 16 phase c2, W8; Qc3, contract 47 §5.10): one deadline over the whole non-streaming exchange,
 * every hop and the auth retry, ended as ApiTimeoutException (a HoneyException, never CancellationException; ruling #1).
 *
 * C#'s scope, read from src/runtime/csharp/Exchange.cs: `_log.Start()` (line 57) runs before the timer, then the linked
 * token's `CancelAfter` (lines 59-63) wraps `AnswerAsync` (line 66). Inside it: the auth retry (lines 103-106), the request
 * hooks (line 114), every hop's `SendAsync` (line 127), the body read (line 147) and the response hooks (line 151, which
 * take the token). Outside it: `OnLog`'s Failed, Canceled and Received (lines 70, 75, 90 and 228). A slow hook that
 * ignores its token is not cut in C#; the next `SendAsync` then throws at once, so no later hop leaves.
 *
 * Java's scope, read from Flight.java: one `end` instant in the constructor covers the hooks, the auth retry and every
 * hop, and `send` bounds each hop by what is left. The response hook takes no token, so it runs after the answer and is
 * never cut: a slow one is not a timeout, as in C# for a hook that ignores its token.
 *
 * Legs that need a slow hook or a slow `onAuthExpired` run as a compiled consumer (`exec`), because the driver's Script
 * has no delay for a hook. Each `it` carries a `new` or `pin` label in a comment: `new` red first, `pin` green on write.
 */
import { describe, expect, it } from "vitest"
import { gzipSync } from "node:zlib"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { JavaError, Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { compiledJavaSdk } from "./__fixtures__/compiled.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { type DrivenJavaSdk, drivenJavaSdk } from "./__fixtures__/driven.ts"
import { withJava } from "./__fixtures__/java-env.ts"
import { generateJavaSdk } from "./sdk.ts"

/** Whether the JDK is here: a missing JDK fails where it is required and skips these legs elsewhere (java-env). */
const JAVA = withJava()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

const ECHO: Call = { operation: "echo.get", route: { method: "GET", path: "/echo" } }
const OK: Reply = { json: { ok: true }, status: 200 }
const OK_DATA = { data: { ok: true }, kind: "data", status: 200 }
const EXPIRED: Reply = { json: { message: "expired" }, status: 401 }
const TIMED_OUT = { kind: "timeout" }
/** A same-origin 302 to `/echo`: the SDK's own loop follows it as a second hop. */
const MOVED: Reply = { redirect: { origin: "primary", path: "/echo" }, status: 302 }
const BEARER: Setup = { auth: { kind: "bearer", token: "old" } }
/** A reply that answers after a second: a hop that fits a bound of two seconds, not two of them together. */
const slow = (reply: Reply): Reply => ({ ...reply, delayMs: 1000 })
/** A 500 MiB JSON answer, gzip-coded before the test runs: a few KiB on the wire, so its fetch is near instant. */
const LARGE: Reply = {
	gzipped: gzipSync(`{"ok":true}${" ".repeat(500 * 1024 * 1024)}`),
	headers: { "content-type": "application/json" },
	status: 200,
}
/** The call's bound: far above the pre-coded fetch, below the 500 MiB decode (about 1.5 s). */
const DECODE_BOUND_MS = 500
const TIMEOUT_CHAIN = expect.stringMatching(/^(TimeoutException|CompletionException|CancellationException)$/)

/** The causes a lapsed bound's timeout has: none in the decode, the JDK future's on the wire (`TIMEOUT_CHAIN`). */
const PHASE_CAUSES: readonly (string | null)[] = [null, "TimeoutException"]

/**
 * A run's first error and its observed, the error's `inner` read as whether it is a phase's cause: in the decode the
 * lapse has none, and on a slow runner the fetch is still on the wire, the JDK's TimeoutException its cause. Each
 * phase's own cause is pinned where it is deterministic: the wire's by the two-hop legs, the decode's by each read
 * loop's in-process leg.
 */
const phaseLapse = (run: {
	readonly trace?: { readonly calls: readonly { readonly error?: JavaError }[] }
	readonly observed?: unknown
}) => {
	const error = run.trace?.calls[0]?.error
	return {
		error: { ...error, inner: error !== undefined && PHASE_CAUSES.includes(error.inner) },
		observed: run.observed,
	}
}

/** The `http` SDK with the driver aimed at it: it must build. */
function driven(): DrivenJavaSdk {
	const sdk = drivenJavaSdk("http")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

/** `calls` run by the driver under `setup` and `script` against a server answering `replies`, with the hops. */
async function drive(replies: readonly Reply[], calls: readonly Call[], setup: Setup, script: Script = {}) {
	const sdk = driven()
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup }, { alt: server.alt, url: server.url }, { script })
		return { hops: [...server.hops], run }
	})
}

/** An error as the trace records a lapsed deadline: the SDK's timeout, thrown by the method, not canceled. */
const lapsed = (text: string): Partial<JavaError> => ({
	canceled: false,
	chain: ["ApiTimeoutException", "HoneyException"],
	display: expect.any(String),
	inner: TIMEOUT_CHAIN,
	text,
	type: "ApiTimeoutException",
	via: "return",
})

/**
 * A consumer program on the `http` client, built with `builder` (builder calls, each ending in a newline and a dot),
 * that calls `users.get` once and prints its outcome: `answered`, or the error's class and message.
 */
const probe = (url: string, builder: string) => `package probe;

import ai.anyrow.AnyrowClient;
import ai.anyrow.UsersGetParams;
import java.time.Duration;

public class Probe {
  static void sleep(long ms) {
    try {
      Thread.sleep(ms);
    } catch (InterruptedException e) {
      throw new IllegalStateException(e);
    }
  }

  public static void main(String[] args) {
    AnyrowClient client = AnyrowClient.builder()
        .baseUrl("${url}")
        ${builder}
        .build();
    try {
      client.users().get(UsersGetParams.builder().id("1").build());
      System.out.println("answered");
    } catch (RuntimeException e) {
      System.out.println(e.getClass().getSimpleName() + " " + e.getMessage());
    }
  }
}
`

/**
 * A consumer program on the `http` client with a 500 ms timeout whose request hook sleeps 1500 ms on the second call only,
 * so the first call warms a keep-alive connection that the second call's hop could use.
 */
const pairProbe = (url: string) => `package probe;

import ai.anyrow.AnyrowClient;
import ai.anyrow.UsersGetParams;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;

public class Probe {
  static final AtomicInteger CALLS = new AtomicInteger();

  public static void main(String[] args) {
    AnyrowClient client = AnyrowClient.builder()
        .baseUrl("${url}")
        .timeout(Duration.ofMillis(500))
        .onRequest(context -> {
          if (CALLS.incrementAndGet() == 2) {
            try {
              Thread.sleep(1500);
            } catch (InterruptedException e) {
              throw new IllegalStateException(e);
            }
          }
        })
        .build();
    for (int i = 0; i < 2; i++) {
      try {
        client.users().get(UsersGetParams.builder().id("1").build());
        System.out.println("answered");
      } catch (RuntimeException e) {
        System.out.println(e.getClass().getSimpleName() + " " + e.getMessage());
      }
    }
  }
}
`

describe.skipIf(!JAVA)(
	"the deadline over the whole exchange (Qc3): hops and the auth retry share one bound",
	SLOW,
	() => {
		/* pin: Flight's `end` is set once in the constructor, so the retry's hop gets what the first hop left (Exchange.cs:59-66) */
		it("ends an exchange whose two hops each fit the deadline but not together as ApiTimeoutException on the hop in flight", async () => {
			const setup: Setup = { ...BEARER, timeoutMs: 1800 }
			const { hops, run } = await drive([slow(EXPIRED), slow(OK)], [ECHO], setup, {
				onAuthExpired: { tokens: ["fresh"] },
			})
			expect(
				{
					authExpired: run.trace?.authExpired,
					error: run.trace?.calls[0]?.error,
					hops: hops.length,
					observed: run.observed,
				},
				run.stderr,
			).toEqual({
				authExpired: 1,
				error: lapsed("GET /echo timed out after 1800 ms"),
				hops: 2,
				observed: [TIMED_OUT],
			})
		})

		/* new: every hop of the SDK's redirect loop takes the one deadline (Exchange.cs:127 SendAsync per hop, one token):
		 * the second hop gets what the first left, so it lapses on the wire and no third hop is sent */
		it("ends a redirected exchange whose two hops each fit the deadline but not together as ApiTimeoutException", async () => {
			const { hops, run } = await drive([slow(MOVED), slow(OK)], [ECHO], { timeoutMs: 1800 }, {})
			expect(
				{ error: run.trace?.calls[0]?.error, hops: hops.map((h) => h.url), observed: run.observed },
				run.stderr,
			).toEqual({
				error: lapsed("GET /echo timed out after 1800 ms"),
				hops: ["/echo", "/echo"],
				observed: [TIMED_OUT],
			})
		})

		/* new: the decode runs under the one deadline (Exchange.cs:147). Which phase the bound passes in is a race on the
		 * runner's speed (CI run 40896170572) that no fixture signal can order, so this holds what either phase does: the
		 * timeout, no data (phaseLapse). Don't narrow it to one cause; each phase's is pinned by its deterministic leg. */
		it("ends an answer whose decode outlasts the deadline as ApiTimeoutException, with no answer data", async () => {
			const { run } = await drive([LARGE], [ECHO], { timeoutMs: DECODE_BOUND_MS }, { config: { maxResponseBytes: 0 } })
			expect(phaseLapse(run), run.stderr).toEqual({
				error: { ...lapsed(`GET /echo timed out after ${DECODE_BOUND_MS} ms`), inner: true },
				observed: [TIMED_OUT],
			})
		})

		/* pin: a zero config bound is none (Flight.java: `bound.isZero() ? null`), so a hop slower than the bound still answers */
		it("reads a zero config timeout as no deadline, so a slow hop still answers", async () => {
			const { hops, run } = await drive([{ ...OK, delayMs: 1000 }], [ECHO], { timeoutMs: 0 }, {})
			expect({ hops: hops.length, observed: run.observed }, run.stderr).toEqual({ hops: 1, observed: [OK_DATA] })
		})
	},
)

describe.skipIf(!JAVA)("a slow hook or onAuthExpired counts against the deadline (Exchange.cs:103-114)", SLOW, () => {
	/* new: Exchange.cs:114 runs the request hook under the token, so once it lapsed SendAsync throws and no hop leaves.
	 * The first call warms a keep-alive connection; the second call's hook sleeps past the deadline. Without the pre-send
	 * check a hop on that warm connection leaves at once (red on hops), so the check is what keeps the hop off the wire. */
	it("ends a call whose request hook outlasts the deadline as ApiTimeoutException, and sends no hop", async () => {
		const outcome = await served([OK, OK], async (server) => {
			const sdk = driven()
			const ran = await sdk.exec("probe.Probe", pairProbe(server.url))
			return { hops: server.hops.length, ran }
		})
		expect(
			{ hops: outcome.hops, stderr: outcome.ran.stderr, stdout: outcome.ran.stdout.trim() },
			outcome.ran.stderr,
		).toEqual({
			hops: 1,
			stderr: "",
			stdout: "answered\nApiTimeoutException GET /users/{id} timed out after 500 ms",
		})
	})

	/* new: Exchange.cs:103-106 refreshes under the token, so a refresh that outlasts the deadline ends the call with no
	 * retry hop; Flight.attempt sends the retry before its zero bound fires (red on hops). */
	it("ends a call whose onAuthExpired outlasts the deadline as ApiTimeoutException, and sends no retry hop", async () => {
		const outcome = await served([EXPIRED, OK], async (server) => {
			const sdk = driven()
			const builder =
				'.bearerToken("old")\n        .timeout(Duration.ofMillis(500))\n        .onAuthExpired(() -> { sleep(1500); return "fresh"; })'
			const ran = await sdk.exec("probe.Probe", probe(server.url, builder))
			return { hops: server.hops.length, ran }
		})
		expect(
			{ hops: outcome.hops, stderr: outcome.ran.stderr, stdout: outcome.ran.stdout.trim() },
			outcome.ran.stderr,
		).toEqual({ hops: 1, stderr: "", stdout: "ApiTimeoutException GET /users/{id} timed out after 500 ms" })
	})
})

describe.skipIf(!JAVA)(
	"a per-call timeout over the config's, and a caller's cancel (Exchange.cs:33-34, 73-77)",
	SLOW,
	() => {
		/* pin: Flight takes the call's timeout over the config's (Flight.java constructor), so a longer per-call bound lets a hop answer */
		it("replaces a config bound shorter than the hop with a longer per-call one, and the hop answers", async () => {
			const { hops, run } = await drive(
				[{ ...OK, delayMs: 1000 }],
				[{ ...ECHO, timeoutMs: 10_000 }],
				{ timeoutMs: 300 },
				{},
			)
			expect({ hops: hops.length, observed: run.observed }, run.stderr).toEqual({ hops: 1, observed: [OK_DATA] })
		})

		/* pin: a caller's cancel on the in-flight hop is CancellationException with canceled set, not a timeout, while the deadline is unlapsed */
		it("ends a call its caller cancels mid-hop as a cancel, not a timeout, while the deadline has not lapsed", async () => {
			const script: Script = { calls: [{ cancel: { afterMs: 500 } }] }
			const { run } = await drive([{ ...OK, delayMs: 3000 }], [ECHO], { timeoutMs: 10_000 }, script)
			expect(
				{
					error: run.trace?.calls[0]?.error?.type,
					canceled: run.trace?.calls[0]?.error?.canceled,
					observed: run.observed,
				},
				run.stderr,
			).toEqual({ canceled: true, error: "CancellationException", observed: [null] })
		})
	},
)

describe.skipIf(!JAVA)(
	"a slow response hook is never cut (Exchange.cs:151 takes the token; a hook ignoring it is not cut)",
	SLOW,
	() => {
		/* pin: Flight.java runs the response hook after `send` returns, with no token, so a slow hook returns the answer as C# does for a hook that ignores its token */
		it("returns the answer when the response hook outlasts the deadline, which lapses during the hook", async () => {
			const outcome = await served([OK], async (server) => {
				const sdk = driven()
				const builder = ".timeout(Duration.ofMillis(2000))\n        .onResponse(context -> sleep(4000))"
				const ran = await sdk.exec("probe.Probe", probe(server.url, builder))
				return { hops: server.hops.length, ran }
			})
			expect(
				{ hops: outcome.hops, stderr: outcome.ran.stderr, stdout: outcome.ran.stdout.trim() },
				outcome.ran.stderr,
			).toEqual({ hops: 1, stderr: "", stdout: "answered" })
		})
	},
)

/*
 * Each of Decode's two read loops checks the deadline (ruling iii), in-process in the SDK's package with a deadline
 * already lapsed, so neither leg rests on timing: the counting pass of an answer over its cap ends as the timeout, not
 * the cap's refusal, and the decoding pass (Decode.decoded, reached by reflection) throws the timeout instead of
 * answering, each with no cause (CI run 40896170572: the decode phase's lapse is the deadline's own timeout; only the
 * wire's carries the JDK's TimeoutException). The served leg above holds the pair; these hold each loop's own check.
 */
const DECODE_PROBE = `import java.io.ByteArrayOutputStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.Callable;
import java.util.zip.GZIPOutputStream;
import javax.net.ssl.SSLSession;

final class DecodeProbe {
  private static final int SIZE = 1 << 20;

  private static byte[] gzip() throws Exception {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    try (GZIPOutputStream zip = new GZIPOutputStream(out)) {
      zip.write(new byte[SIZE]);
    }
    return out.toByteArray();
  }

  private static String outcome(Callable<Object> body) throws Exception {
    try {
      body.call();
      return "answered";
    } catch (InvocationTargetException e) {
      return described(e.getCause());
    } catch (RuntimeException e) {
      return described(e);
    }
  }

  /* its class, its text and its cause: a decode's lapse has none, its own timeout, never a JDK one */
  private static String described(Throwable e) {
    return e.getClass().getSimpleName() + ": " + e.getMessage() + " cause=" + e.getCause();
  }

  private static HttpResponse<byte[]> gzipped(byte[] raw) {
    HttpHeaders headers = HttpHeaders.of(Map.of("content-encoding", List.of("gzip")), (name, value) -> true);
    return new HttpResponse<>() {
      public int statusCode() { return 200; }
      public HttpRequest request() { return null; }
      public Optional<HttpResponse<byte[]>> previousResponse() { return Optional.empty(); }
      public HttpHeaders headers() { return headers; }
      public byte[] body() { return raw; }
      public Optional<SSLSession> sslSession() { return Optional.empty(); }
      public URI uri() { return null; }
      public HttpClient.Version version() { return HttpClient.Version.HTTP_1_1; }
    };
  }

  public static void main(String[] args) throws Exception {
    byte[] raw = gzip();
    Deadline lapsed = new Deadline(Duration.ZERO, "GET /echo");
    System.out.println("count " + outcome(() -> Decode.body(gzipped(raw), 1024, lapsed)));
    Method decoded =
        Decode.class.getDeclaredMethod("decoded", byte[].class, String.class, long.class, Deadline.class);
    decoded.setAccessible(true);
    System.out.println("decoded " + outcome(() -> decoded.invoke(null, raw, "gzip", (long) SIZE, lapsed)));
  }
}
`

describe.skipIf(!JAVA)("each of the decode's read loops checks the deadline, in-process (ruling iii)", SLOW, () => {
	/* new: one leg per loop, each red with its own check removed (the served leg stays green on either alone) */
	it("ends the counting pass and the decoding pass under a lapsed deadline as ApiTimeoutException, with no cause", () => {
		const files = generateJavaSdk(FIXTURES.http.document()).files
		const pkg = /^package ([\w.]+);/m.exec(files["src/main/java/ai/anyrow/Decode.java"] ?? "")?.[1]
		const run = compiledJavaSdk(files).run(`${pkg}.DecodeProbe`, `package ${pkg};\n${DECODE_PROBE}`)
		expect(
			{ diagnostics: run.diagnostics, status: run.status, stdout: run.stdout.trim().split("\n") },
			run.stderr,
		).toEqual({
			diagnostics: [],
			status: 0,
			stdout: [
				"count ApiTimeoutException: GET /echo timed out after 0 ms cause=null",
				"decoded ApiTimeoutException: GET /echo timed out after 0 ms cause=null",
			],
		})
	})
})
