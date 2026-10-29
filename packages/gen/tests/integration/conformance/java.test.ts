/**
 * The Java target of the conformance grid (R1/G17, bit 16 phase e): every `cellsFor("java")` cell through the SDK
 * `generateJavaSdk` emits from the spawned reference app's served document, built once per suite under `--release 17
 * -Xlint:all -Werror` and google-java-format clean, and sent by the fixed reflection driver, one JVM per cell,
 * `Observed[]` back. Java ships every stream kind, so it lacks no cell. The suites run every cell on the pinned JDKs:
 * 21 (the default), 17 (the floor the SDK targets) and 25 (the newest pin), each against its own app. The safe
 * variant (bit 21 i6, R-i6) sends one cell per response kind through `client.safe()` on each of the three JDKs, the
 * driver reading each `Result` strictly, and its compile leg holds every operation's safe call to its normal one and
 * narrows it under javac. Opt-in: `vitest run --mode harness`.
 */
import { describe, expect, it } from "vitest"
import {
	clientOf,
	type DrivenJavaSdk,
	type DriverSession,
	servedJavaSdk,
} from "../../../src/emit/java/__fixtures__/driven.ts"
import { withJava } from "../../../src/emit/java/__fixtures__/java-env.ts"
import { generateJavaSdk, javaCallPlans } from "../../../src/emit/java/sdk.ts"
import type { JavaCallPlan } from "../../../src/emit/java/sdk-plan.ts"
import { originsOf, type ReferenceApp, type TargetRunner, targetSuite } from "./harness.ts"
import type { Observed } from "./matrix.ts"
import { SAFE } from "./safe.ts"

const JAVA = withJava()

/* new: csharp.test.ts:22-41 (the runner); the grid is shared */
/**
 * The Java runner on `jdk`, in the normal style or the safe one: the SDK built once from the served document, javac
 * -Werror and GJF-clean (C#'s Fe1). A cell the driver cannot express exits non-zero with the reason on stderr, and the
 * runner throws it: the cell is red, never skipped. A normal cell is one JVM; the safe style's cells share one kept JVM
 * (the driver's serve mode, bit 21 i6's carry-in: 17 cells one JVM each added 31 s across the three JDKs), each on a
 * fresh client.
 */
function javaRunner(jdk: 17 | 21 | 25, variant?: string, safe = false): TargetRunner {
	let sdk: DrivenJavaSdk | undefined
	let kept: DriverSession | undefined
	return {
		finish: () => kept?.close(),
		async prepare(app) {
			const served = servedJavaSdk(app.document)
			if (!served.built) throw new Error(served.diagnostics.join("\n"))
			const findings = served.format()
			if (findings.length > 0) throw new Error(`google-java-format would change: ${findings.join(", ")}`)
			sdk = served
			if (safe) kept = served.session(jdk)
		},
		async run(cell, app) {
			if (sdk === undefined) throw new Error("the Java runner ran a cell before prepare")
			const ran =
				kept === undefined
					? await sdk.runCalls(cell, originsOf(app), { jdk })
					: await kept.run(cell, originsOf(app), true)
			if (ran.status !== 0) throw new Error(`driver exit ${ran.status}: ${ran.stderr}`)
			return ran.observed as readonly Observed[]
		},
		target: "java",
		...(variant === undefined ? {} : { variant }),
	}
}

/** What a safe call is held to: the very connection, a Result of no body, or a Result of its answer (a stream's too). */
const twinKind = (plan: JavaCallPlan) =>
	plan.stream === "ws" || plan.stream === "realtime"
		? "ident"
		: plan.response === "none" && plan.stream === null
			? "none"
			: plan.stream === "sse"
				? "stream"
				: "value"

/** One operation's method on `client` with `n` null arguments: its params, and the holder and options after. */
const at = (plan: JavaCallPlan, client: string, n: number) =>
	[client, ...plan.accessors.map((a) => `${a}()`), `${plan.method}(${Array(n).fill("null").join(", ")})`].join(".")

/** One operation's lines: its safe call held to its normal one (the same answer), on both its overloads, and narrowed. */
function safeOp(plan: JavaCallPlan, i: number): string[] {
	const widest = plan.responseHeaders === null ? 2 : 3
	const overloads = [1, widest].flatMap((n) => {
		const normal = at(plan, "c", n)
		const safe = at(plan, "c.safe()", n)
		return {
			ident: [`    var n${n} = ${normal};`, `    var s${n} = ${safe};`, `    n${n} = s${n};`, `    s${n} = n${n};`],
			none: [`    ${normal};`, `    narrow(${safe});`],
			stream: [`    var n${n} = Optional.ofNullable(${normal});`, `    stream(hold(n${n}, ${safe}));`],
			value: [`    var n${n} = Optional.ofNullable(${normal});`, `    narrow(hold(n${n}, ${safe}));`],
		}[twinKind(plan)]
	})
	return [`  static void op${i}(${CLIENT} c) {`, ...overloads, "  }"]
}

