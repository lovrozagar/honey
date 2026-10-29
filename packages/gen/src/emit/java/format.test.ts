/**
 * The emitted Java SDK, held to the toolchain (bit 16 phase a, D2, D3; Qa1 and Qa2): javac `--release 17 -Xlint:all
 * -Werror` compiles it against exactly the three pinned Jackson and annotation jars, and refuses a `close()` on the
 * HttpClient; google-java-format `--dry-run` on the 21 pin lists nothing, and lists a mis-indented sibling, so the
 * leg is not hollow; one offline Gradle build succeeds and leaves no daemon alive. Every executed leg is gated on
 * Java's presence, as the C# files gate on .NET (`java-env.ts`). The default run compiles on 21; the CI matrix
 * compiles on 17, 21 and 25.
 */
import { basename, join } from "node:path"
import { describe, expect, it } from "vitest"
import { compiledJavaSdk } from "./__fixtures__/compiled.ts"
import { FIXTURES, type FixtureKey, type JavaFixture } from "./__fixtures__/documents.ts"
import { runGjf, withJava } from "./__fixtures__/java-env.ts"
import { errors } from "../shared/__fixtures__/documents-http.ts"
import { LONG_LENGTHS, longNames } from "../shared/__fixtures__/documents-long.ts"
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
		 * (ws: the core and the WebSocket files), realtime alone (realtime: the core, the WebSocket and the realtime
		 * files), and every stream kind together (streams)
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

/*
 * bit 21 i6: a twin's body as google-java-format lays a trailing lambda, its two longer forms reached only by long
 * method names: both arguments on one continuation (55 letters), the lambda on its own line (65), its body below the arrow (80)
 */
const LONG = { a: "a".repeat(65), b: "b".repeat(80), c: "c".repeat(55) }
const LONG_NAMES: Json = {
	...ZERO,
	paths: Object.fromEntries(
		Object.values(LONG).map((name) => [
			`/${name}`,
			{
				get: {
					operationId: name,
					responses: { 200: { content: { "text/plain": { schema: { type: "string" } } }, description: "ok" } },
				},
			},
		]),
	),
}
/** The mirror client's body line of `name`'s widest twin and the lines after it, to its closing brace. */
const twinBody = (files: Files, name: string) => {
	const lines = (files["src/main/java/ai/anyrow/SafeAnyrowClient.java"] ?? "").split("\n")
	const at = lines.findIndex(
		(line, i) =>
			line.startsWith("    return Answer.safe(") &&
			lines
				.slice(i, i + 5)
				.join("")
				.includes(name),
	)
	return lines.slice(at, lines.indexOf("  }", at))
}

describe("generateJavaSdk: a twin's body in each of google-java-format's lambda layouts (bit 21 i6)", () => {
	it("lays the lambda on its own line past one shared line, and its body below the arrow past that", () => {
		const files = generateJavaSdk(LONG_NAMES).files
		expect({ a: twinBody(files, LONG.a), b: twinBody(files, LONG.b), c: twinBody(files, LONG.c) }).toEqual({
			a: ["    return Answer.safe(", "        options,", `        o -> _n.${LONG.a}(params, o));`],
			b: [
				"    return Answer.safe(",
				"        options,",
				"        o ->",
				`            _n.${LONG.b}(`,
				"                params, o));",
			],
			c: ["    return Answer.safe(", `        options, o -> _n.${LONG.c}(params, o));`],
		})
	})

	it.skipIf(!JAVA)("lays each body as google-java-format's own output of the file does, and compiles", SLOW, () => {
		const built = compiledJavaSdk(generateJavaSdk(LONG_NAMES).files)
		const formatted = runGjf([join(built.dir, "src/main/java/ai/anyrow/SafeAnyrowClient.java")]).stdout
		const ours = generateJavaSdk(LONG_NAMES).files
		expect({
			bodies: [LONG.a, LONG.b, LONG.c].map((name) => formatted.includes(twinBody(ours, name).join("\n"))),
			diagnostics: built.javac.diagnostics,
		}).toEqual({ bodies: [true, true, true], diagnostics: [] })
	})
})

/*
 * bit 21 i7a: past ~60 characters a name pushed the normal client's layouts (a constant, a signature, a record's
 * header, a delegation) off google-java-format's; layout.ts is its layout, ported. The long-name document crosses
 * every width at each length, so every file it gives, the normal client, the safe mirror and the types, is held to
 * GJF's own text
 */
describe.skipIf(!JAVA)("google-java-format --dry-run on the long-name SDK (bit 21 i7a)", SLOW, () => {
	it("lists no file of the client, its safe mirror or its types, and the SDK compiles clean", () => {
		const files = generateJavaSdk(longNames()).files
		const built = compiledJavaSdk(files)
		const sources = Object.keys(files).filter((name) => name.endsWith(".java"))
		const longest = Math.max(...Object.values(files).flatMap((text) => text.split("\n").map((line) => line.length)))
		expect({
			diagnostics: built.javac.diagnostics,
			format: built.format(),
			/* not vacuous: a name alone passes the width, and every kind of file is among those held */
			past: longest > 100 && Math.max(...LONG_LENGTHS) > 100,
			reached: ["AnyrowClient.java", "SafeAnyrowClient.java", "Resource.java", "Params.java", "Headers.java"].map(
				(end) => sources.some((name) => name.endsWith(end)),
			),
		}).toEqual({ diagnostics: [], format: [], past: true, reached: [true, true, true, true, true] })
	})
})
