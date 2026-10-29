import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Map;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * What a call observed (the grid's Observed, null when the grid has no outcome for it), its traced
 * error and a safe-mode result's summary. An answer is its data, its bytes' digest or its raw
 * response; an ApiException is an error with its key and its body; a timeout is {@code {kind:
 * timeout}}, an ApiConnectionException {@code {kind: transport}} and a DecodeException {@code {kind:
 * decode}} with the raw box's status; any other failure has no outcome. A safe call's Result (bit
 * 21 i6) is read strictly: an answer it throws, a Result whose response is not the call's raw box,
 * an Ok on no 2xx and an Err whose response is not its error's each fail the run; its Ok observes
 * its data as a normal call's answer, its Err its error. A normal call answering a Result fails too.
 */
final class Observe {
  private Observe() {}

  /** One call's record: the observed, its error and its safe-mode result, each null when absent. */
  record Outcome(JsonNode observed, JsonNode error, JsonNode result, JsonNode stream) {
    Outcome(JsonNode observed, JsonNode error, JsonNode result) {
      this(observed, error, result, null);
    }
  }

  /**
   * What the script and the call ask for: the raw response, a traced run, the envelope in each
   * trace, the response headers' holder, and whether the call answers a Result (a safe call).
   */
  record Ask(boolean raw, boolean scripted, boolean envelope, Object holder, boolean result) {}

  /** A call that returned: a normal call's typed answer, or a safe call's Result. */
  static Outcome returned(Sdk sdk, JsonNode plan, Object answer, Object raw, Ask ask) {
    Outcome out = answeredOutcome(sdk, plan, answer, raw, ask);
    if (ask.holder() == null || out.observed() == null || !"data".equals(out.observed().path("kind").asString())) {
      return out;
    }
    ObjectNode seen = (ObjectNode) out.observed();
    seen.set("headers", headersOf(plan, ask.holder()));
    return new Outcome(seen, out.error(), out.result());
  }

  /** The `<Op>Headers` holder's fields, each declared header (as written) to its value; an absent optional one is absent. */
  static ObjectNode headersOf(JsonNode plan, Object holder) {
    ObjectNode headers = Wire.object();
    for (var field : Wire.member(Wire.member(plan, "responseHeaders"), "fields").properties()) {
      Object value = Reflect.call(holder, field.getValue().asString());
      if (value != null) {
        headers.put(field.getKey(), value.toString());
      }
    }
    return headers;
  }

  private static Outcome answeredOutcome(Sdk sdk, JsonNode plan, Object answer, Object raw, Ask ask) {
    if (!ask.result()) {
      if (instanceOf(sdk, "Result", answer)) {
        throw new DriverException("the normal call answered a Result: " + answer);
      }
      return new Outcome(answered(sdk, plan, answer, raw, ask), null, null);
    }
    Settled settled = settle(sdk, answer, raw, ask);
    if (settled.err() != null) {
      return settled.err();
    }
    return new Outcome(answered(sdk, plan, settled.data(), raw, ask), null, settled.summary());
  }

  /** A safe call's Result read: its Ok's data, or the Outcome its Err observes; and its summary. */
  record Settled(Object data, Outcome err, JsonNode summary) {}

  /**
   * A safe call's {@code result}, its response held to {@code raw} (the box the call passed): its
   * Ok's data, or the Outcome its Err observes. Anything but a Result fails the run, as does an Ok
   * on no 2xx and an Err whose response is not its error's (an ApiException's status, or a 2xx for
   * a DecodeException).
   */
  static Settled settle(Sdk sdk, Object result, Object raw, Ask ask) {
    if (!instanceOf(sdk, "Result", result)) {
      throw new DriverException(
          "the safe call answered no Result: "
              + (result == null ? "null" : result.getClass().getSimpleName()));
    }
    Object response = Reflect.call(result, "response");
    int status = response == null ? -1 : statusOf(Reflect.call(response, "status"));
    if (response != raw) {
      throw new DriverException("a Result whose response (" + status + ") is not the call's answer");
    }
    boolean success = status >= 200 && status < 300;
    if ((Boolean) Reflect.call(result, "isOk")) {
      if (!success) {
        throw new DriverException("a Result Ok whose response (" + status + ") is no 2xx");
      }
      Object data = Reflect.call(result, "data");
      return new Settled(data, null, resultOf(data != null, true, true, status));
    }
    Throwable error = (Throwable) Reflect.call(result, "error");
    boolean held =
        instanceOf(sdk, "ApiException", error)
            ? statusOf(Reflect.call(error, "status")) == status
            : instanceOf(sdk, "DecodeException", error) && success;
    if (!held) {
      throw new DriverException(
          "a Result Err whose response ("
              + status
              + ") is not its error's: "
              + error.getClass().getSimpleName()
              + ": "
              + error.getMessage());
    }
    JsonNode trace = ask.scripted() ? Traces.error(sdk, error, "result", ask.envelope()) : null;
    JsonNode summary = resultOf(false, false, true, status);
    return new Settled(null, new Outcome(graded(sdk, error, raw, ask), trace, summary), summary);
  }

  /**
   * A call that threw: a status error or a timeout is observed; any failure is traced under a
   * script. A safe call that throws an answer (an ApiException or a DecodeException) fails the run:
   * it returns one as its Result.
   */
  static Outcome thrown(Sdk sdk, Throwable error, Object raw, Ask ask) {
    if (ask.result() && (instanceOf(sdk, "ApiException", error) || instanceOf(sdk, "DecodeException", error))) {
      throw new DriverException(
          "the safe call threw an API answer, not a Result: "
              + error.getClass().getSimpleName()
              + ": "
              + error.getMessage());
    }
    JsonNode seen = graded(sdk, error, raw, ask);
    JsonNode trace = ask.scripted() ? Traces.error(sdk, error, "return", ask.envelope()) : null;
    if (seen == null && trace == null) {
      throw new DriverException(
          "the call threw "
              + error.getClass().getSimpleName()
              + ", which the grid has no outcome for: "
              + error.getMessage());
    }
    return new Outcome(seen, trace, null);
  }

  /**
   * A status error, an answer that did not decode (its status the raw box's: DecodeException holds
   * none) or no answer as the grid observes it, else null.
   */
  static JsonNode graded(Sdk sdk, Throwable error, Object raw, Ask ask) {
    if (instanceOf(sdk, "ApiException", error)) {
      return errorOf(error, raw, ask);
    }
    if (instanceOf(sdk, "DecodeException", error)) {
      return Wire.object().put("kind", "decode").put("status", statusOf(Reflect.call(raw, "status")));
    }
    String failed = noAnswer(sdk, error);
    return failed == null ? null : Wire.object().put("kind", failed);
  }

  /** A failure with no answer as the grid names it: {@code timeout} or {@code transport}, else null. */
  static String noAnswer(Sdk sdk, Throwable error) {
    if (instanceOf(sdk, "ApiTimeoutException", error)) {
      return "timeout";
    }
    return instanceOf(sdk, "ApiConnectionException", error) ? "transport" : null;
  }

  static boolean instanceOf(Sdk sdk, String simple, Object value) {
    Class<?> type = sdk.findType(simple);
    return type != null && type.isInstance(value);
  }

  /**
   * A 2xx answer as observed: the raw response when asked, else its data by the operation's answer
   * kind.
   */
  private static JsonNode answered(Sdk sdk, JsonNode plan, Object answer, Object raw, Ask ask) {
    if (ask.raw()) {
      return rawOf(raw);
    }
    String kind = Wire.text(plan, "response");
    int status = statusOf(Reflect.call(raw, "status"));
    if ("binary".equals(kind)) {
      byte[] bytes = (byte[]) answer;
      return Wire.object()
          .put("kind", "bytes")
          .put("sha256", digest(bytes))
          .put("size", bytes.length)
          .put("status", status);
    }
    JsonNode data =
        answer == null ? null : "text".equals(kind) ? Wire.value(answer) : sdk.toTree(answer);
    if (data == null && "none".equals(kind)) {
      data = bodyOf((byte[]) Reflect.call(raw, "body"));
    }
    return Wire.object()
        .put("kind", "data")
        .put("status", status)
        .set("data", data == null ? Wire.JSON.getNodeFactory().nullNode() : data);
  }

  /**
   * An ApiException as observed: its raw response when asked, else its key, its status and its
   * body.
   */
  private static JsonNode errorOf(Throwable error, Object raw, Ask ask) {
    if (ask.raw()) {
      return rawOf(raw);
    }
    byte[] body = (byte[]) Reflect.call(error, "body");
    Object key = Reflect.call(error, "key");
    ObjectNode seen = Wire.object();
    seen.set("errorKey", Wire.nullable(key));
    seen.put("kind", "error");
    seen.put("status", statusOf(Reflect.call(error, "status")));
    if (body.length > 0) {
      seen.set("body", bodyOf(body));
    }
    return seen;
  }

  /** The raw response as observed: its body as text, every header by its lower-case name. */
  static JsonNode rawOf(Object raw) {
    ObjectNode headers = Wire.object();
    Map<?, ?> lines = (Map<?, ?>) Reflect.call(raw, "headers");
    for (Map.Entry<?, ?> line : lines.entrySet()) {
      headers.put(line.getKey().toString().toLowerCase(Locale.ROOT), line.getValue().toString());
    }
    byte[] body = (byte[]) Reflect.call(raw, "body");
    return Wire.object()
        .put("body", new String(body, StandardCharsets.UTF_8))
        .put("kind", "raw")
        .put("status", statusOf(Reflect.call(raw, "status")))
        .set("headers", headers);
  }

  /** A non-empty body as its JSON, or its text when it is no JSON. */
  static JsonNode bodyOf(byte[] body) {
    try {
      return Wire.JSON.readTree(body);
    } catch (RuntimeException e) {
      return Wire.value(new String(body, StandardCharsets.UTF_8));
    }
  }

  private static ObjectNode resultOf(boolean data, boolean ok, boolean response, int status) {
    return Wire.object()
        .put("data", data)
        .put("ok", ok)
        .put("response", response)
        .put("status", status);
  }

  private static int statusOf(Object value) {
    return (Integer) value;
  }

  private static String digest(byte[] bytes) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    } catch (NoSuchAlgorithmException e) {
      throw new DriverException("no SHA-256: " + e.getMessage());
    }
  }
}
