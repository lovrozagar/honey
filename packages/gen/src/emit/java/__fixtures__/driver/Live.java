import java.util.Locale;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * A realtime call (bit 16 phase d2b; C#'s Stream.cs LiveAsync): each grid {@code send} as its JSON
 * value through sendJson, else as text, until the first error; then {@code take} values read by
 * receive (Protocol refuses a realtime call without one), a read's error also kept in {@code
 * realtime.errors}; a connection that ends first ends them quietly. A send's error is observed as
 * a call's (Observe.graded, a DecodeException on the call's raw box: the connection's 2xx, since a
 * send's error holds no response). Then close(), and the trace: the frames, the cursor the options
 * settled on (null as ""), the proven transport and the read errors.
 */
final class Live {
  private Live() {}

  static Observe.Outcome frames(Streams.At at, Object conn) {
    RuntimeException unsent = sent(conn, at.call());
    RuntimeException failure = unsent;
    ArrayNode read = Wire.array();
    ArrayNode errors = Wire.array();
    if (failure == null) {
      failure = received(at, conn, Wire.member(at.call(), "take"), read);
      if (failure != null) {
        errors.add(failure.getMessage());
      }
    }
    ObjectNode trace = Wire.object();
    trace.put("yields", read.size());
    try {
      Reflect.call(conn, "close");
    } catch (RuntimeException e) {
      if (e instanceof DriverException) {
        throw e;
      }
      trace.put("closeError", e.getMessage());
    }
    Object options = Reflect.call(conn, "options");
    ObjectNode cursor = Wire.object();
    cursor.put("lastEventId", text(Reflect.call(options, "lastEventId")));
    cursor.put("reconnectToken", text(Reflect.call(options, "reconnectToken")));
    ObjectNode realtime = Wire.object();
    realtime.set("cursor", cursor);
    realtime.set("errors", errors);
    Object proven = Reflect.call(conn, "provenTransport");
    realtime.put(
        "proven",
        proven == null ? null : proven.toString().replace("_", "").toLowerCase(Locale.ROOT));
    trace.set("realtime", realtime);
    /* a send's error is a call's; a connection whose first read failed, refused before any frame, ends in its open's error: the grid's error, timeout or transport */
    JsonNode refused =
        unsent != null || (read.isEmpty() && !errors.isEmpty())
            ? Observe.graded(at.run().sdk(), failure, at.raw(), at.ask())
            : null;
    if (refused != null) {
      JsonNode traced =
          at.ask().scripted()
              ? Traces.error(at.run().sdk(), failure, "stream", at.ask().envelope())
              : null;
      return new Observe.Outcome(refused, traced, null, trace);
    }
    ObjectNode seen = Wire.object();
    seen.set("frames", read);
    seen.put("kind", "frames");
    return Streams.streamed(at, seen, failure, trace);
  }

  private static String text(Object value) {
    return value == null ? "" : (String) value;
  }

  /** The grid's sends, a JSON text through sendJson and any other as text; the first error. */
  private static RuntimeException sent(Object conn, JsonNode call) {
    try {
      for (JsonNode item : Wire.items(Wire.member(call, "send"))) {
        String text = item.asString();
        JsonNode json = parsed(text);
        if (json == null) {
          Reflect.call(conn, "send", text);
        } else {
          Reflect.call(conn, "sendJson", Wire.JSON.convertValue(json, Object.class));
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

  private static JsonNode parsed(String text) {
    try {
      return Wire.JSON.readTree(text);
    } catch (RuntimeException e) {
      return null;
    }
  }

  /** Values read into {@code read} until {@code take}, a null ending them; the error that ended them. */
  private static RuntimeException received(
      Streams.At at, Object conn, JsonNode take, ArrayNode read) {
    try {
      while (read.size() < take.asInt()) {
        Object value = Reflect.call(conn, "receive");
        if (value == null) {
          break;
        }
        read.add(at.run().sdk().toTree(value));
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
