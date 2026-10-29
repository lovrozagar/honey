import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.time.Duration;
import java.util.Iterator;
import java.util.Timer;
import java.util.concurrent.CancellationException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * A stream call (bit 16 phase d1; C#'s Stream.cs): the method opens the stream, and the open and
 * every read run on one worker thread under a watchdog, so a stream that has not ended after ten
 * seconds fails the run instead of hanging it. The grid's cancel is the worker's interrupt, the
 * thread that opens and reads (the SDK's cancel). An error at the open is observed as any call's
 * (Observe.thrown, via "return"); a safe SSE call's Result is settled first (Observe.settle), its
 * Err observed as any call's and its Ok's stream read. Once open, the call observes the events the stream delivered: an
 * error a read threw is traced via "stream" and ends the reads; a cancel is the stream's quiet end,
 * traced with canceled true; a failure with no answer (a connection lost, a timeout) is observed as
 * the events delivered and how it {@code failed}. Unscripted, any other stream error fails the run. After {@code take}
 * events the driver closes the stream, Java's try-with-resources (the SDK's own release path);
 * after an error, a cancel or the end it does nothing, so a release check tests the SDK.
 */
final class Streams {
  private static final Duration STALL_AFTER = Duration.ofSeconds(10);

  private Streams() {}

  /** What a stream call needs: the run, its plan, the grid call, its script entry and its ask. */
  record At(Invoke.Run run, JsonNode plan, JsonNode call, JsonNode entry, Observe.Ask ask, Object raw) {}

  /** {@code method} on {@code target} opened and read on a worker under the watchdog and the cancel. */
  static Observe.Outcome observe(At at, Method method, Object target, Object[] args, JsonNode cancel) {
    Observe.Outcome[] outcome = new Observe.Outcome[1];
    RuntimeException[] failed = new RuntimeException[1];
    boolean before = cancel != null && "before".equals(cancel.asString(""));
    Thread worker =
        new Thread(
            () -> {
              /* a cancel before the call: the worker is interrupted before its open runs, as the SDK reads it */
              if (before) {
                Thread.currentThread().interrupt();
              }
              try {
                outcome[0] = opened(at, method, target, args);
              } catch (RuntimeException e) {
                failed[0] = e;
              }
            },
            "honey-stream");
    worker.setDaemon(true);
    Timer timer = Invoke.cancelAfter(worker, cancel);
    worker.start();
    try {
      worker.join(STALL_AFTER.toMillis());
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new DriverException("the stream's watchdog was interrupted");
    } finally {
      if (timer != null) {
        timer.cancel();
      }
    }
    if (worker.isAlive()) {
      throw new DriverException(
          "stream stalled: no end within " + STALL_AFTER.toSeconds() + "s");
    }
    if (failed[0] != null) {
      throw failed[0];
    }
    return outcome[0];
  }

  private static Observe.Outcome opened(At at, Method method, Object target, Object[] args) {
    Object stream;
    try {
      stream = method.invoke(target, args);
    } catch (InvocationTargetException e) {
      return Observe.thrown(at.run().sdk(), e.getCause(), at.raw(), at.ask());
    } catch (IllegalAccessException e) {
      throw new DriverException(Wire.text(at.plan(), "method") + " is not accessible");
    }
    /* a safe SSE call answers a Result of its stream: its Ok's stream is read, its Err observed */
    if (at.ask().result()) {
      Observe.Settled settled = Observe.settle(at.run().sdk(), stream, at.raw(), at.ask());
      if (settled.err() != null) {
        return settled.err();
      }
      stream = settled.data();
    }
    return switch (Wire.text(at.plan(), "stream")) {
      case "ws" -> Sockets.frames(at, stream, Wire.member(at.entry(), "ws"));
      case "realtime" -> Live.frames(at, stream);
      default -> events(at, stream);
    };
  }

  /**
   * An EventStream read until {@code take} events (absent: until its end). A thrown error counts as
   * a yield and ends the reads. The trace holds the yields, each event's retry in ms (null when
   * unset) and the typed headers the open filled.
   */
  private static Observe.Outcome events(At at, Object stream) {
    JsonNode take = Wire.member(at.call(), "take");
    ArrayNode events = Wire.array();
    ArrayNode retry = Wire.array();
    RuntimeException failure = null;
    Iterator<?> reader = (Iterator<?>) Reflect.call(stream, "iterator");
    try {
      while (take == null || events.size() < take.asInt()) {
        if (!reader.hasNext()) {
          break;
        }
        Object event = reader.next();
        Object wait = Reflect.call(event, "retry");
        retry.add(wait == null ? Wire.JSON.getNodeFactory().nullNode() : Wire.value(((Duration) wait).toMillis()));
        events.add(eventOf(at.run().sdk(), event));
      }
    } catch (RuntimeException e) {
      if (e instanceof DriverException) {
        throw e;
      }
      failure = e;
    }
    if (failure == null && take != null) {
      Reflect.call(stream, "close");
    }
    ObjectNode trace = Wire.object();
    trace.put("yields", events.size() + (failure == null ? 0 : 1));
    if (!retry.isEmpty()) {
      trace.set("retry", retry);
    }
    if (at.ask().holder() != null) {
      ObjectNode headers = Observe.headersOf(at.plan(), at.ask().holder());
      if (!headers.isEmpty()) {
        trace.set("headers", headers);
      }
    }
    ObjectNode seen = Wire.object();
    seen.set("events", events);
    seen.put("kind", "events");
    String failed = failure == null ? null : Observe.noAnswer(at.run().sdk(), failure);
    if (failed == null) {
      return streamed(at, seen, failure, trace);
    }
    seen.put("failed", failed);
    JsonNode error =
        at.ask().scripted() ? Traces.error(at.run().sdk(), failure, "stream", at.ask().envelope()) : null;
    return new Observe.Outcome(seen, error, null, trace);
  }

  /** An event as the grid observes it: its data (a string as it is), its event name and id only when set. */
  private static ObjectNode eventOf(Sdk sdk, Object event) {
    Object data = Reflect.call(event, "data");
    ObjectNode seen = Wire.object();
    seen.set("data", data instanceof String text ? Wire.value(text) : sdk.toTree(data));
    Object name = Reflect.call(event, "event");
    if (name instanceof String text && !text.isEmpty()) {
      seen.put("event", text);
    }
    Object id = Reflect.call(event, "id");
    if (id instanceof String text && !text.isEmpty()) {
      seen.put("id", text);
    }
    return seen;
  }

  /**
   * What an open stream delivered: its failure traced via "stream"; unscripted, a failure other than
   * a cancel fails the run.
   */
  static Observe.Outcome streamed(
      At at, ObjectNode seen, RuntimeException failure, ObjectNode trace) {
    if (failure == null) {
      return new Observe.Outcome(seen, null, null, trace);
    }
    if (at.ask().scripted()) {
      JsonNode error = Traces.error(at.run().sdk(), failure, "stream", at.ask().envelope());
      return new Observe.Outcome(seen, error, null, trace);
    }
    if (failure instanceof CancellationException) {
      return new Observe.Outcome(seen, null, null, trace);
    }
    throw new DriverException(
        "the call ended in an error the grid has no outcome for: "
            + failure.getClass().getSimpleName()
            + ": "
            + failure.getMessage());
  }
}
