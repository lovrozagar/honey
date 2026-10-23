import java.util.Set;
import tools.jackson.databind.JsonNode;

/**
 * The refusals: what the driver cannot drive, or a script it does not accept, named before any call
 * is sent.
 */
final class Protocol {
  private static final Set<String> SCRIPT =
      Set.of("calls", "config", "hooks", "log", "logDurations", "onAuthExpired");
  private static final Set<String> CALL_SCRIPT =
      Set.of(
          "cancel",
          "envelope",
          "idempotencyKey",
          "oneShotBody",
          "protocols",
          "realtime",
          "sleepMs",
          "ws");
  private static final Set<String> CONFIG =
      Set.of("authHeaderName", "authHeaderPrefix", "invalidation", "maxResponseBytes");
  private static final Set<String> REQUEST_HOOK = Set.of("fail", "setHeader");
  private static final Set<String> RESPONSE_HOOK = Set.of("body", "fail");
  /** A call's stream controls: the members that read, resume or send on a stream. */
  private static final String[] STREAM_CALL = {"take", "send", "lastEventId", "reconnectToken"};

  private Protocol() {}

  /** Refuses the envelope's cell and script, the first problem found, before the SDK loads. */
  static void check(JsonNode envelope, JsonNode script) {
    JsonNode cell = Wire.member(envelope, "cell");
    JsonNode calls = Wire.member(cell, "calls");
    JsonNode setup = Wire.member(cell, "setup");
    if (setup != null) {
      setupRefusal(setup);
    }
    for (int i = 0; i < calls.size(); i++) {
      callRefusal(envelope, i, calls.get(i), script == null ? null : entry(script, i));
    }
    if (script != null) {
      scriptRefusal(script, calls.size());
    }
  }

  /** The script's entry for call {@code i}, or null when it has none. */
  static JsonNode entry(JsonNode script, int i) {
    JsonNode entries = Wire.member(script, "calls");
    return entries == null || i >= entries.size() ? null : nonNull(entries.get(i));
  }

  private static JsonNode nonNull(JsonNode node) {
    return node == null || node.isNull() ? null : node;
  }

  private static void setupRefusal(JsonNode setup) {
    String redirect = Wire.text(setup, "redirect");
    if (redirect != null && !Set.of("follow", "same-origin", "none").contains(redirect)) {
      throw new DriverException("setup: redirect " + redirect + " is not one the driver knows");
    }
    JsonNode auth = Wire.member(setup, "auth");
    if (auth != null) {
      String kind = Wire.text(auth, "kind");
      if (!"bearer".equals(kind) && !"header".equals(kind)) {
        throw new DriverException("setup: auth " + kind + " is not one the driver knows");
      }
    }
  }

  private static void callRefusal(JsonNode envelope, int i, JsonNode call, JsonNode entry) {
    String op = Wire.text(call, "operation");
    JsonNode plan = Wire.member(Wire.member(envelope, "plans"), op);
    if (plan == null) {
      throw new DriverException("no call plan names " + op + " (call " + i + ")");
    }
    String stream = Wire.text(plan, "stream");
    String reason =
        stream == null ? plainReason(call, entry) : "sse".equals(stream) ? sseReason(call, entry) : later(stream);
    if (reason != null) {
      throw new DriverException("call " + i + " (" + op + "): " + reason);
    }
  }

  /** What a call on an operation that does not stream cannot take: any stream control. */
  private static String plainReason(JsonNode call, JsonNode entry) {
    for (String member : STREAM_CALL) {
      if (Wire.member(call, member) != null) {
        return member + " on an operation that does not stream";
      }
    }
    if (Wire.member(entry, "protocols") != null) {
      return "protocols on an operation that does not stream";
    }
    for (String control : new String[] {"realtime", "ws"}) {
      if (Wire.member(entry, control) != null) {
        return "a " + control + " script on an operation that does not stream";
      }
    }
    return null;
  }

