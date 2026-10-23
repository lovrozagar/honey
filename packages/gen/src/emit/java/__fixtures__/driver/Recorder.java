import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * What a scripted run records beside the observed (protocol.ts Trace): the calls, the hook runs,
 * the log, the refreshes.
 */
final class Recorder {
  private final ArrayNode calls = Wire.array();
  private final ArrayNode hooks = Wire.array();
  private final ArrayNode log = Wire.array();
  private final List<String> tokens = new ArrayList<>();
  private final boolean durations;
  private int current;
  private String operation = "";
  private int expired;

  /** A recorder for {@code script} (null for none): its log durations and its refresh tokens. */
  Recorder(JsonNode script) {
    this.durations = Wire.flag(script, "logDurations");
    JsonNode refresh = Wire.member(Wire.member(script, "onAuthExpired"), "tokens");
    for (int i = 0; refresh != null && i < refresh.size(); i++) {
      tokens.add(refresh.get(i).asString());
    }
  }

  /** Call {@code index} of {@code operation} is the one now running: its hook runs are its own. */
  void begin(int index, String operation) {
    this.current = index;
    this.operation = operation;
  }

  void called(long elapsedMs, Observe.Outcome outcome) {
    ObjectNode entry = Wire.object();
    entry.put("elapsedMs", elapsedMs);
    if (outcome.error() != null) {
      entry.set("error", outcome.error());
    }
    if (outcome.result() != null) {
      entry.set("result", outcome.result());
    }
    if (outcome.stream() != null) {
      entry.set("stream", outcome.stream());
    }
    calls.add(entry);
  }

  ObjectNode trace() {
    ObjectNode trace = Wire.object();
    trace.put("authExpired", expired);
    trace.set("calls", calls);
    trace.set("hooks", hooks);
    trace.set("log", log);
    return trace;
  }

  /**
   * One request hook run for call {@code current}: its trace, then its header change, then its
   * failure.
   */
  void request(int index, JsonNode entry, Object context) {
    String url = Reflect.call(context, "url").toString();
    ObjectNode seen = hookOf("request", index, context);
    seen.put("method", (String) Reflect.call(context, "method"));
    seen.put("path", URI.create(url).getRawPath());
    seen.put("url", url);
    hooks.add(seen);
    JsonNode set = Wire.member(entry, "setHeader");
    if (set != null) {
      Reflect.call(
          Reflect.call(context, "headers"), "put", set.get(0).asString(), set.get(1).asString());
    }
    String fail = Wire.text(entry, "fail");
    if (fail != null) {
      throw new IllegalStateException(fail);
    }
  }

  /**
   * One response hook run for call {@code current}: its trace, then its body change, then its
   * failure.
   */
  void response(int index, JsonNode entry, Object context) {
    ObjectNode seen = hookOf("response", index, context);
    seen.put("status", (Integer) Reflect.call(context, "status"));
    hooks.add(seen);
    String body = Wire.text(entry, "body");
    if (body != null) {
      Reflect.call(context, "body", body.getBytes(StandardCharsets.UTF_8));
    }
    String fail = Wire.text(entry, "fail");
    if (fail != null) {
      throw new IllegalStateException(fail);
    }
  }

  /** The refresh the SDK asked for: the i-th answers tokens[i], and the one past the end fails. */
  String refresh() {
    expired++;
    if (expired > tokens.size()) {
      throw new IllegalStateException("driver: no token left");
    }
    return tokens.get(expired - 1);
  }

  /** One OnLog entry, its error as text, its duration only under logDurations. */
  void log(Object entry) {
    ObjectNode seen = Wire.object();
    seen.put("event", (String) Reflect.call(entry, "event"));
    seen.put("level", (String) Reflect.call(entry, "level"));
    seen.put("operation", (String) Reflect.call(entry, "operation"));
    Object status = Reflect.call(entry, "status");
    if (status != null) {
      seen.put("status", (Integer) status);
    }
    Object error = Reflect.call(entry, "error");
    if (error != null) {
      seen.put("error", (String) error);
    }
    if (durations) {
      seen.put("durationMs", (Long) Reflect.call(entry, "durationMs"));
    }
    log.add(seen);
  }

  /** A hook's trace; the stale view and the selector are the SDK's only when it ships stale tracking. */
  private ObjectNode hookOf(String phase, int index, Object context) {
    ObjectNode seen = Wire.object();
    seen.put("call", current);
    seen.put("index", index);
    seen.set("invalidatedBy", invalidatedBy(context));
    seen.put("isRetry", (Boolean) Reflect.call(context, "isRetry"));
    seen.put("isStale", Reflect.has(context, "isStale") && (Boolean) Reflect.call(context, "isStale"));
    seen.put("phase", phase);
    seen.put("selector", Reflect.has(context, "selector") ? (String) Reflect.call(context, "selector") : operation);
    return seen;
  }

  /** The mutations that stale a hook's call, none when the SDK ships no stale tracking. */
  private static ArrayNode invalidatedBy(Object context) {
    ArrayNode by = Wire.array();
    if (Reflect.has(context, "invalidatedBy")) {
      for (Object source : (List<?>) Reflect.call(context, "invalidatedBy")) {
        by.add((String) source);
      }
    }
    return by;
  }
}
