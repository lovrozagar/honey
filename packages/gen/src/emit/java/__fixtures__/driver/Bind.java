import java.lang.reflect.Method;
import java.util.LinkedHashMap;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/**
 * The call's values by the plan's names: path params, the body, the query, the declared headers and
 * the idempotency key, each bound to its builder setter by the record field's name, and the
 * undeclared headers left for the options.
 */
final class Bind {
  private Bind() {}

  /**
   * The record field of each value the call gives, in the plan's order; a DriverException for one
   * the method lacks.
   */
  static Map<String, JsonNode> fields(JsonNode plan, JsonNode call, JsonNode entry) {
    Map<String, JsonNode> fields = new LinkedHashMap<>();
    pathFields(plan, call, fields);
    JsonNode body = Wire.member(call, "body");
    JsonNode planBody = Wire.member(plan, "body");
    if (body != null && planBody != null) {
      fields.put(Wire.text(planBody, "param"), body.get("value"));
    }
    queryFields(plan, call, fields);
    for (var header : members(call, "headers")) {
      String param = declared(plan, header.getKey());
      if (param != null) {
        fields.put(param, header.getValue());
      }
    }
    String key = Wire.text(entry, "idempotencyKey");
    if (key != null) {
      String param = Wire.text(plan, "idempotencyKey");
      if (param == null) {
        throw new DriverException(
            "the script sets idempotencyKey, and the method has no idempotency key field");
      }
      fields.put(param, Wire.value(key));
    }
    return fields;
  }

  /** The call's headers no declared header param takes: they go in the request options. */
  static Map<String, String> extraHeaders(JsonNode plan, JsonNode call) {
    Map<String, String> extra = new LinkedHashMap<>();
    for (var header : members(call, "headers")) {
      if (declared(plan, header.getKey()) == null) {
        extra.put(header.getKey(), header.getValue().asString());
      }
    }
    return extra;
  }

  /**
   * The {@code <Op>Params} built from {@code fields} through its builder: one setter per field,
   * then build().
   */
  static Object params(Sdk sdk, JsonNode plan, Map<String, JsonNode> fields) {
    Class<?> type = sdk.type(Wire.text(plan, "params"));
    Object builder = Reflect.invokeStatic(type, "builder");
    for (Map.Entry<String, JsonNode> field : fields.entrySet()) {
      Method setter = Reflect.method(builder.getClass(), field.getKey(), 1);
      Object value = sdk.read(field.getValue(), setter.getGenericParameterTypes()[0]);
      Reflect.call(builder, field.getKey(), value);
    }
    return Reflect.call(builder, "build");
  }

  private static void pathFields(JsonNode plan, JsonNode call, Map<String, JsonNode> fields) {
    JsonNode params = Wire.member(call, "params");
    for (JsonNode path : Wire.items(Wire.member(plan, "path"))) {
      String name = Wire.text(path, "name");
      JsonNode value = params == null ? null : params.get(name);
      if (value == null) {
        throw new DriverException("the call has no path param " + name);
      }
      fields.put(Wire.text(path, "param"), value);
    }
  }

  private static void queryFields(JsonNode plan, JsonNode call, Map<String, JsonNode> fields) {
    JsonNode query = Wire.member(plan, "query");
    for (var member : members(call, "search")) {
      String param = query == null ? null : Wire.text(query, member.getKey());
      if (param == null) {
        throw new DriverException("the method declares no query param " + member.getKey());
      }
      fields.put(param, member.getValue());
    }
  }

  /**
   * The declared header param named {@code name}, case-insensitively, or null when none is
   * declared.
   */
  private static String declared(JsonNode plan, String name) {
    for (var header : members(plan, "headers")) {
      if (header.getKey().equalsIgnoreCase(name)) {
        return header.getValue().asString();
      }
    }
    return null;
  }

  /** The members of object {@code name} in {@code node}, none when it is absent. */
  private static Iterable<Map.Entry<String, JsonNode>> members(JsonNode node, String name) {
    JsonNode object = Wire.member(node, name);
    Map<String, JsonNode> members = new LinkedHashMap<>();
    for (var member :
        object == null
            ? new java.util.ArrayList<Map.Entry<String, JsonNode>>()
            : object.properties()) {
      members.put(member.getKey(), member.getValue());
    }
    return members.entrySet();
  }
}
