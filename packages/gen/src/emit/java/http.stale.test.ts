/**
 * Stale tracking (bit 16 phase c2, W9; contract 47 §5.7): the C# `http.stale.test.ts` port for the Java SDK. A 2xx
 * mutation stales its `x-invalidate` targets for the next read, which a read through them clears; off without
 * `invalidation(...)` or at a zero `staleTime`; a mark lapsing after the window on the monotonic clock; and the bounds:
 * `staleMaxEntries` evicts the least recently staled down to half, `maxSourcesPerTarget` caps the sources one selector
 * records.
 *
 * The HTTP legs drive `http` (documents-http.ts) through the driver. The bounds, the lapse and the lookup's cost are
 * measured IN-PROCESS: a consumer program in the SDK's package reaches the package-private tracker directly, so no
 * HTTP round trip hides the computation (honey-a8; memory hollow-perf-guard-through-http). The cost is the CPU time of
 * the measuring thread, best of five rounds, because wall clock flakes under core contention (memory bit 15 d).
 *
 * ASSUMED SHAPE (step 2 implements exactly this, at C# Stale.cs parity; each name is a FLAG to the reviewer):
 * - `InvalidationConfig` (public, emitted with the tracker): `builder()` with `staleTime(Duration)`,
 *   `staleMaxEntries(int)` (default 1000), `maxSourcesPerTarget(int)` (default 16), and `build()`.
 * - `StaleTracker` (package-private `final class`, its `StaleMeta` record beside it in its own file): the constructor
 *   `StaleTracker(InvalidationConfig config)`, where null or a zero `staleTime` is off; `StaleMeta begin(String method,
 *   String path)`; `void settle(StaleMeta meta, String[] targets, Map<String, String> values)`, which marks the targets
 *   on a 2xx (empty targets mark nothing) and clears the stale targets the read named.
 * - `StaleMeta` accessors: `selector()`, `isStale()`, `invalidatedBy()` (a `List<String>`).
 * - `RequestContext` (public) gains `selector()`, `isStale()` and `invalidatedBy()`, which the driver's request hook reads.
 * - Emitted only when a document has an `x-invalidate` (gate (a), the feature leg below): `StaleTracker.java`,
 *   `StaleMeta.java` and `InvalidationConfig.java`.
 * The M2 mutant the cost leg must catch (an O(n) exact-key scan in `readBy`) is the patch at
 * `~/.cache/honey-tmp/b16c2/w9-mutants/m2-exact-key-scan.patch`.
 */
