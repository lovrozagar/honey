import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * A WebSocket call (bit 16 phase d2a; C#'s Stream.cs FramesAsync): a recording handler per end
 * under {@code ws.on}; the grid's {@code send} as text, then the script's (text, that many bytes
 * {@code i & 0xff}, or a JSON value through sendJson), which a failure ends but not the reads (what
 * the server sent first still waits); {@code take} frames (absent: until the socket ends); then
 * closedBy, and close with the script's code and reason (1000 and none by default). The trace holds
 * the frames read, the server's close, the close's failure and every handler run, those the
 * driver's own close fires included.
 */
final class Sockets {
  private Sockets() {}

  static Observe.Outcome frames(Streams.At at, Object ws, JsonNode script) {
    List<JsonNode> runs = new ArrayList<>();
    if (Wire.flag(script, "on")) {
      attach(ws, runs);
    }
    RuntimeException unsent = sent(ws, at.call(), script);
    ArrayNode read = Wire.array();
    RuntimeException unread = received(ws, Wire.member(at.call(), "take"), read);
    ObjectNode trace = Wire.object();
    trace.put("yields", read.size());
    Object closed = Reflect.call(ws, "closedBy");
    if (closed != null) {
      ObjectNode by = Wire.object();
      by.put("code", (Integer) Reflect.call(closed, "status"));
      by.put("reason", (String) Reflect.call(closed, "reason"));
      trace.set("closedBy", by);
    }
    JsonNode close = Wire.member(script, "close");
    try {
      int code = close == null ? 1000 : close.get("code").asInt();
      String reason = close == null ? "" : Wire.text(close, "reason");
      Reflect.call(ws, "close", code, reason);
    } catch (RuntimeException e) {
      if (e instanceof DriverException) {
        throw e;
      }
      trace.put("closeError", e.getMessage());
    }
    synchronized (runs) {
      if (!runs.isEmpty()) {
        ArrayNode handlers = Wire.array();
        runs.forEach(handlers::add);
        trace.set("handlers", handlers);
      }
    }
    ObjectNode seen = Wire.object();
    seen.set("frames", read);
    seen.put("kind", "frames");
    return Streams.streamed(at, seen, unsent != null ? unsent : unread, trace);
  }

  /** One recorder per end: a message's text, a close's reason, an error's message. */
  private static void attach(Object ws, List<JsonNode> runs) {
    Consumer<Object> message =
        m -> add(runs, "message", new String((byte[]) Reflect.call(m, "data"), StandardCharsets.UTF_8));
    Consumer<Object> closed = c -> add(runs, "close", (String) Reflect.call(c, "reason"));
    Consumer<Object> error = e -> add(runs, "error", ((Throwable) e).getMessage());
    Reflect.call(ws, "onMessage", message);
    Reflect.call(ws, "onClosed", closed);
    Reflect.call(ws, "onError", error);
  }

  /* an end fires on whichever thread ended the read or the close */
  private static void add(List<JsonNode> runs, String event, String data) {
    synchronized (runs) {
      runs.add(Wire.object().put("data", data).put("event", event));
    }
  }

  /** The grid's sends as text, then the script's; the first send error, which ends them. */
  private static RuntimeException sent(Object ws, JsonNode call, JsonNode script) {
    try {
      for (JsonNode text : Wire.items(Wire.member(call, "send"))) {
        send(ws, String.class, text.asString());
      }
      for (JsonNode message : Wire.items(Wire.member(script, "send"))) {
        if (message.has("text")) {
          send(ws, String.class, message.get("text").asString());
        } else if (message.has("bytes")) {
          byte[] bytes = new byte[message.get("bytes").asInt()];
          for (int i = 0; i < bytes.length; i++) {
            bytes[i] = (byte) (i & 0xff);
          }
          send(ws, byte[].class, bytes);
        } else {
          Reflect.call(ws, "sendJson", Wire.JSON.convertValue(message.get("json"), Object.class));
        }
      }
      return null;
    } catch (RuntimeException e) {
      if (e instanceof DriverException) {
        throw e;
      }
      return e;
    }
  }

  /** {@code send} by its parameter type: the overloads share a name and an arity. */
  private static void send(Object ws, Class<?> type, Object value) {
    try {
      Reflect.method(ws.getClass(), "send", type).invoke(ws, value);
    } catch (java.lang.reflect.InvocationTargetException e) {
      throw Reflect.unwrap(e.getCause());
    } catch (IllegalAccessException e) {
      throw new DriverException("send is not accessible: " + e.getMessage());
    }
  }

  /** Frames read into {@code read} until {@code take} (absent: until null); the error that ended them. */
  private static RuntimeException received(Object ws, JsonNode take, ArrayNode read) {
    try {
      while (take == null || read.size() < take.asInt()) {
        Object message = Reflect.call(ws, "receive");
        if (message == null) {
          break;
        }
        read.add(Observe.bodyOf((byte[]) Reflect.call(message, "data")));
      }
      return null;
    } catch (RuntimeException e) {
      if (e instanceof DriverException) {
        throw e;
      }
      return e;
    }
  }
}
