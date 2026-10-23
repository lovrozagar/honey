/**
 * The emitted Java SDK, held to the toolchain (bit 16 phase a, D2, D3; Qa1 and Qa2): javac `--release 17 -Xlint:all
 * -Werror` compiles it against exactly the three pinned Jackson and annotation jars, and refuses a `close()` on the
 * HttpClient; google-java-format `--dry-run` on the 21 pin lists nothing, and lists a mis-indented sibling, so the
 * leg is not hollow; one offline Gradle build succeeds and leaves no daemon alive. Every executed leg is gated on
 * Java's presence, as the C# files gate on .NET (`java-env.ts`). The default run compiles on 21; the CI matrix
 * compiles on 17, 21 and 25.
 */
import { basename } from "node:path"
import { describe, expect, it } from "vitest"
import { compiledJavaSdk } from "./__fixtures__/compiled.ts"
import { FIXTURES, type FixtureKey, type JavaFixture } from "./__fixtures__/documents.ts"
import { withJava } from "./__fixtures__/java-env.ts"
import { errors } from "../shared/__fixtures__/documents-http.ts"
import { generateJavaSdk } from "./sdk.ts"

type Json = Record<string, unknown>
type Files = Readonly<Record<string, string>>

/** Whether Java is pinned here: a missing toolchain fails where it is required and skips these legs elsewhere. */
const JAVA = withJava()
/** Every executed describe's bound: a cold gate fetches nothing, but a cold Gradle build takes minutes. */
const SLOW = { timeout: 600_000 }

/** The zero-op document: no path, so no operation. */
const ZERO: Json = { info: { title: "Anyrow", version: "1" }, openapi: "3.1.0", paths: {} }

/** The three jars the SDK compiles against, by file name, sorted. */
const JARS = ["jackson-annotations-2.22.jar", "jackson-core-3.2.4.jar", "jackson-databind-3.2.4.jar"]
/** The class files javac writes for the zero-op SDK, sorted. */
const CLASSES = ["ai/anyrow/AnyrowClient$Builder.class", "ai/anyrow/AnyrowClient.class", "ai/anyrow/Transport.class"]

const TRANSPORT = "src/main/java/ai/anyrow/Transport.java"
const FORMAT_PATH = "ai/anyrow/Transport.java"

/** The emitted files, with `name`'s text replaced by `text`. */
const withFile = (name: string, text: string): Files => ({ ...generateJavaSdk(ZERO).files, [name]: text })

/** The zero-op SDK compiled and checked as the emitter emits it. */
const sdk = () => compiledJavaSdk(generateJavaSdk(ZERO).files)

describe.skipIf(!JAVA)("javac --release 17 -Xlint:all -Werror: the emitted SDK", SLOW, () => {
	it("compiles against exactly the three pinned jars, with no diagnostic, into exactly the expected classes", () => {
		const built = sdk()
		expect({
			classes: [...built.javac.classes].sort(),
			classpath: built.classpath.map((jar) => basename(jar)).sort(),
			diagnostics: built.javac.diagnostics,
		}).toEqual({ classes: CLASSES, classpath: JARS, diagnostics: [] })
	})

	it("refuses HttpClient.close() under --release 17, so the no-close rule is javac's, not a convention", () => {
		const closing = (generateJavaSdk(ZERO).files[TRANSPORT] ?? "").replace(
			/\}\n$/,
			"  void stop() {\n    http.close();\n  }\n}\n",
		)
		expect(compiledJavaSdk(withFile(TRANSPORT, closing)).javac.diagnostics.join("\n")).toMatch(
			/symbol:\s+method close\(\)/,
		)
	})
})

describe.skipIf(!JAVA)("google-java-format --dry-run on the 21 pin: the emitted SDK", SLOW, () => {
	it("lists nothing: the emitted bytes are GJF's canonical form", () => {
		expect(sdk().format()).toEqual([])
	})

	it("lists a mis-indented file, so the clean result above is a check, not a no-op", () => {
		const indented = (generateJavaSdk(ZERO).files[TRANSPORT] ?? "").replace(/^ {2}/gm, "    ")
		expect(compiledJavaSdk(withFile(TRANSPORT, indented)).format()).toEqual([FORMAT_PATH])
	})
})

describe.skipIf(!JAVA)(
	"google-java-format --dry-run on the error keys and the HTTP surface: the emitted SDK",
	SLOW,
	() => {
		/* new: a 404 envelope's record component and the ErrorKey doc overflowed 100 columns, and GJF re-wrapped both */
		it("lists nothing for the errors document, which declares the envelope and the ErrorKey file", () => {
			expect(compiledJavaSdk(generateJavaSdk(errors()).files).format()).toEqual([])
		})

		/*
		 * new: a signature, a record header's implements and a switch arm past 100 columns each stayed on one line; and
		 * the runtime-gating combinations (the d2a ruling: an always-shipped file must never name a gated one), each
		 * compiled -Werror: zero-op (above), plain operations (errors, http, fixtures), SSE alone (sse), WebSocket alone
		 * (ws: the core and the WebSocket files), and SSE with WebSocket (streams)
		 */
		it.each(Object.keys(FIXTURES) as FixtureKey[])(
			"compiles the %s fixture SDK clean, and GJF lists nothing",
			(key) => {
				const fixture: JavaFixture = FIXTURES[key]
				const built = compiledJavaSdk(generateJavaSdk(fixture.document(), fixture.options).files)
				expect({ diagnostics: built.javac.diagnostics, format: built.format() }).toEqual({
					diagnostics: [],
					format: [],
				})
			},
		)
	},
)

describe.skipIf(!JAVA)("one offline Gradle build of the emitted SDK", SLOW, () => {
	it("succeeds, and leaves no Gradle daemon alive, checked by command line", () => {
		expect(sdk().gradle()).toEqual({ daemons: [], status: 0 })
	})
})
