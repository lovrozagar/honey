import java.lang.reflect.Field;
import java.lang.reflect.Type;
import tools.jackson.databind.JavaType;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * The loaded SDK, reached by name: its package, and the SDK's own mapper read from the
 * package-private {@code Json.MAPPER}, so a model argument binds and an answer writes exactly as
 * the SDK reads and writes them.
 */
final class Sdk {
  private final String pkg;
  private final ObjectMapper mapper;

  private Sdk(String pkg, ObjectMapper mapper) {
    this.pkg = pkg;
    this.mapper = mapper;
  }

  static Sdk load(String pkg) {
    try {
      Field field = Class.forName(pkg + ".Json").getDeclaredField("MAPPER");
      field.setAccessible(true);
      return new Sdk(pkg, (ObjectMapper) field.get(null));
    } catch (ReflectiveOperationException e) {
      throw new DriverException(
          "the SDK's mapper is not at " + pkg + ".Json.MAPPER: " + e.getMessage());
    }
  }

  String pkg() {
    return pkg;
  }

  /** The SDK's class {@code simple}; a DriverException when the SDK has none. */
  Class<?> type(String simple) {
    Class<?> type = findType(simple);
    if (type == null) {
      throw new DriverException("the SDK has no type " + pkg + "." + simple);
    }
    return type;
  }

  /** The SDK's class {@code simple}, or null when the SDK emits none. */
  Class<?> findType(String simple) {
    try {
      return Class.forName(pkg + "." + simple);
    } catch (ClassNotFoundException e) {
      return null;
    }
  }

  /** The SDK's own JSON value of {@code value}. */
  JsonNode toTree(Object value) {
    return mapper.valueToTree(value);
  }

  /** {@code node} read as a value of {@code type} by the SDK's mapper. */
  Object read(JsonNode node, Type type) {
    JavaType javaType = mapper.constructType(type);
    return mapper.convertValue(node, javaType);
  }
}
