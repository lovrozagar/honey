/**
 * The Java SDK's auth (bit 16 phase c1, W4; the C# `http.auth.test.ts` port, contract 47 §5.2), driven on `http` (a
 * bearer scheme) and `errors` (an apiKey in `X-API-Key`): the scheme's header and prefix, the pair rule over the
 * builder's `authHeaderName` and `authHeaderPrefix`, the credential laid last over a config or per-call
 * `Authorization`, and `OnAuthExpired`'s one refresh and one retry for a replayable JSON body, given up after a
 * second 401 or an empty token. Not written here, for the c1 driver cannot express them: a one-shot InputStream body
 * never resent (a c2 binary body), single-flight across concurrent calls (a cell that runs calls at once), and the
 * emitted `_defaults` text (no Java text is pinned yet).
 */
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { CallTrace, JavaError, Script } from "../shared/__fixtures__/protocol.ts"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenJavaSdk, drivenJavaSdk } from "./__fixtures__/driven.ts"
import { withJava } from "./__fixtures__/java-env.ts"

/** Whether the JDK is here: a missing JDK fails where it is required and skips these legs elsewhere (java-env). */
const JAVA = withJava()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }
type Key = "errors" | "http"

const ECHO: Call = { operation: "echo.get", route: { method: "GET", path: "/echo" } }
const ITEM: Call = { operation: "items.get", params: { id: "i1" }, route: { method: "GET", path: "/items/{id}" } }
const CREATE: Call = {
	body: { kind: "json", value: { name: "retry-body" } },
	operation: "users.create",
	route: { method: "POST", path: "/users" },
}
const GET_USER: Call = { operation: "users.get", params: { id: "1" }, route: { method: "GET", path: "/users/{id}" } }

const OK: Reply = { json: { ok: true }, status: 200 }
const OK_DATA = { data: { ok: true }, kind: "data", status: 200 }
const USER: Reply = { json: { id: "u1" }, status: 200 }
const USER_DATA = { data: { id: "u1" }, kind: "data", status: 200 }
const ITEM_REPLY: Reply = { json: { id: "i1", name: "n" }, status: 200 }
const ITEM_DATA = { data: { id: "i1", name: "n" }, kind: "data", status: 200 }
const UNAUTHORIZED = { errorKey: null, kind: "error", status: 401 }

const T: Setup = { auth: { kind: "bearer", token: "t" } }
const OLD: Setup = { auth: { kind: "bearer", token: "old" } }
const FRESH: Script = { onAuthExpired: { tokens: ["new"] } }

type Options = { readonly key?: Key; readonly script?: Script; readonly setup?: Setup }

/** `calls` run by the `key` driver against a server answering `replies`: the run, every hop and its raw lines. */
function drive(replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	const sdk = driven(options.key ?? "http")
	return served(replies, async (server) => {
		const run = await sdk.runCalls(
			{ calls, setup: options.setup ?? {} },
			{ alt: server.alt, url: server.url },
			{ script: options.script },
		)
		return { bodies: [...server.bodies], hops: [...server.hops], lines: [...server.rawHeaders], run }
	})
}

