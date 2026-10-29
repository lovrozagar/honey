/**
 * The Java target of the conformance grid (R1/G17, bit 16 phase e): every `cellsFor("java")` cell through the SDK
 * `generateJavaSdk` emits from the spawned reference app's served document, built once per suite under `--release 17
 * -Xlint:all -Werror` and google-java-format clean, and sent by the fixed reflection driver, one JVM per cell,
 * `Observed[]` back. Java ships every stream kind, so it lacks no cell. The suites run every cell on the pinned JDKs:
 * 21 (the default), 17 (the floor the SDK targets) and 25 (the newest pin), each against its own app.
 * Opt-in: `vitest run --mode harness`.
 */
import { describe } from "vitest"
import { type DrivenJavaSdk, servedJavaSdk } from "../../../src/emit/java/__fixtures__/driven.ts"
import { withJava } from "../../../src/emit/java/__fixtures__/java-env.ts"
import { originsOf, safeVariant, type TargetRunner, targetSuite } from "./harness.ts"
import type { Observed } from "./matrix.ts"

const JAVA = withJava()

/* new: csharp.test.ts:22-41 (the runner); the grid is shared */
/**
 * The Java runner on `jdk`: the SDK built once from the served document, javac -Werror and GJF-clean (C#'s Fe1). A
 * cell the driver cannot express exits non-zero with the reason on stderr, and the runner throws it: the cell is red,
 * never skipped.
 */
function javaRunner(jdk: 17 | 21 | 25, variant?: string): TargetRunner {
	let sdk: DrivenJavaSdk | undefined
	return {
		async prepare(app) {
			const served = servedJavaSdk(app.document)
			if (!served.built) throw new Error(served.diagnostics.join("\n"))
			const findings = served.format()
			if (findings.length > 0) throw new Error(`google-java-format would change: ${findings.join(", ")}`)
			sdk = served
		},
		async run(cell, app) {
			if (sdk === undefined) throw new Error("the Java runner ran a cell before prepare")
			const ran = await sdk.runCalls(cell, originsOf(app), { jdk })
			if (ran.status !== 0) throw new Error(`driver exit ${ran.status}: ${ran.stderr}`)
			return ran.observed as readonly Observed[]
		},
		target: "java",
		...(variant === undefined ? {} : { variant }),
	}
}

describe.skipIf(!JAVA)("java toolchain", () => {
	targetSuite(javaRunner(21))
	targetSuite(javaRunner(17, "JDK 17"))
	targetSuite(javaRunner(25, "JDK 25"))
	targetSuite(safeVariant(javaRunner(21), "i6"))
})
