/**
 * The Java SDK's SSE parser in process (bit 16 phase d1, J8; C#'s `sse.parse.test.ts` in-memory legs): `Sse` is
 * package-private, so probes in the SDK's package hand it exactly the bytes given. Its reads are bounded (ruling 2):
 * the events a read completed come before a cap's error, as when fed apart (M5), and an endless line or event raises its
 * cap after at most one read past it; the data join is linear, timed by CPU time. The wire legs: `sse.parse.test.ts`.
 */
import { describe, expect, it } from "vitest"
import { type DrivenJavaSdk, drivenJavaSdk } from "./__fixtures__/driven.ts"
import { withJava } from "./__fixtures__/java-env.ts"

/** Whether Java is pinned here: a missing toolchain fails where it is required and skips these legs elsewhere. */
const JAVA = withJava()
/** A cold gate compiles the SDK first. */
const SLOW = { timeout: 600_000 }

let compiled: DrivenJavaSdk | undefined

/** The registry `sse` SDK, gated once per file; it must build. */
function sdk(): DrivenJavaSdk {
	compiled ??= drivenJavaSdk("sse")
	expect(compiled.built, compiled.diagnostics.join("\n")).toBe(true)
	return compiled
}

/** The `sse` SDK's package (the emitter's default), where the probes sit beside the package-private parser. */
const PACKAGE = "ai.anyrow"

/**
 * Beside the probe, in the SDK's package: an InputStream handing out the given chunks one per read (a chunk larger than
 * the reader's buffer as consecutive reads, never two chunks in one read), in memory: no socket, no server.
 */
const CHUNKS = `final class Chunks extends java.io.InputStream {
  private final byte[][] chunks;
  private int at;
  private int offset;

  Chunks(byte[]... chunks) {
    this.chunks = chunks;
  }

  @Override
  public int read() {
    byte[] one = new byte[1];
    return read(one, 0, 1) < 0 ? -1 : one[0] & 0xff;
  }

  @Override
  public int read(byte[] buffer, int off, int len) {
    if (at == chunks.length) {
      return -1;
    }
    int n = Math.min(len, chunks[at].length - offset);
    System.arraycopy(chunks[at], offset, buffer, off, n);
    offset += n;
    if (offset == chunks[at].length) {
      at++;
      offset = 0;
    }
    return n;
  }
}`

/**
 * Each case's chunks through the parser: each event's data (over 16 characters, as its length) until the end (`end`)
 * or the first HoneyException (`<type>: <message>`), each case on one line, its notes joined by `|`.
 */
const PARSER = `final class ParseProbe {
  static final int MiB = 1 << 20;

  static byte[] ascii(String s) {
    return s.getBytes(java.nio.charset.StandardCharsets.US_ASCII);
  }

  static byte[] joined(byte[] a, byte[] b) {
    byte[] out = java.util.Arrays.copyOf(a, a.length + b.length);
    System.arraycopy(b, 0, out, a.length, b.length);
    return out;
  }

  static void fed(String name, byte[]... chunks) throws Exception {
    java.util.List<String> notes = new java.util.ArrayList<>();
    try {
      Sse parser = new Sse(new Chunks(chunks));
      for (Sse.Event e = parser.next(); e != null; e = parser.next()) {
        notes.add(e.data().length() <= 16 ? e.data() : "<" + e.data().length() + " chars>");
      }
      notes.add("end");
    } catch (HoneyException e) {
      notes.add(e.getClass().getSimpleName() + ": " + e.getMessage());
    }
    System.out.println(name + " " + String.join("|", notes));
  }

  public static void main(String[] args) throws Exception {
    byte[] ok = ascii("data: ok\\n\\n");
    byte[] line = ascii("data: " + "x".repeat(MiB - 6 + 1) + "\\n\\n");
    byte[] oneEvent = ascii(("data: " + "x".repeat(1_000_000) + "\\n").repeat(9) + "\\n");
    fed("event", joined(ok, oneEvent));
    fed("eventApart", ok, oneEvent);
    fed("line", joined(ok, line));
    fed("lineApart", ok, line);
  }
}
${CHUNKS}
`

