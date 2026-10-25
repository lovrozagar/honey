/**
 * The Java half of gen's adversarial suite (bit 16 fix): spec text written into a Java SDK stays text. An operation id,
 * description or summary that would end a doc comment (`*\/` as written, or spelled with `\u` escapes javac reads
 * before it lexes, JLS 3.3) and open a static initializer is inert: the SDK compiles, and every one of its classes
 * loads without running the payload. An enum value holding a quote, a backslash and a `\u` escape reads back from the
 * compiled constant as it came. docOf, the one writer of the emitter's doc comments, holds over the F2 comment fuzz.
 */
import { describe, expect, it } from "vitest"
import { failures } from "../shared/__fixtures__/escape-oracle.ts"
import { compiledJavaSdk } from "./__fixtures__/compiled.ts"
import { withJava } from "./__fixtures__/java-env.ts"
import { docOf } from "./sdk-decl.ts"
import { generateJavaSdk } from "./sdk.ts"

const JAVA = withJava()
const SLOW = { timeout: 600_000 }

/** A static initializer that ends the JVM with 7 when its class loads. */
const PAYLOAD = "static { Runtime.getRuntime().halt(7); }"

/* the ways spec text could close a doc comment: as written, and as javac reads `\u` escapes before it lexes */
const CLOSERS = ["*/", "\\u002a/", "\\u002a\\u002f", "\\uuu002a\\u002F", "*\\u002f"]

/** One GET answering 204, its id, description and summary each carrying `closer` and the payload. */
const hostile = (closer: string, i: number) => ({
	[`/h${i}`]: {
		get: {
			description: `d ${closer} ${PAYLOAD} /**`,
			operationId: `h${i} ${closer} ${PAYLOAD} /** x`,
			responses: { 204: { description: "none" } },
			summary: `s ${closer} ${PAYLOAD} /**`,
		},
	},
})

/* an enum value holding what ends or escapes a Java string literal */
const VALUES = ['a"b', "c\\d", "e\\u000af", "g\\u0022h", "i\nj"]

const document = {
	components: { schemas: { Hostile: { enum: VALUES, type: "string" } } },
	info: { title: "Hostile", version: "1.0.0" },
	openapi: "3.1.0",
	paths: Object.assign({}, ...CLOSERS.map(hostile), {
		"/e": {
			get: {
				operationId: "e.get",
				responses: {
					200: {
						content: { "application/json": { schema: { $ref: "#/components/schemas/Hostile" } } },
						description: "ok",
					},
				},
			},
		},
	}),
}

/** A program loading (and so initializing) every class the SDK compiled, then printing each Hostile constant's wire value. */
const loader = (out: string, pkg: string) => `package probe;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.Stream;

public final class Loads {
  public static void main(String[] args) throws Exception {
    Path out = Paths.get(${JSON.stringify(out)});
    List<String> names;
    try (Stream<Path> walk = Files.walk(out)) {
      names = walk.map(out::relativize).map(Path::toString).filter(n -> n.endsWith(".class") && !n.startsWith("probe"))
          .map(n -> n.substring(0, n.length() - 6).replace('/', '.')).collect(Collectors.toList());
    }
    for (String name : names) Class.forName(name, true, Loads.class.getClassLoader());
    System.out.println("loaded " + names.size());
    for (java.lang.reflect.Field field : Class.forName("${pkg}.Hostile").getFields()) {
      JsonProperty wire = field.getAnnotation(JsonProperty.class);
      if (wire != null) System.out.println("value " + wire.value().codePoints().mapToObj(Integer::toString).collect(Collectors.joining(",")));
    }
  }
}
`

describe.skipIf(!JAVA)("gen adversarial: spec text in a Java SDK", SLOW, () => {
	it("compiles an SDK whose ids, descriptions and summaries try to close a doc comment, and loads every class without running the payload", () => {
		const files = generateJavaSdk(document, { packageName: "com.example.hostile" }).files
		const sdk = compiledJavaSdk(files)
		const ran = sdk.run("probe.Loads", loader(sdk.out, "com.example.hostile"))
		const values = ran.stdout
			.split("\n")
			.filter((line) => line.startsWith("value "))
			.map((line) => String.fromCodePoint(...line.slice(6).split(",").map(Number)))
		expect([
			sdk.javac.diagnostics,
			ran.diagnostics,
			ran.status,
			ran.stdout.startsWith("loaded "),
			values.sort(),
		]).toEqual([[], [], 0, true, [...VALUES].sort()])
	})
})

/** What is wrong with `text` in a Java doc comment as javac reads it (`\u` escapes first), or null. */
function docProblem(text: string): string | null {
	const doc = docOf(text, "")
	/* javac's view: every eligible `\u` escape (an odd run of backslashes before `u`s and four hex digits) translated */
	const lexed = doc.replace(
		/(?<!\\)(\\\\)*\\u+([0-9a-fA-F]{4})/g,
		(match, pairs: string | undefined, hex: string) => `${pairs ?? ""}${String.fromCharCode(Number.parseInt(hex, 16))}`,
	)
	if (lexed.indexOf("*/") !== lexed.length - 2) return "the comment closes before its end"
	if (/\\u/.test(doc)) return "a backslash javac could read as an escape"
	const raw = (cp: number) => cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0xfeff || cp === 0x2028 || cp === 0x2029
	if ([...doc].some((ch) => raw(ch.codePointAt(0) as number))) return "a control raw"
	return null
}

describe("gen adversarial: docOf, the Java emitter's doc comments", () => {
	it("never closes early, never leaves a `\\u` escape, never a control, over named closers and the F2 fuzz", () => {
		const named = [...CLOSERS.map((closer) => `a ${closer} ${PAYLOAD}`), "x\u0000y\u2028z", "\\", "\\\\u0041"]
		expect([named.map(docProblem), failures(47, docProblem, 2_000)]).toEqual([named.map(() => null), []])
	})
})
