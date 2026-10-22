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
      Set.of("cancel", "envelope", "idempotencyKey", "sleepMs");
  private static final Set<String> CONFIG = Set.of("authHeaderName", "authHeaderPrefix");
  private static final Set<String> REQUEST_HOOK = Set.of("fail", "setHeader");
  private static final Set<String> RESPONSE_HOOK = Set.of("body", "fail");
  private static final Set<String> PHASE_D =
      Set.of("lastEventId", "reconnectToken", "send", "take");

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
      callRefusal(envelope, i, calls.get(i));
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
    if (Wire.member(setup, "redirect") != null) {
      throw new DriverException("setup: redirect is not driven by the Java driver until phase c2");
    }
    JsonNode auth = Wire.member(setup, "auth");
    if (auth != null) {
      String kind = Wire.text(auth, "kind");
      if (!"bearer".equals(kind) && !"header".equals(kind)) {
        throw new DriverException("setup: auth " + kind + " is not one the driver knows");
      }
    }
  }

  private static void callRefusal(JsonNode envelope, int i, JsonNode call) {
    String op = Wire.text(call, "operation");
    JsonNode plan = Wire.member(Wire.member(envelope, "plans"), op);
    if (plan == null) {
      throw new DriverException("no call plan names " + op + " (call " + i + ")");
    }
    String reason = reasonFor(call, plan);
    if (reason != null) {
      throw new DriverException("call " + i + " (" + op + "): " + reason);
    }
  }

  private static String reasonFor(JsonNode call, JsonNode plan) {
    if (Wire.member(plan, "stream") != null) {
      return "streaming operations are driven from phase d";
    }
    for (String member : PHASE_D) {
      if (Wire.member(call, member) != null) {
        return member + " is not driven by the Java driver until phase d";
      }
    }
    JsonNode body = Wire.member(call, "body");
    if (body != null && "binary".equals(Wire.text(body, "kind"))) {
      return "binary bodies are driven from phase c2";
    }
    return null;
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