/**
 * 1,024 events of 12,500 `data: x` lines and 64 of 200,000 (the same 12.8 M lines, 16x longer events), in memory in
 * 64 KiB chunks as a socket hands them over; per size, the best of five rounds of the thread's CPU time (ThreadMXBean,
 * never the wall clock) to parse them; each size's event lengths, then the per-line cost at 16x the event length over
 * the per-line cost at 1x, then each size's CPU ms.
 */
const LINES = `final class ParseProbe {
  public static void main(String[] args) throws Exception {
    java.lang.management.ThreadMXBean mx = java.lang.management.ManagementFactory.getThreadMXBean();
    double[] best = new double[2];
    long[] cpu = new long[2];
    int[][] sizes = {{12_500, 1024}, {200_000, 64}};
    for (int s = 0; s < 2; s++) {
      int lines = sizes[s][0];
      int streams = sizes[s][1];
      byte[] body = ("data: x\\n".repeat(lines) + "\\n").getBytes(java.nio.charset.StandardCharsets.US_ASCII);
      java.util.List<byte[]> chunks = new java.util.ArrayList<>();
      for (int at = 0; at < body.length; at += 65536) {
        chunks.add(java.util.Arrays.copyOfRange(body, at, Math.min(at + 65536, body.length)));
      }
      byte[][] parts = chunks.toArray(new byte[0][]);
      long fastest = Long.MAX_VALUE;
      java.util.TreeSet<Integer> lengths = new java.util.TreeSet<>();
      for (int round = 0; round < 5; round++) {
        long started = mx.getCurrentThreadCpuTime();
        for (int i = 0; i < streams; i++) {
          Sse parser = new Sse(new Chunks(parts));
          for (Sse.Event e = parser.next(); e != null; e = parser.next()) {
            lengths.add(e.data().length());
          }
        }
        long took = mx.getCurrentThreadCpuTime() - started;
        fastest = Math.min(fastest, took);
        if (took > 5_000_000_000L) {
          break;
        }
      }
      System.out.println(lines + " lines: " + lengths);
      cpu[s] = fastest / 1_000_000;
      best[s] = fastest / ((double) lines * streams);
    }
    System.out.println("cpu " + cpu[0] + " " + cpu[1]);
    System.out.println(String.format(java.util.Locale.ROOT, "ratio %.2f", best[1] / best[0]));
  }
}
${CHUNKS}
`

/**
 * Bounded reads (ruling 2): an endless line, and endless data lines with no blank line, each from a stream that counts
 * the bytes it handed out and refuses to hand out more than 64 MiB; the cap's error and how many bytes the parser read
 * first, in MiB rounded up. A cap checked only once its line or event ended never comes, and reads to the refusal.
 */
const ENDLESS = `final class ParseProbe {
  static final class Endless extends java.io.InputStream {
    private final byte[] head;
    private final byte[] repeat;
    long given;

    Endless(String head, String repeat) {
      this.head = head.getBytes(java.nio.charset.StandardCharsets.US_ASCII);
      this.repeat = repeat.getBytes(java.nio.charset.StandardCharsets.US_ASCII);
    }

    @Override
    public int read() {
      throw new UnsupportedOperationException();
    }

    @Override
    public int read(byte[] buffer, int off, int len) {
      if (given > 64L << 20) {
        throw new IllegalStateException("read past 64 MiB");
      }
      for (int i = 0; i < len; i++, given++) {
        buffer[off + i] =
            given < head.length ? head[(int) given] : repeat[(int) ((given - head.length) % repeat.length)];
      }
      return len;
    }
  }

  static void fed(String name, Endless in) throws Exception {
    try {
      new Sse(in).next();
      System.out.println(name + " no error");
    } catch (RuntimeException e) {
      long mib = (in.given + (1 << 20) - 1) >> 20;
      System.out.println(name + " " + e.getClass().getSimpleName() + ": " + e.getMessage() + " after " + mib + " MiB");
    }
  }

  public static void main(String[] args) throws Exception {
    fed("line", new Endless("data: ", "x"));
    fed("event", new Endless("", "data: " + "x".repeat(1000) + "\\n"));
  }
}
`

