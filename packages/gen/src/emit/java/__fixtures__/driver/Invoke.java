import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Timer;
import java.util.TimerTask;
import tools.jackson.databind.JsonNode;

/**
 * One call sent by its plan: the accessors walked from the client, the params built, the options
 * given, the method run, and its cancel armed. A cancel is the thread's interrupt, as the SDK reads
 * it (Flight): before the call, or after the script's delay, on the thread that makes the call.
 */
final class Invoke {
  private Invoke() {}

  /**
   * The run's shared state: the SDK, the envelope, the recorder, the client and whether a script
   * traces it.
   */
  record Run(Sdk sdk, JsonNode envelope, Recorder recorder, Object client, boolean scripted) {}

  /** Call {@code index} sent and observed; a DriverException when the driver cannot send it. */
  static Observe.Outcome call(Run run, JsonNode call, JsonNode entry) {
    String op = Wire.text(call, "operation");
    JsonNode plan = Wire.member(Wire.member(run.envelope(), "plans"), op);
    Object target = run.client();
    for (JsonNode accessor : Wire.items(Wire.member(plan, "accessors"))) {
      target = Reflect.call(target, accessor.asString());
    }
    Object raw = newInstance(run.sdk(), "RawResponse");
    Map<String, JsonNode> fields = Bind.fields(plan, call, entry);
    Object params = Bind.params(run.sdk(), plan, fields);
    Object options = options(run, call, raw, Bind.extraHeaders(plan, call));
    JsonNode headers = Wire.member(plan, "responseHeaders");
    Object holder = headers == null ? null : newInstance(run.sdk(), Wire.text(headers, "type"));
    Method method = method(run, target, plan, holder);
    Object[] args = holder == null ? new Object[] {params, options} : new Object[] {params, holder, options};
    JsonNode cancel = Wire.member(entry, "cancel");
    Observe.Ask ask =
        new Observe.Ask(Wire.flag(call, "raw"), run.scripted(), Wire.flag(entry, "envelope"), holder);
    if (Wire.member(plan, "stream") != null) {
      return Streams.observe(new Streams.At(run, plan, call, entry, ask, raw), method, target, args, cancel);
    }
    Thread thread = Thread.currentThread();
    if (cancel != null && "before".equals(cancel.asString(""))) {
      thread.interrupt();
    }
    Timer timer = cancelAfter(thread, cancel);
    Object answer = null;
    Throwable thrown = null;
    try {
      answer = method.invoke(target, args);
    } catch (InvocationTargetException e) {
      thrown = e.getCause();
    } catch (IllegalAccessException e) {
      throw new DriverException(op + " is not accessible: " + e.getMessage());
    } finally {
      if (timer != null) {
        timer.cancel();
      }
      Thread.interrupted();
    }
    return thrown != null
        ? Observe.thrown(run.sdk(), thrown, raw, ask)
        : Observe.returned(run.sdk(), plan, answer, raw, ask);
  }

  /**
   * The timer that interrupts {@code thread} after the cancel's delay, or null for none (or a
   * before cancel).
   */
  static Timer cancelAfter(Thread thread, JsonNode cancel) {
    JsonNode ms = Wire.member(cancel, "afterMs");
    if (ms == null) {
      return null;
    }
    Timer timer = new Timer(true);
    timer.schedule(
        new TimerTask() {
          @Override
          public void run() {
            thread.interrupt();
          }
        },
        ms.asLong());
    return timer;
  }

  /**
   * The operation's method: by its name and parameter types, the {@code <Op>Params}, the {@code <Op>Headers} when the
   * call holds one, and RequestOptions.
   */
  private static Method method(Run run, Object target, JsonNode plan, Object holder) {
    String name = Wire.text(plan, "method");
    Class<?> params = run.sdk().type(Wire.text(plan, "params"));
    Class<?> options = run.sdk().type("RequestOptions");
    if (holder == null) {
      return Reflect.method(target.getClass(), name, params, options);
    }
    return Reflect.method(target.getClass(), name, params, holder.getClass(), options);
  }

  private static Object newInstance(Sdk sdk, String type) {
    try {
      return sdk.type(type).getConstructor().newInstance();
    } catch (ReflectiveOperationException e) {
      throw new DriverException(type + " did not construct: " + e.getMessage());
    }
  }

  /**
   * The call's RequestOptions: its raw box, its timeout, its undeclared headers and its alt origin.
   */
  private static Object options(Run run, JsonNode call, Object raw, Map<String, String> extra) {
    Object builder = Reflect.invokeStatic(run.sdk().type("RequestOptions"), "builder");
    Reflect.call(builder, "raw", raw);
    JsonNode timeout = Wire.member(call, "timeoutMs");
    if (timeout != null) {
      Reflect.call(builder, "timeout", Duration.ofMillis(timeout.asLong()));
    }
    if (!extra.isEmpty()) {
      Reflect.call(builder, "headers", new LinkedHashMap<>(extra));
    }
    if ("alt".equals(Wire.text(call, "origin"))) {
      Reflect.call(builder, "baseUrl", Wire.text(run.envelope(), "alt"));
    }
    return Reflect.call(builder, "build");
  }
}
