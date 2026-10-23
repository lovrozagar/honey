/**
 * The realtime transport legs' program harness (bit 16 phase d2b): a consumer program in the SDK's package (its mapper
 * and the default adapters' classes) that runs named sections, each guarded (a throwing one notes `raised <Type>:
 * <text>` and the program goes on), its notes printed as JSON; beside it, a caller's in-process adapter (`DECLS`). Each
 * program runs once per name, against its own server.
 */
import { type RecordedHop, type Reply, served } from "../../shared/__fixtures__/recording-server.ts"
import { drivenRealtime } from "./realtime.ts"

/**
 * Beside `Probe`, a caller's in-process adapter. `Conn` delivers its texts, then `then`: "hold" until closed (its receive
 * then answers null, as a closed transport does; `waiting` counts down once it holds), "fail" (ApiConnectionException
 * "reset") or "end" (null, a clean end). `Fake` opens its conns in order after each one's delay (an interrupt honored as
 * CancellationException), a null one or one past the end refusing with ApiConnectionException("refused"), and records
 * each connect's cursor as `<lastEventId>/<reconnectToken>` and the connection's state then (`rc`, once set);
 * `redialed` counts down once a second connect starts.
 */
const DECLS = `
final class Conn implements TransportConnection {
  private final Deque<String> texts;
  private final String then;
  final int delayMs;
  final List<String> sent = Collections.synchronizedList(new ArrayList<>());
  volatile boolean closed;
  private final CountDownLatch gone = new CountDownLatch(1);
  final CountDownLatch waiting = new CountDownLatch(1);

  Conn(List<String> texts, String then, int delayMs) {
    this.texts = new ArrayDeque<>(texts);
    this.then = then;
    this.delayMs = delayMs;
  }

  Conn(List<String> texts, String then) {
    this(texts, then, 0);
  }

  Conn(List<String> texts) {
    this(texts, "hold", 0);
  }

  @Override
  public TransportMessage receive() {
    String text = texts.poll();
    if (text != null) {
      return new TransportMessage(text, null, null);
    }
    if (then.equals("fail")) {
      throw new ApiConnectionException("reset", null);
    }
    if (then.equals("hold")) {
      waiting.countDown();
      try {
        gone.await();
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        throw new CancellationException("the read was canceled");
      }
    }
    return null;
  }

  @Override
  public void send(String text) {
    sent.add(text);
  }

  @Override
  public void close() {
    closed = true;
    gone.countDown();
  }
}

final class Fake implements TransportAdapter {
  private final TransportKind kind;
  private final List<Conn> conns;
  private int next;
  final List<String> got = Collections.synchronizedList(new ArrayList<>());
  final List<String> states = Collections.synchronizedList(new ArrayList<>());
  volatile ResumableConnection<JsonNode> rc;
  final CountDownLatch redialed = new CountDownLatch(1);

  Fake(TransportKind kind, Conn... conns) {
    this.kind = kind;
    this.conns = Arrays.asList(conns);
  }

  @Override
  public String name() {
    return "fake";
  }

  @Override
  public TransportKind kind() {
    return kind;
  }

  @Override
  public TransportConnection connect(String url, TransportOptions options) {
    got.add(Rt.s(options.lastEventId()) + "/" + Rt.s(options.reconnectToken()));
    states.add(rc == null ? "" : rc.state().toString());
    if (got.size() > 1) {
      redialed.countDown();
    }
    Conn conn = next < conns.size() ? conns.get(next++) : null;
    if (conn == null) {
      throw new ApiConnectionException("refused", null);
    }
    try {
      Thread.sleep(conn.delayMs);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new CancellationException("the connect was canceled");
    }
    return conn;
  }
}

final class Rt {
  static final TypeReference<JsonNode> ELEMENT = new TypeReference<JsonNode>() {};

  static String s(String value) {
    return value == null ? "" : value;
  }

  static String json(Object value) {
    return Json.MAPPER.writeValueAsString(value);
  }

  static String j(Object... items) {
    return json(Arrays.asList(items));
  }

  static String failed(Throwable e) {
    return e.getClass().getSimpleName() + ": " + e.getMessage();
  }

  static String proven(ResumableConnection<?> c) {
    TransportKind kind = c.provenTransport();
    return kind == null ? "none" : kind.toString().replace("_", "").toLowerCase(Locale.ROOT);
  }

  static String cursor(ResumableConnection<JsonNode> c) {
    return s(c.options().lastEventId()) + "/" + s(c.options().reconnectToken()) + " " + c.provenTransport() + " " + c.state();
  }

  static Object[] named(TransportAdapter a) {
    boolean typed =
        a instanceof WsAdapter
            ? a.kind() == TransportKind.WS
            : a instanceof SseAdapter
                ? a.kind() == TransportKind.SSE
                : a instanceof LongPollAdapter && a.kind() == TransportKind.LONG_POLL;
    return new Object[] {a.name(), a.kind().toString(), typed};
  }

  static RequestHook hook(List<String[]> into) {
    return ctx -> {
      String query = ctx.url().getRawQuery();
      into.add(new String[] {ctx.url().getRawPath() + (query == null ? "" : "?" + query), ctx.url().getPath()});
    };
  }

  /* n values, each read within 5 s on its own thread; a null or a failure counts as one */
  static List<Object> take(ResumableConnection<JsonNode> rc, int n) throws Exception {
    List<Object> taken = new ArrayList<>();
    while (taken.size() < n) {
      CompletableFuture<JsonNode> next = CompletableFuture.supplyAsync(rc::receive);
      try {
        taken.add(next.get(5, TimeUnit.SECONDS));
      } catch (TimeoutException e) {
        taken.add("stalled");
        return taken;
      } catch (ExecutionException e) {
        taken.add(failed(e.getCause()));
      }
    }
    return taken;
  }

  static String send(ResumableConnection<JsonNode> rc, int n) {
    try {
      rc.sendJson(Json.MAPPER.readTree("{\\"hi\\":" + n + "}"));
      return j("sent");
    } catch (RuntimeException e) {
      return j(failed(e), rc.state().toString());
    }
  }
}
`