/**
 * The parser reads on demand (the premise M5's ordering rests on: a read happens only once the events before it are
 * read): one read hands out three events, then the end; the reads counted before each of four next() calls.
 */
const ON_DEMAND = `final class ParseProbe {
  static final class Counted extends java.io.InputStream {
    private final byte[] bytes =
        "data: a\\n\\ndata: b\\n\\ndata: c\\n\\n".getBytes(java.nio.charset.StandardCharsets.US_ASCII);
    int reads;

    @Override
    public int read() {
      throw new UnsupportedOperationException();
    }

    @Override
    public int read(byte[] buffer, int off, int len) {
      reads++;
      if (reads > 1) {
        return -1;
      }
      System.arraycopy(bytes, 0, buffer, off, bytes.length);
      return bytes.length;
    }
  }

  public static void main(String[] args) throws Exception {
    Counted in = new Counted();
    Sse parser = new Sse(in);
    for (int i = 0; i < 4; i++) {
      Sse.Event event = parser.next();
      System.out.println((event == null ? "end" : event.data()) + " after " + in.reads + " reads");
    }
  }
}
`

/** `probe` (a `ParseProbe` and its `Chunks`) compiled in the SDK's package and run: its output lines. */
function probed(probe: string): string[] {
	const run = sdk().run(`${PACKAGE}.ParseProbe`, `package ${PACKAGE};\n\n${probe}`)
	expect({ diagnostics: run.diagnostics, status: run.status }, run.stderr).toEqual({ diagnostics: [], status: 0 })
	return run.stdout.split("\n").filter((line) => line !== "")
}

describe.skipIf(!JAVA)("Java SSE framing: the shipped parser in process, caps and data lines", SLOW, () => {
	/* new: C# sse.parse.test.ts:381 (M5, ruling 2: a cap checked after a read's events are dropped turns the together
	 * cases red, as the cap's read also completed "ok") */
	it("yields the event one read completed before an over-cap line or event, then the cap's error, as when fed apart", () => {
		const line = "ok|DecodeException: an event-stream line exceeds 1 MiB"
		const event = "ok|DecodeException: an event's data exceeds 8 MiB"
		expect(probed(PARSER)).toEqual([`event ${event}`, `eventApart ${event}`, `line ${line}`, `lineApart ${line}`])
	})

	/* new: the reviewer's premise for M5's ordering equivalence: a read only once the ready events are read */
	it("reads on demand: one read's three events come from that one read, and only the fourth next() reads again", () => {
		expect(probed(ON_DEMAND)).toEqual(["a after 1 reads", "b after 1 reads", "c after 1 reads", "end after 2 reads"])
	})

	/* new: ruling 2 (bounded reads): a cap checked only at the end of its line or event reads to the 64 MiB refusal */
	it("raises each cap having read at most one 64 KiB read past it: an endless line or event never reads on", () => {
		expect(probed(ENDLESS)).toEqual([
			"line DecodeException: an event-stream line exceeds 1 MiB after 2 MiB",
			"event DecodeException: an event's data exceeds 8 MiB after 9 MiB",
		])
	})

	/* new: C# sse.parse.test.ts:394 (a per-line cost that holds at 16x the lines is linear, one that grows 16x is
	 * quadratic, so 4x needs no machine's absolute speed; timed in process by CPU time, no HTTP hides it) */
	it("accumulates data lines in linear time: 16x the lines cost a line under 4x more", () => {
		const notes = probed(LINES)
		const ratio = Number(/^ratio (\S+)$/.exec(notes.at(-1) ?? "")?.[1])
		const cpu = (/^cpu (\d+) (\d+)$/.exec(notes.at(-2) ?? "") ?? []).slice(1).map(Number)
		/* each window well above the CPU clock's resolution, or the short one quantizes */
		expect(
			cpu.map((ms) => ms >= 30),
			notes.join("\n"),
		).toEqual([true, true])
		expect(notes.slice(0, 2)).toEqual(["12500 lines: [24999]", "200000 lines: [399999]"])
		expect(ratio, notes.join("\n")).toBeLessThan(4)
	})
})