/** The registry SDK `key` with the driver aimed at it, which must build. */
function driven(key: Key): DrivenJavaSdk {
	const sdk = drivenJavaSdk(key)
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

/** Every header a hop may carry the credential in, unset ones dropped by `toEqual`. */
const credentials = (hop: RecordedHop | undefined) => ({
	authorization: hop?.headers.authorization,
	"x-api-key": hop?.headers["x-api-key"],
	"x-raw": hop?.headers["x-raw"],
	"x-token": hop?.headers["x-token"],
})

/** A traced error by its type and status, the legs that read no text. */
const kind = (error: JavaError | undefined) => (error === undefined ? undefined : [error.type, error.status])

/** The call's error as the trace records it: no inner, not canceled, thrown by the method. */
const plain = (entry: Partial<JavaError>) => ({
	canceled: false,
	display: expect.any(String),
	inner: null,
	via: "return",
	...entry,
})

/** How many raw header lines each hop carries under `name`. */
const countOf = (lines: readonly (readonly (readonly [string, string])[])[], name: string) =>
	lines.map((pairs) => pairs.filter(([line]) => line === name).length)

/** The trace of a run's call `index`, when it has one. */
const callOf = (trace: { readonly calls: readonly CallTrace<JavaError>[] } | undefined, index: number) =>
	trace?.calls[index]

describe.skipIf(!JAVA)("the auth header: the spec's scheme picks its name and prefix", SLOW, () => {
	/* port: csharp http.auth.test.ts "the auth header" (the bearer leg) */
	it("sends Authorization: Bearer abc for a bearer token abc under http bearer", async () => {
		const { hops, run } = await drive([OK], [ECHO], { setup: { auth: { kind: "bearer", token: "abc" } } })
		expect({ observed: run.observed, sent: credentials(hops[0]) }, run.stderr).toEqual({
			observed: [OK_DATA],
			sent: { authorization: "Bearer abc" },
		})
	})

	/* port: csharp http.auth.test.ts "the auth header" (the apiKey leg) */
	it("sends the bare token in X-API-Key under the apiKey scheme, no Authorization", async () => {
		const { hops, run } = await drive([ITEM_REPLY], [ITEM], { key: "errors", setup: T })
		expect({ observed: run.observed, sent: credentials(hops[0]) }, run.stderr).toEqual({
			observed: [ITEM_DATA],
			sent: { "x-api-key": "t" },
		})
	})

	/* port: csharp http.auth.test.ts "keeps the scheme's header for a prefix alone" (the builder's pair rule) */
	it("keeps the scheme's header for a prefix alone, \"\" meaning none; a set name takes the caller's prefix or none", async () => {
		const legs: [Key, NonNullable<Script["config"]>][] = [
			["http", { authHeaderName: "X-Token", authHeaderPrefix: "Token " }],
			["http", { authHeaderPrefix: "Key " }],
			["http", { authHeaderPrefix: "" }],
			["http", { authHeaderName: "X-Raw" }],
			["errors", { authHeaderPrefix: "Key " }],
		]
		const sent: ReturnType<typeof credentials>[] = []
		for (const [key, config] of legs) {
			const call = key === "http" ? ECHO : ITEM
			const reply = key === "http" ? OK : ITEM_REPLY
			const { hops } = await drive([reply], [call], { key, script: { config }, setup: T })
			sent.push(credentials(hops[0]))
		}
		expect(sent).toEqual([
			{ "x-token": "Token t" },
			{ authorization: "Key t" },
			{ authorization: "t" },
			{ "x-raw": "t" },
			{ "x-api-key": "Key t" },
		])
	})
})

describe.skipIf(!JAVA)("the auth header: the credential is laid last, one value per name", SLOW, () => {
	/* port: csharp http.auth.test.ts "sends one authorization" */
	it("sends one authorization, the credential, over a config and a per-call Authorization", async () => {
		const setup: Setup = { auth: { kind: "bearer", token: "b" }, headers: { authorization: "Bearer a" } }
		const calls = [ECHO, { ...ECHO, headers: { Authorization: "Bearer call" } }]
		const { hops, lines, run } = await drive([OK, OK], calls, { setup })
		expect(
			{
				lines: countOf(lines, "authorization"),
				observed: run.observed,
				sent: hops.map((h) => h.headers.authorization),
			},
			run.stderr,
		).toEqual({
			lines: [1, 1],
			observed: [OK_DATA, OK_DATA],
			sent: ["Bearer b", "Bearer b"],
		})
	})
})

describe.skipIf(!JAVA)("the auth refresh: a 401 calls OnAuthExpired once and retries once", SLOW, () => {
	/* port: csharp http.auth.test.ts "retries with the fresh token" (the three legs, run in order) */
	it("retries with the fresh token, gives up after a second 401, and sends nothing more for an empty token", async () => {
		const legs = [
			await drive([{ status: 401 }, OK], [ECHO], { script: FRESH, setup: OLD }),
			await drive([{ status: 401 }, { status: 401 }], [ECHO], { script: FRESH, setup: OLD }),
			await drive([{ status: 401 }], [ECHO], { script: { onAuthExpired: { tokens: [""] } }, setup: OLD }),
		]
		expect(
			legs.map(({ hops, run }) => ({
				auth: hops.map((h) => h.headers.authorization),
				error: kind(callOf(run.trace, 0)?.error),
				expired: run.trace?.authExpired,
				observed: run.observed,
			})),
			legs.map(({ run }) => run.stderr).join("\n"),
		).toEqual([
			{ auth: ["Bearer old", "Bearer new"], error: undefined, expired: 1, observed: [OK_DATA] },
			{
				auth: ["Bearer old", "Bearer new"],
				error: ["UnauthorizedException", 401],
				expired: 1,
				observed: [UNAUTHORIZED],
			},
			{ auth: ["Bearer old"], error: ["UnauthorizedException", 401], expired: 1, observed: [UNAUTHORIZED] },
		])
	})

	/* port: csharp http.auth.test.ts "resends a JSON body intact" (a replayable body) */
	it("resends a JSON body intact on the retry and keeps the fresh token for the next call", async () => {
		const { bodies, hops, run } = await drive([{ status: 401 }, USER, USER], [CREATE, GET_USER], {
			script: FRESH,
			setup: OLD,
		})
		const sent = '{"name":"retry-body"}'
		expect(
			{
				auth: hops.map((h) => `${h.method} ${h.url} ${h.headers.authorization}`),
				bodies: bodies.map((b) => b.toString("utf8")),
				expired: run.trace?.authExpired,
				observed: run.observed,
			},
			run.stderr,
		).toEqual({
			auth: ["POST /users Bearer old", "POST /users Bearer new", "GET /users/1 Bearer new"],
			bodies: [sent, sent, ""],
			expired: 1,
			observed: [USER_DATA, USER_DATA],
		})
	})
})

describe.skipIf(!JAVA)("the auth refresh: a failing OnAuthExpired is the call's HookException", SLOW, () => {
	/* port: csharp http.auth.test.ts "a throwing OnAuthExpired" (the driver's own text and its cause) */
	it("a throwing OnAuthExpired ends the call as HookException with its text and its cause as inner", async () => {
		const script: Script = { onAuthExpired: { tokens: [] } }
		const { hops, run } = await drive([{ status: 401 }], [ECHO], { script, setup: OLD })
		const text = "on_auth_expired: driver: no token left"
		expect({ error: callOf(run.trace, 0)?.error, hops: hops.length, observed: run.observed }, run.stderr).toEqual({
			error: plain({
				chain: ["HookException", "HoneyException"],
				inner: "IllegalStateException",
				text,
				type: "HookException",
			}),
			hops: 1,
			observed: [null],
		})
	})
})

/**
 * The single-flight consumer (C#'s `Task.WhenAll` leg, run through the compiled fixture's `run`). `run` is synchronous
 * and the recording server answers only while the test's event loop turns, so the program hosts its own answerer on
 * the JDK's `com.sun.net.httpserver`, bound to `127.0.0.1:0`: a 401 for the stale token and a 200 for the fresh one.
 * Overlap is forced: a start latch releases eight threads together, and the refresher waits until all eight first
 * attempts reached the server before it returns (the `overlap` line), then sleeps 100 ms. A client without
 * single-flight would refresh once per call, and fail the one-refresh line.
 */
const SINGLE = `import ai.anyrow.AnyrowClient;
import ai.anyrow.UsersGetParams;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

public class Single {
  private static String outcome(AnyrowClient client) {
    try {
      client.users().get(UsersGetParams.builder().id("1").build());
      return "answered";
    } catch (RuntimeException e) {
      return e.getClass().getSimpleName();
    }
  }

  public static void main(String[] args) throws Exception {
    CountDownLatch start = new CountDownLatch(1);
    CountDownLatch arrived = new CountDownLatch(8);
    AtomicBoolean overlap = new AtomicBoolean(true);
    AtomicInteger refreshes = new AtomicInteger();
    AtomicInteger fresh = new AtomicInteger();
    ExecutorService pool = Executors.newFixedThreadPool(8);
    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    try {
      server.createContext("/", exchange -> {
        boolean ok = "Bearer new".equals(exchange.getRequestHeaders().getFirst("Authorization"));
        if (!ok) {
          arrived.countDown();
        } else {
          fresh.incrementAndGet();
        }
        byte[] body = (ok ? "{\\"id\\":\\"u1\\",\\"name\\":\\"n\\"}" : "{}").getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(ok ? 200 : 401, body.length);
        exchange.getResponseBody().write(body);
        exchange.close();
      });
      server.start();
      AnyrowClient client = AnyrowClient.builder()
          .baseUrl("http://127.0.0.1:" + server.getAddress().getPort())
          .bearerToken("old")
          .onAuthExpired(() -> {
            refreshes.incrementAndGet();
            try {
              if (!arrived.await(10, TimeUnit.SECONDS)) {
                overlap.set(false);
              }
              Thread.sleep(100);
            } catch (InterruptedException e) {
              Thread.currentThread().interrupt();
            }
            return "new";
          })
          .build();
      List<Future<String>> calls = new ArrayList<>();
      for (int i = 0; i < 8; i++) {
        calls.add(pool.submit(() -> {
          start.await();
          return outcome(client);
        }));
      }
      start.countDown();
      int answered = 0;
      for (Future<String> call : calls) {
        if ("answered".equals(call.get())) {
          answered++;
        }
      }
      System.out.println("refreshes " + refreshes.get());
      System.out.println("overlap " + overlap.get());
      System.out.println("fresh " + fresh.get());
      System.out.println("answered " + answered);
    } finally {
      pool.shutdownNow();
      server.stop(0);
    }
  }
}
`

describe.skipIf(!JAVA)("the auth refresh: concurrent 401s share one refresh", SLOW, () => {
	/* port: csharp http.auth.test.ts "refreshes once for three concurrent 401s under Task.WhenAll" (eight calls here) */
	it("refreshes once for eight overlapping 401s, and each call succeeds once with the one fresh token", () => {
		const ran = driven("http").run("Single", SINGLE)
		expect(
			{ diagnostics: ran.diagnostics, status: ran.status, out: ran.stdout.trim().split("\n") },
			ran.stderr,
		).toEqual({
			diagnostics: [],
			out: ["refreshes 1", "overlap true", "fresh 8", "answered 8"],
			status: 0,
		})
	})
})