/** A consumer program in the SDK's package against `url`: `GUARDED` sections, the notes printed as JSON. */
export const program = (url: string, sections: Readonly<Record<string, string>>) => `package ai.anyrow;

import java.net.URI;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.JsonNode;

public class Probe {
  static final String BASE = "${url}";
  static final Map<String, List<String>> OUT = new LinkedHashMap<>();
  static String at = "main";

  interface Section {
    void run() throws Exception;
  }

  static void note(Object value) {
    OUT.computeIfAbsent(at, k -> new ArrayList<>()).add(String.valueOf(value));
  }

  static void guarded(String name, Section section) {
    at = name;
    try {
      section.run();
    } catch (Exception e) {
      note("raised " + Rt.failed(e));
    }
    Thread.interrupted();
  }

  static FeedLiveParams feed() {
    return FeedLiveParams.builder().channel("c").build();
  }

  public static void main(String[] args) throws Exception {
${Object.entries(sections)
	.map(([name, text]) => `    guarded(${JSON.stringify(name)}, () -> {\n${indent(text, "      ")}\n    });`)
	.join("\n")}
    System.out.println(Json.MAPPER.writeValueAsString(OUT));
    System.exit(0);
  }
}
${DECLS}`

/** `text`, each line indented by `by`. */
const indent = (text: string, by: string) =>
	text
		.split("\n")
		.map((line) => (line === "" ? "" : `${by}${line}`))
		.join("\n")

/** A program's end: its notes by section when it ran to its end, and its stderr. */
export type Run = { readonly out?: Record<string, string[]>; readonly ran: boolean; readonly stderr: string }
/** A program's run and every hop its server saw. */
type Served = { readonly hops: readonly RecordedHop[]; readonly run: Run }

/**
 * A `servedRun` for one test file: program `name` running `sections` against its own server answering `replies`, once
 * per name (the file's legs share each run).
 */
export function runner() {
	const runs = new Map<string, Promise<Served>>()
	return (name: string, sections: Readonly<Record<string, string>>, replies: readonly Reply[]): Promise<Served> => {
		const run =
			runs.get(name) ??
			served(replies, async (server) => {
				const ran = await drivenRealtime().exec("ai.anyrow.Probe", program(server.url, sections))
				const out = ran.status === 0 ? (JSON.parse(ran.stdout) as Record<string, string[]>) : undefined
				const stderr = `${ran.diagnostics.join("\n")}${ran.stderr}`
				return { hops: [...server.hops], run: { out, ran: ran.status === 0, stderr } }
			})
		runs.set(name, run)
		return run
	}
}

/** A note as the test reads it: its JSON value, else the text. */
function read(line: string): unknown {
	try {
		return JSON.parse(line) as unknown
	} catch {
		return line
	}
}

/** Section `name` of `run`: whether the program ran to its end, and the section's notes. */
export const notesOf = (run: Run, name: string) => ({ notes: run.out?.[name]?.map(read), ran: run.ran })
