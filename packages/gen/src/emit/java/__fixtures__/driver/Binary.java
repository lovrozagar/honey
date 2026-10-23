import java.io.ByteArrayInputStream;
import java.io.InputStream;
import tools.jackson.databind.JsonNode;

/**
 * A binary request body the grid sends (contract 47): {@code size} bytes {@code i & 0xff}, as a {@code byte[]}, or as a
 * one-shot {@code InputStream} when the script says so. Bind holds the body as its marker until the builder takes it.
 */
final class Binary {
  private Binary() {}

  /** The marker of a call's binary body: its size, and whether it is one-shot. */
  static JsonNode marker(JsonNode body, boolean oneShot) {
    return Wire.object().put("binary", Wire.member(body, "size").asInt()).put("oneShot", oneShot);
  }

  /** The {@code BinaryBody} the marker names, built by the SDK's own {@code of}. */
  static Object body(Sdk sdk, JsonNode marker) {
    int size = marker.get("binary").asInt();
    byte[] bytes = new byte[size];
    for (int i = 0; i < size; i++) {
      bytes[i] = (byte) i;
    }
    boolean oneShot = marker.get("oneShot").asBoolean();
    Object source = oneShot ? new ByteArrayInputStream(bytes) : bytes;
    Class<?> type = oneShot ? InputStream.class : byte[].class;
    try {
      return sdk.type("BinaryBody").getMethod("of", type).invoke(null, source);
    } catch (ReflectiveOperationException e) {
      throw new DriverException("BinaryBody.of failed: " + e.getMessage());
    }
  }
}
