import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.concurrent.CancellationException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * A call's error as the trace records it (protocol.ts JavaError): its class, its text, and an
 * ApiException's members.
 */
final class Traces {
  private Traces() {}

  static JsonNode error(Sdk sdk, Throwable error, String via, boolean envelope) {
    String type = error.getClass().getSimpleName();
    ObjectNode seen = Wire.object();
    seen.put("type", type);
    seen.set("chain", chain(sdk, error.getClass(), type));
    seen.set("text", Wire.nullable(error.getMessage()));
    seen.put("display", error.toString().split("\n", 2)[0]);
    seen.put("via", via);
    seen.set(
        "inner",
        Wire.nullable(
            error.getCause() == null ? null : error.getCause().getClass().getSimpleName()));
    seen.put("canceled", error instanceof CancellationException);
    if (sdk.findType("ApiException") != null && sdk.findType("ApiException").isInstance(error)) {
      apiMembers(sdk, error, seen, envelope);
    }
    return seen;
  }

  /**
   * The simple names from {@code type} up to and including the SDK's HoneyException, or just {@code
   * [type]} outside it.
   */
  private static ArrayNode chain(Sdk sdk, Class<?> type, String name) {
    List<String> names = new ArrayList<>();
    boolean honey = false;
    for (Class<?> at = type; at != null; at = at.getSuperclass()) {
      names.add(at.getSimpleName());
      if (at.getSimpleName().equals("HoneyException") && sdk.pkg().equals(at.getPackageName())) {
        honey = true;
        break;
      }
    }
    ArrayNode chain = Wire.array();
    for (String part : honey ? names : List.of(name)) {
      chain.add(part);
    }
    return chain;
  }

  private static void apiMembers(Sdk sdk, Throwable error, ObjectNode seen, boolean envelope) {
    Object key = Reflect.call(error, "key");
    seen.put("status", (Integer) Reflect.call(error, "status"));
    seen.set("key", Wire.nullable(key));
    seen.set("keyMember", Wire.nullable(key == null ? null : keyMember(sdk, (String) key)));
    seen.set("message", Wire.nullable(Reflect.call(error, "detail")));
    if (envelope) {
      seen.set("envelope", envelopeOf(Reflect.call(error, "envelope")));
    }
  }

  /** The name of the ErrorKey constant whose value is {@code key}, or null when none is. */
  private static String keyMember(Sdk sdk, String key) {
    Class<?> keys = sdk.findType("ErrorKey");
    if (keys == null) {
      return null;
    }
    for (Field field : keys.getFields()) {
      if (Modifier.isStatic(field.getModifiers()) && key.equals(constant(field))) {
        return field.getName();
      }
    }
    return null;
  }

  private static Object constant(Field field) {
    try {
      return field.get(null);
    } catch (IllegalAccessException e) {
      throw new DriverException("ErrorKey." + field.getName() + " is not readable");
    }
  }

  /**
   * The envelope's set members (status, error_key, status_key, message, fields) and its extra keys,
   * sorted.
   */
  private static ObjectNode envelopeOf(Object envelope) {
    ObjectNode seen = Wire.object();
    Object status = Reflect.call(envelope, "status");
    if (status != null) {
      seen.put("status", (Integer) status);
    }
    setIfPresent(seen, "error_key", Reflect.call(envelope, "errorKey"));
    setIfPresent(seen, "status_key", Reflect.call(envelope, "statusKey"));
    setIfPresent(seen, "message", Reflect.call(envelope, "message"));
    Map<?, ?> fields = (Map<?, ?>) Reflect.call(envelope, "fields");
    if (!fields.isEmpty()) {
      seen.set("fields", fieldsOf(fields));
    }
    ArrayNode extra = Wire.array();
    for (String name :
        new TreeSet<>(
            ((Map<?, ?>) Reflect.call(envelope, "extra"))
                .keySet().stream().map(Object::toString).toList())) {
      extra.add(name);
    }
    seen.set("extraKeys", extra);
    return seen;
  }

  private static ObjectNode fieldsOf(Map<?, ?> fields) {
    ObjectNode out = Wire.object();
    for (Map.Entry<?, ?> field : fields.entrySet()) {
      ArrayNode errors = Wire.array();
      for (Object error : (List<?>) field.getValue()) {
        ObjectNode seen = Wire.object();
        seen.set("error_key", Wire.nullable(Reflect.call(error, "errorKey")));
        seen.set("message", Wire.nullable(Reflect.call(error, "message")));
        seen.set("path", Wire.nullable(Reflect.call(error, "path")));
        errors.add(seen);
      }
      out.set(field.getKey().toString(), errors);
    }
    return out;
  }

  private static void setIfPresent(ObjectNode seen, String name, Object value) {
    if (value != null) {
      seen.put(name, (String) value);
    }
  }
}
