import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Consumer;
import java.util.function.Supplier;
import tools.jackson.databind.JsonNode;

/** The client a cell's setup and script make: the builder's setters by name, then its build. */
final class Config {
  private Config() {}

  /**
   * The client for the envelope's cell, configured by its setup and by the script when one is
   * given.
   */
  static Object client(Sdk sdk, JsonNode envelope, JsonNode script, Recorder recorder) {
    JsonNode target = Wire.member(envelope, "sdk");
    Class<?> client = sdk.type(Wire.text(target, "client"));
    Object builder = Reflect.invokeStatic(client, "builder");
    Reflect.call(builder, "baseUrl", Wire.text(envelope, "base"));
    setup(sdk, builder, Wire.member(Wire.member(envelope, "cell"), "setup"));
    if (script != null) {
      scripted(sdk, builder, script, recorder);
    }
    return Reflect.call(builder, "build");
  }

  private static void setup(Sdk sdk, Object builder, JsonNode setup) {
    if (setup == null) {
      return;
    }
    JsonNode auth = Wire.member(setup, "auth");
    if (auth != null && "bearer".equals(Wire.text(auth, "kind"))) {
      Reflect.call(builder, "bearerToken", Wire.text(auth, "token"));
    } else if (auth != null) {
      Reflect.call(builder, "apiKey", Wire.text(auth, "value"));
      Reflect.call(builder, "authHeaderName", Wire.text(auth, "name"));
      Reflect.call(builder, "authHeaderPrefix", "");
    }
    JsonNode headers = Wire.member(setup, "headers");
    if (headers != null) {
      Reflect.call(builder, "headers", stringMap(headers));
    }
    JsonNode timeout = Wire.member(setup, "timeoutMs");
    if (timeout != null) {
      Reflect.call(builder, "timeout", Duration.ofMillis(timeout.asLong()));
    }
    JsonNode redirect = Wire.member(setup, "redirect");
    if (redirect != null) {
      Reflect.call(builder, "redirect", redirectPolicy(sdk, Wire.text(setup, "redirect")));
    }
  }

  /**
   * The SDK's RedirectPolicy constant for a setup's redirect name, which Protocol has already
   * named.
   */
  private static Object redirectPolicy(Sdk sdk, String name) {
    String constant =
        switch (name) {
          case "follow" -> "ALL";
          case "same-origin" -> "SAME_ORIGIN";
          default -> "NONE";
        };
    for (Object value : sdk.type("RedirectPolicy").getEnumConstants()) {
      if (((Enum<?>) value).name().equals(constant)) {
        return value;
      }
    }
    throw new DriverException("the SDK has no RedirectPolicy." + constant);
  }

  /** The script's config, hooks, log and refresh, each installed only when the script names it. */
  private static void scripted(Sdk sdk, Object builder, JsonNode script, Recorder recorder) {
    JsonNode config = Wire.member(script, "config");
    if (config != null) {
      optional(builder, "authHeaderName", Wire.text(config, "authHeaderName"));
      optional(builder, "authHeaderPrefix", Wire.text(config, "authHeaderPrefix"));
      JsonNode cap = Wire.member(config, "maxResponseBytes");
      if (cap != null) {
        Reflect.call(builder, "maxResponseBytes", cap.asLong());
      }
      JsonNode invalidation = Wire.member(config, "invalidation");
      if (invalidation != null) {
        Reflect.call(builder, "invalidation", invalidation(sdk, invalidation));
      }
    }
    JsonNode hooks = Wire.member(script, "hooks");
    if (hooks != null) {
      /* one SDK hook per entry, as C#'s Script.cs installs its delegates: the SDK's own order runs them */
      java.util.List<JsonNode> requests = entriesOf(hooks, "request");
      for (int i = 0; i < requests.size(); i++) {
        Reflect.call(builder, "onRequest", requestHook(sdk, i, requests.get(i), recorder));
      }
      java.util.List<JsonNode> responses = entriesOf(hooks, "response");
      for (int i = 0; i < responses.size(); i++) {
        Reflect.call(builder, "onResponse", responseHook(sdk, i, responses.get(i), recorder));
      }
    }
    if (Wire.member(script, "onAuthExpired") != null) {
      Supplier<String> refresh = recorder::refresh;
      Reflect.call(builder, "onAuthExpired", refresh);
    }
    if (Wire.flag(script, "log")) {
      Consumer<Object> logger = recorder::log;
      Reflect.call(builder, "onLog", logger);
    }
  }

  /** The script's invalidation config: its stale time, and each cap the script names. */
  private static Object invalidation(Sdk sdk, JsonNode spec) {
    Object config = Reflect.invokeStatic(sdk.type("InvalidationConfig"), "builder");
    Reflect.call(config, "staleTime", Duration.ofMillis(spec.get("staleTimeMs").asLong()));
    JsonNode entries = Wire.member(spec, "staleMaxEntries");
    if (entries != null) {
      Reflect.call(config, "staleMaxEntries", entries.asInt());
    }
    JsonNode sources = Wire.member(spec, "maxSourcesPerTarget");
    if (sources != null) {
      Reflect.call(config, "maxSourcesPerTarget", sources.asInt());
    }
    return Reflect.call(config, "build");
  }

  private static void optional(Object builder, String name, String value) {
    if (value != null) {
      Reflect.call(builder, name, value);
    }
  }

  /**
   * One request hook that runs the script's request entries in order; an absent list is one no-op
   * entry.
   */
  /** The request hook for script entry {@code i}: it records the run and applies the entry. */
  private static Object requestHook(Sdk sdk, int i, JsonNode entry, Recorder recorder) {
    return proxy(
        sdk,
        "RequestHook",
        (proxy, method, args) -> {
          recorder.request(i, entry, args[0]);
          return null;
        });
  }

  /** The response hook for script entry {@code i}: it records the run and applies the entry. */
  private static Object responseHook(Sdk sdk, int i, JsonNode entry, Recorder recorder) {
    return proxy(
        sdk,
        "ResponseHook",
        (proxy, method, args) -> {
          recorder.response(i, entry, args[0]);
          return null;
        });
  }

  private static java.util.List<JsonNode> entriesOf(JsonNode hooks, String name) {
    JsonNode list = Wire.member(hooks, name);
    java.util.List<JsonNode> entries = new java.util.ArrayList<>();
    for (int i = 0; list != null && i < list.size(); i++) {
      entries.add(list.get(i));
    }
    if (entries.isEmpty()) {
      entries.add(Wire.object());
    }
    return entries;
  }

  /**
   * A proxy of the SDK's functional interface {@code iface}, answering its one method by {@code
   * handler}.
   */
  private static Object proxy(Sdk sdk, String iface, InvocationHandler handler) {
    return Proxy.newProxyInstance(
        Config.class.getClassLoader(), new Class<?>[] {sdk.type(iface)}, handler);
  }

  private static Map<String, String> stringMap(JsonNode node) {
    Map<String, String> map = new LinkedHashMap<>();
    for (var member : node.properties()) {
      map.put(member.getKey(), member.getValue().asString());
    }
    return map;
  }
}
