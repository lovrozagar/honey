import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The driver's own JSON: the envelope, the script and every trace it writes; never the SDK's
 * values.
 */
final class Wire {
  static final ObjectMapper JSON = JsonMapper.builder().build();

  private Wire() {}

  static JsonNode parse(String text) {
    return JSON.readTree(text);
  }

  /** The member {@code name} of {@code node}, or null when it is absent or JSON null. */
  static JsonNode member(JsonNode node, String name) {
    JsonNode value = node == null ? null : node.get(name);
    return value == null || value.isNull() ? null : value;
  }

  /** The text of member {@code name}, or null when it is absent. */
  static String text(JsonNode node, String name) {
    JsonNode value = member(node, name);
    return value == null ? null : value.asString();
  }

  static boolean flag(JsonNode node, String name) {
    JsonNode value = member(node, name);
    return value != null && value.asBoolean();
  }

  /** The JSON value of a Java string, number or boolean. */
  static JsonNode value(Object value) {
    return JSON.valueToTree(value);
  }

  /** The elements of an array node, in order; none for null. */
  static java.util.List<JsonNode> items(JsonNode array) {
    java.util.List<JsonNode> items = new java.util.ArrayList<>();
    for (int i = 0; array != null && i < array.size(); i++) {
      items.add(array.get(i));
    }
    return items;
  }

  static ObjectNode object() {
    return JSON.createObjectNode();
  }

  static ArrayNode array() {
    return JSON.createArrayNode();
  }

  /** The node to write for an optional value: its JSON, or null. */
  static JsonNode nullable(Object value) {
    return value == null ? JSON.getNodeFactory().nullNode() : value(value);
  }

  static String write(JsonNode node) {
    return JSON.writeValueAsString(node);
  }
}