  /** What a call on an SSE operation cannot take: what only a WebSocket or realtime call does, or raw. */
  private static String sseReason(JsonNode call, JsonNode entry) {
    if (Wire.member(call, "send") != null) {
      return "send on an SSE operation: only a WebSocket or realtime call sends";
    }
    if (Wire.member(call, "reconnectToken") != null) {
      return "reconnectToken on an SSE operation: only a WebSocket or realtime call resumes by token";
    }
    if (Wire.member(entry, "protocols") != null) {
      return "protocols on an SSE operation: only a WebSocket or realtime dial offers subprotocols";
    }
    for (String control : new String[] {"realtime", "ws"}) {
      if (Wire.member(entry, control) != null) {
        return "a " + control + " script on an SSE operation";
      }
    }
    if (Wire.flag(call, "raw")) {
      return "raw: true on an SSE operation, which has no single response to read";
    }
    return null;
  }

  /** A WebSocket or realtime operation: driven from phase d2. */
  private static String later(String stream) {
    return ("ws".equals(stream) ? "a WebSocket" : "a realtime") + " operation is driven from phase d2";
  }

  private static void scriptRefusal(JsonNode script, int cellCalls) {
    members(script, SCRIPT, "script");
    JsonNode entries = Wire.member(script, "calls");
    if (entries != null && entries.size() > cellCalls) {
      throw new DriverException(
          "script: " + entries.size() + " calls scripted for a cell of " + cellCalls);
    }
    for (int i = 0; entries != null && i < entries.size(); i++) {
      JsonNode entry = entry(script, i);
      if (entry != null) {
        othersRefusal(i, entry);
        members(entry, CALL_SCRIPT, "script: call " + i);
        cancelRefusal(i, Wire.member(entry, "cancel"));
      }
    }
    configRefusal(Wire.member(script, "config"));
    hooksRefusal(Wire.member(script, "hooks"));
    if (Wire.flag(script, "logDurations") && !Wire.flag(script, "log")) {
      throw new DriverException("script: logDurations needs log");
    }
  }

  /** A script control another driver takes, refused by what it is there and what a Java call has instead. */
  private static void othersRefusal(int i, JsonNode entry) {
    if (Wire.member(entry, "taskCancel") != null) {
      throw new DriverException(
          "script: call " + i + ": taskCancel is a Python AsyncSDK task's; a Java call ends by its"
              + " thread's interrupt (cancel)");
    }
    if (Wire.member(entry, "isErrors") != null) {
      throw new DriverException(
          "script: call " + i + ": isErrors is Go's errors.Is; the Java trace records the type and text");
    }
  }

  private static void cancelRefusal(int i, JsonNode cancel) {
    if (cancel == null || "before".equals(cancel.asString(""))) {
      return;
    }
    JsonNode ms = Wire.member(cancel, "afterMs");
    if (ms == null
        || !cancel.isObject()
        || cancel.size() != 1
        || !ms.isNumber()
        || ms.asInt() <= 0) {
      throw new DriverException(
          "script: call " + i + ": cancel is \"before\" or {\"afterMs\": n}, n > 0");
    }
  }

  private static void configRefusal(JsonNode config) {
    if (config != null) {
      members(config, CONFIG, "script: config");
    }
  }

  private static void hooksRefusal(JsonNode hooks) {
    if (hooks == null) {
      return;
    }
    members(hooks, Set.of("request", "response"), "script: hooks");
    for (JsonNode hook : items(hooks, "request")) {
      members(hook, REQUEST_HOOK, "script: request hook");
    }
    for (JsonNode hook : items(hooks, "response")) {
      members(hook, RESPONSE_HOOK, "script: response hook");
    }
  }

  private static java.util.List<JsonNode> items(JsonNode node, String name) {
    JsonNode list = Wire.member(node, name);
    java.util.List<JsonNode> items = new java.util.ArrayList<>();
    for (int i = 0; list != null && i < list.size(); i++) {
      items.add(list.get(i));
    }
    return items;
  }

  /** Every member of {@code node} is one of {@code allowed}; a stranger is refused by name. */
  private static void members(JsonNode node, Set<String> allowed, String where) {
    for (var member : node.properties()) {
      if (!allowed.contains(member.getKey())) {
        throw new DriverException(where + ": unknown member " + member.getKey());
      }
    }
  }
}
