import java.nio.charset.StandardCharsets;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The Java SDK's test driver (bit 16 phase c1; the port of C#'s Program.cs): one fixed program with
 * no reference to any SDK. Stdin is the shared envelope (sdk, cell, plans, base, alt, script);
 * every call of the cell runs in order on one client, and stdout is the grid's Observed[] JSON, or
 * {observed, trace} under a script. A refusal or a failure exits 1 with {@code driver: reason} on
 * stderr, before any call it cannot send.
 */
public final class Driver {
  private Driver() {}

  public static void main(String[] args) throws java.io.IOException {
    int status = 0;
    try {
      System.out.println(run(new String(System.in.readAllBytes(), StandardCharsets.UTF_8)));
    } catch (DriverException e) {
      System.err.println("driver: " + e.getMessage());
      status = 1;
    } catch (RuntimeException e) {
      System.err.println("driver: " + e.getClass().getSimpleName() + ": " + e.getMessage());
      status = 1;
    }
    System.exit(status);
  }

  /** The cell's observed (and the trace under a script) as one JSON document. */
  static String run(String text) {
    JsonNode envelope = Wire.parse(text);
    JsonNode script = Wire.member(envelope, "script");
    Protocol.check(envelope, script);
    Sdk sdk = Sdk.load(Wire.text(Wire.member(envelope, "sdk"), "package"));
    Recorder recorder = new Recorder(script);
    Object client = Config.client(sdk, envelope, script, recorder);
    Invoke.Run run = new Invoke.Run(sdk, envelope, recorder, client, script != null);
    ArrayNode observed = Wire.array();
    JsonNode calls = Wire.member(Wire.member(envelope, "cell"), "calls");
    for (int i = 0; i < calls.size(); i++) {
      observed.add(one(run, i, calls.get(i), Protocol.entry(script, i)));
    }
    if (script == null) {
      return Wire.write(observed);
    }
    ObjectNode out = Wire.object();
    out.set("observed", observed);
    out.set("trace", recorder.trace());
    return Wire.write(out);
  }

  /** Call {@code index}, timed and recorded; its observed node, JSON null for none. */
  private static JsonNode one(Invoke.Run run, int index, JsonNode call, JsonNode entry) {
    String op = Wire.text(call, "operation");
    run.recorder().begin(index, op);
    pause(entry);
    long started = System.nanoTime();
    Observe.Outcome outcome;
    try {
      outcome = Invoke.call(run, call, entry);
    } catch (DriverException e) {
      throw new DriverException("call " + index + " (" + op + "): " + e.getMessage());
    }
    run.recorder()
        .called((System.nanoTime() - started) / 1_000_000, outcome.error(), outcome.result());
    return outcome.observed() == null ? Wire.JSON.getNodeFactory().nullNode() : outcome.observed();
  }

  private static void pause(JsonNode entry) {
    JsonNode sleep = Wire.member(entry, "sleepMs");
    if (sleep == null) {
      return;
    }
    try {
      Thread.sleep(sleep.asLong());
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new DriverException("sleepMs was interrupted");
    }
  }
}