import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import { generateJavaSdk } from "./sdk.ts"
import type { HookTrace, Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { type CompiledJavaSdk, compiledJavaSdk } from "./__fixtures__/compiled.ts"
import { type DrivenJavaSdk, drivenJavaSdk } from "./__fixtures__/driven.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { withJava } from "./__fixtures__/java-env.ts"

/** Whether the JDK is here: a missing one fails where it is required and skips these legs elsewhere (java-env). */
const JAVA = withJava()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

type Invalidation = NonNullable<NonNullable<Script["config"]>["invalidation"]>

const call = (operation: string, method: string, path: string, extra: Partial<Call> = {}): Call => ({
	operation,
	route: { method, path },
	...extra,
})
const CREATE = call("users.create", "POST", "/users", { body: { kind: "json", value: { name: "n" } } })
const LIST = call("users.list", "GET", "/users")
const GET = call("users.get", "GET", "/users/{id}", { params: { id: "1" } })
const ORDER = call("orders.create", "POST", "/orders", { body: { kind: "json", value: { sku: "s" } } })

/** The `http` SDK, its files and its package: a consumer program in that package reaches the package-private tracker. */
const FILES = generateJavaSdk(FIXTURES.http.document()).files
const PACKAGE = packageOf(FILES)

/** The package the SDK is emitted in, read from its client config (the runtime is emitted beside the client). */
function packageOf(files: Readonly<Record<string, string>>): string {
	const path = Object.keys(files).find((name) => name.endsWith("/ClientConfig.java"))
	if (path === undefined) throw new Error("the emitted SDK has no ClientConfig.java")
	return path.slice(path.indexOf("java/") + "java/".length, path.lastIndexOf("/")).replaceAll("/", ".")
}

/** The `http` SDK with the driver aimed at it: it must build. */
function staleSdk(): DrivenJavaSdk {
	const sdk = drivenJavaSdk("http")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

/** `calls` with `invalidation` (none when absent) against a server answering `replies` (200 `{}` past them). */
async function traced(calls: readonly Call[], invalidation?: Invalidation, replies: readonly Reply[] = []) {
	/* one request hook, recording what it saw; the config only when given */
	const script: Script = {
		...(invalidation === undefined ? {} : { config: { invalidation } }),
		hooks: { request: [{}] },
	}
	const sdk = staleSdk()
	const run = await served(replies, (server) => sdk.runCalls({ calls, setup: {} }, { url: server.url }, { script }))
	return {
		hooks: (run.trace?.hooks ?? []).filter((h) => h.phase === "request"),
		kinds: run.observed?.map((o) => (o as { kind?: string } | null)?.kind),
		status: run.status,
		stderr: run.stderr,
	}
}

/** `traced` where every call must succeed: what each call's request hook saw. */
async function requests(calls: readonly Call[], invalidation?: Invalidation, replies: readonly Reply[] = []) {
	const { hooks, kinds, status, stderr } = await traced(calls, invalidation, replies)
	expect({ kinds, status }, stderr).toEqual({ kinds: calls.map(() => "data"), status: 0 })
	return hooks
}

/** A request hook entry as `[selector, isStale, invalidatedBy]`. */
const seen = (h: HookTrace) => [h.selector, h.isStale, h.invalidatedBy]
/** A request hook entry's staleness as `[isStale, invalidatedBy]`. */
const staleOf = (h: HookTrace) => [h.isStale, h.invalidatedBy]
const staleness = (hooks: readonly HookTrace[]) => hooks.map((h) => h.isStale)

const OPEN: Invalidation = { staleTimeMs: 60_000 }

describe.skipIf(!JAVA)("stale tracking: a 2xx mutation stales its x-invalidate targets for the next read", SLOW, () => {
	/* new */
	it("shows each target's read as stale, invalidated by the mutation's selector", async () => {
		const hooks = await requests([CREATE, LIST, GET], OPEN)
		expect(hooks.map(seen)).toEqual([
			["POST /users", false, []],
			["GET /users", true, ["POST /users"]],
			["GET /users/1", true, ["POST /users"]],
		])
	})

	/* new */
	it("marks nothing for a mutation answered with an error, nor one without targets", async () => {
		const failed: Reply = { json: { message: "boom" }, status: 500 }
		const order: Reply = { json: { id: "o1" }, status: 201 }
		const [refused, untargeted] = await Promise.all([
			traced([CREATE, LIST], OPEN, [failed]),
			requests([ORDER, LIST], OPEN, [order]),
		])
		expect(
			{ refused: [refused.kinds, refused.status, refused.hooks.map(seen)], untargeted: untargeted.map(seen) },
			refused.stderr,
		).toEqual({
			refused: [
				["error", "data"],
				0,
				[
					["POST /users", false, []],
					["GET /users", false, []],
				],
			],
			untargeted: [
				["POST /orders", false, []],
				["GET /users", false, []],
			],
		})
	})

	/* new */
	it("a param-less mutation stales every instance of the templated read; one read clears it", async () => {
		const hooks = await requests([CREATE, GET, GET], OPEN)
		expect(staleness(hooks)).toEqual([false, true, false])
	})
})

describe.skipIf(!JAVA)("stale tracking: off without invalidation or with a zero staleTime", SLOW, () => {
	/* pin: with no config the driver sends none, and c1 hard-codes isStale false and invalidatedBy [] in every hook */
	it("marks nothing stale to the hooks without invalidation", async () => {
		const none = await requests([CREATE, LIST])
		expect(none.map(staleOf)).toEqual([
			[false, []],
			[false, []],
		])
	})

	/* new */
	it("marks nothing stale to the hooks at a zero staleTime", async () => {
		const zero = await requests([CREATE, LIST], { staleTimeMs: 0 })
		expect(zero.map(staleOf)).toEqual([
			[false, []],
			[false, []],
		])
	})
})

/** The consumer program's source: `StaleProbe` in the SDK's package, its imports and class in `body`. */
const program = (body: string): string => `package ${PACKAGE};\n${body}`

/** The SDK compiled once; each probe is run as `StaleProbe` and must compile and exit 0. */
let memo: CompiledJavaSdk | undefined
function probed(body: string): string[] {
	memo ??= compiledJavaSdk(FILES)
	const run = memo.run(`${PACKAGE}.StaleProbe`, program(body))
	expect({ diagnostics: run.diagnostics, status: run.status }, run.stderr).toEqual({ diagnostics: [], status: 0 })
	return run.stdout.split("\n").filter((line) => line !== "")
}

/* the lookup's cost: 16 keys, then 16,384, each a batch of 20,000 lookups of stale selectors (the marks are DELETE
 * mutations of `GET /users/{id}`, so each lookup finds its exact key); best CPU time of five rounds per size. An exact-key
 * lookup stays near 1x; the O(n) scan measured 450x, so 32x separates them with room for a cache-cold 16,384-key map
 * (measured 4.7x under load, where 4x flaked). */
const COST = `import java.lang.management.ManagementFactory;
import java.lang.management.ThreadMXBean;
import java.time.Duration;
import java.util.Locale;
import java.util.Map;

final class StaleProbe {
  private static final String[] TARGET = {"GET /users/{id}"};
  private static final int LOOKUPS = 20_000;
  private static final int ROUNDS = 5;

  private static long cpu() {
    return ManagementFactory.getThreadMXBean().getCurrentThreadCpuTime();
  }

  public static void main(String[] args) {
    ThreadMXBean threads = ManagementFactory.getThreadMXBean();
    if (!threads.isCurrentThreadCpuTimeSupported()) {
      throw new IllegalStateException("thread CPU time is not supported");
    }
    threads.setThreadCpuTimeEnabled(true);
    StaleTracker tracker = new StaleTracker(InvalidationConfig.builder()
        .staleTime(Duration.ofMinutes(10))
        .staleMaxEntries(100_000)
        .build());
    int[] sizes = {16, 16_384};
    long[] best = new long[sizes.length];
    int marked = 0;
    for (int s = 0; s < sizes.length; s++) {
      for (; marked < sizes[s]; marked++) {
        tracker.settle(tracker.begin("DELETE", "/users/" + marked), TARGET, Map.of("id", String.valueOf(marked)));
      }
      String[] paths = new String[sizes[s]];
      for (int k = 0; k < paths.length; k++) {
        paths[k] = "/users/" + k;
      }
      long fastest = Long.MAX_VALUE;
      int stale = 0;
      for (int round = 0; round < ROUNDS; round++) {
        stale = 0;
        long from = cpu();
        for (int i = 0; i < LOOKUPS; i++) {
          if (tracker.begin("GET", paths[i * 7919 % sizes[s]]).isStale()) {
            stale++;
          }
        }
        fastest = Math.min(fastest, cpu() - from);
      }
      System.out.println(sizes[s] + " keys: " + stale + " of " + LOOKUPS + " stale");
      best[s] = fastest;
    }
    System.out.println("ratio " + String.format(Locale.ROOT, "%.2f", (double) best[1] / best[0]));
  }
}
`

/* the eviction: staleMaxEntries 2 evicts the least recently staled down to 1 when three marks land; the open tracker
 * (default 1000) keeps all three */
const EVICTION = `import java.time.Duration;
import java.util.Map;

final class StaleProbe {
  private static String marks(StaleTracker tracker) {
    tracker.settle(tracker.begin("POST", "/touch"), new String[] {"GET /a", "GET /b", "GET /c"}, Map.of());
    return tracker.begin("GET", "/a").isStale() + " " + tracker.begin("GET", "/b").isStale()
        + " " + tracker.begin("GET", "/c").isStale();
  }

  public static void main(String[] args) {
    StaleTracker capped = new StaleTracker(InvalidationConfig.builder()
        .staleTime(Duration.ofMinutes(10)).staleMaxEntries(2).build());
    StaleTracker open = new StaleTracker(InvalidationConfig.builder()
        .staleTime(Duration.ofMinutes(10)).build());
    System.out.println("capped stale " + marks(capped));
    System.out.println("open stale " + marks(open));
  }
}
`

/* the source cap: maxSourcesPerTarget 1 records the first mutation only; the open tracker (default 16) records both */
const SOURCES = `import java.time.Duration;
import java.util.Map;

final class StaleProbe {
  private static String sources(StaleTracker tracker) {
    tracker.settle(tracker.begin("POST", "/users"), new String[] {"GET /users"}, Map.of());
    tracker.settle(tracker.begin("DELETE", "/users/1"), new String[] {"GET /users"}, Map.of());
    return tracker.begin("GET", "/users").invalidatedBy().toString();
  }

  public static void main(String[] args) {
    StaleTracker capped = new StaleTracker(InvalidationConfig.builder()
        .staleTime(Duration.ofMinutes(10)).maxSourcesPerTarget(1).build());
    StaleTracker open = new StaleTracker(InvalidationConfig.builder()
        .staleTime(Duration.ofMinutes(10)).build());
    System.out.println("capped " + sources(capped));
    System.out.println("open " + sources(open));
  }
}
`

/* the lapse: a one-second window reads stale at once and not after 1.1 s on the monotonic clock */
const LAPSE = `import java.time.Duration;
import java.util.Map;

final class StaleProbe {
  public static void main(String[] args) throws InterruptedException {
    StaleTracker tracker = new StaleTracker(InvalidationConfig.builder().staleTime(Duration.ofSeconds(1)).build());
    tracker.settle(tracker.begin("POST", "/users"), new String[] {"GET /users"}, Map.of());
    boolean early = tracker.begin("GET", "/users").isStale();
    Thread.sleep(1100);
    System.out.println("lapse " + early + " " + tracker.begin("GET", "/users").isStale());
  }
}
`

/* off: no config (null) and a zero staleTime mark nothing, so the read is never stale and invalidated by nothing */
const OFF = `import java.time.Duration;
import java.util.Map;

final class StaleProbe {
  private static String marks(StaleTracker tracker) {
    tracker.settle(tracker.begin("POST", "/users"), new String[] {"GET /users"}, Map.of());
    StaleMeta read = tracker.begin("GET", "/users");
    return read.isStale() + " " + read.invalidatedBy();
  }

  public static void main(String[] args) {
    System.out.println("none " + marks(new StaleTracker(null)));
    System.out.println("zero " + marks(new StaleTracker(InvalidationConfig.builder().staleTime(Duration.ZERO).build())));
  }
}
`

describe.skipIf(!JAVA)(
	"stale tracking: bounded, timed and lapsing in-process (the tracker, in the SDK's package)",
	SLOW,
	() => {
		/* new */
		it("looks a selector up without scanning every stale entry: 16,384 entries cost under 32x what 16 do, by CPU time", () => {
			const out = probed(COST)
			const ratio = Number(/^ratio (\S+)$/.exec(out.at(-1) ?? "")?.[1])
			expect(out.slice(0, -1)).toEqual(["16 keys: 20000 of 20000 stale", "16384 keys: 20000 of 20000 stale"])
			expect(ratio, out.join("\n")).toBeLessThan(32)
		})

		/* new */
		it("evicts the least recently staled down to half of staleMaxEntries, and keeps every mark under the default cap", () => {
			expect(probed(EVICTION)).toEqual(["capped stale false false true", "open stale true true true"])
		})

		/* new */
		it("keeps at most maxSourcesPerTarget mutations per stale selector", () => {
			expect(probed(SOURCES)).toEqual(["capped [POST /users]", "open [POST /users, DELETE /users/1]"])
		})

		/* new */
		it("lapses a mark once staleTime has passed on the monotonic clock", () => {
			expect(probed(LAPSE)).toEqual(["lapse true false"])
		})

		/* new */
		it("marks nothing without a config or at a zero staleTime, in-process", () => {
			expect(probed(OFF)).toEqual(["none false []", "zero false []"])
		})
	},
)

/** The stale runtime files a document's SDK ships, by file name. */
const staleFiles = (files: Readonly<Record<string, string>>): string[] =>
	Object.keys(files)
		.filter((path) => /\/(InvalidationConfig|StaleMeta|StaleTracker)\.java$/.test(path))
		.map((path) => path.slice(path.lastIndexOf("/") + 1))
		.sort()

/** The operation constants that carry x-invalidate targets: their sixth argument is the target array. */
const targets = (files: Readonly<Record<string, string>>) =>
	Object.values(files).filter((text) => /(true|false),\s+new String\[\] \{[^}]*\}\);/.test(text)).length

describe("stale tracking: the exchange ships its stale tracker; only the op's targets follow x-invalidate", () => {
	/* new */
	it("ships the three stale files with every operation SDK, none with a zero-op SDK, and targets only where x-invalidate names them", () => {
		const bare = generateJavaSdk(FIXTURES.errors.document()).files
		const zeroOp = generateJavaSdk({ openapi: "3.1.0", info: { title: "t", version: "1" }, paths: {} }).files
		expect({
			bare: staleFiles(bare),
			marked: staleFiles(FILES),
			targetsBare: targets(bare),
			targetsMarked: targets(FILES) > 0,
			zeroOp: staleFiles(zeroOp),
		}).toEqual({
			bare: ["InvalidationConfig.java", "StaleMeta.java", "StaleTracker.java"],
			marked: ["InvalidationConfig.java", "StaleMeta.java", "StaleTracker.java"],
			targetsBare: 0,
			targetsMarked: true,
			zeroOp: [],
		})
	})
})