/* the program's stand-in for the client's class name, set per document */
const CLIENT = "{client}"

/** The compile leg's helpers: `hold`, the narrowing over every member of `Result`, a stream's read, the base's kinds. */
const SAFE_LEG_HELPERS = [
	"  private SafeLeg() {}",
	"",
	"  private static <T> Result<T> hold(Optional<T> normal, Result<T> safe) {",
	"    return safe;",
	"  }",
	"",
	"  private static <T> int narrow(Result<T> r) {",
	"    RawResponse response = r.response();",
	"    int n = r.isOk() ? response.status() : 0;",
	"    n += r.fold(data -> data == null ? 0 : 1, SafeLeg::kind);",
	"    if (r instanceof Result.Ok<T> ok) {",
	"      n += ok.data() == null ? 0 : ok.response().status();",
	"    }",
	"    if (r instanceof Result.Err<T> err) {",
	"      n += kind(err.error()) + err.response().status();",
	"    }",
	"    try {",
	"      n += r.orElseThrow() == null ? 0 : 1;",
	"    } catch (SdkException e) {",
	"      n += kind(e);",
	"    }",
	"    return n;",
	"  }",
	"",
	"  private static <E> void stream(Result<EventStream<E>> r) {",
	"    narrow(r);",
	"    if (r instanceof Result.Ok<EventStream<E>> ok) {",
	"      for (SseEvent<E> event : ok.data()) {",
	"        if (event != null) {",
	"          break;",
	"        }",
	"      }",
	"    }",
	"  }",
	"",
	"  private static int kind(SdkException e) {",
	"    if (e instanceof ApiException status) {",
	"      return status.status();",
	"    }",
	"    return e instanceof DecodeException decode ? decode.getMessage().length() : 0;",
	"  }",
	"",
]

/**
 * The compile leg's program (R-i6 a): for every operation, its `client.safe()` call on its one-argument overload and
 * its widest, held to the normal one (`hold`: `Optional<T>` of the normal answer, the very type the standalone `var`
 * infers, against `Result<T>`, so a twin answering any other `T` does not compile; a no-body one `Result<Void>`; a
 * stream's `Result<EventStream<E>>` read with for-each), and narrowed through every member of `Result` (`response`,
 * `isOk`, `fold`, `orElseThrow`, the `Ok` and `Err` records by `instanceof` and the `SdkException` base by each of its
 * two kinds); a connection the very same type both ways. Never called: compiling it is the assertion.
 */
function safeLeg(plans: readonly JavaCallPlan[], client: string, pkg: string): string {
	return [
		"package probe;",
		"",
		`import ${pkg}.*;`,
		"import java.util.Optional;",
		"",
		"/* bit 21 i6, R-i6 (a): every operation's safe call, held to its normal one and narrowed */",
		"public final class SafeLeg {",
		...SAFE_LEG_HELPERS,
		...plans.flatMap((plan, i) => [...safeOp(plan, i), ""]),
		"  public static void main(String[] args) {",
		`    System.out.println(${plans.length});`,
		"  }",
		"}",
		"",
	]
		.join("\n")
		.replaceAll(CLIENT, client)
}

/** The compile leg (R-i6 a): safeLeg over the served document's SDK, checked clean by javac, and not vacuous. */
function compileLeg(app: () => ReferenceApp) {
	describe("conformance × java (safe): every operation's safe call compiles", () => {
		it("holds each client.safe() call to its normal one on both overloads and narrows its Result, under javac", () => {
			const plans = Object.values(javaCallPlans(app().document))
			const kinds = plans.map(twinKind)
			expect({
				calls: plans.length > 20,
				connections: kinds.includes("ident"),
				headers: plans.some((plan) => plan.responseHeaders !== null),
				none: kinds.includes("none"),
				streams: kinds.includes("stream"),
			}).toEqual({ calls: true, connections: true, headers: true, none: true, streams: true })
			const sdk = servedJavaSdk(app().document)
			expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
			const { client, pkg } = clientOf(generateJavaSdk(app().document).files)
			const ran = sdk.run("probe.SafeLeg", safeLeg(plans, client, pkg))
			expect({ diagnostics: ran.diagnostics, out: ran.stdout.trim(), status: ran.status }).toEqual({
				diagnostics: [],
				out: String(plans.length),
				status: 0,
			})
		}, 600_000)
	})
}

describe.skipIf(!JAVA)("java toolchain", () => {
	targetSuite(javaRunner(21))
	targetSuite(javaRunner(17, "JDK 17"))
	targetSuite(javaRunner(25, "JDK 25"))
	/* the compile leg reads the safe suite's app, so a run of the safe style alone keeps it */
	const app = targetSuite(javaRunner(21, SAFE, true))
	targetSuite(javaRunner(17, `${SAFE} JDK 17`, true))
	targetSuite(javaRunner(25, `${SAFE} JDK 25`, true))
	compileLeg(app)
})
