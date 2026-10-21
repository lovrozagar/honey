/**
 * The F2 cross-check against the real compilers: a seeded batch of literals (and comments) goes
 * into one program per language, which prints each string's UTF-8 bytes; they must equal the bytes
 * of the text as written. This lifts the fuzz's spec-derived readers to compiler-verified. Runs
 * where the toolchains are; `HONEY_REQUIRE_TOOLCHAINS=1` (CI's test and harness jobs) makes a missing one fail.
 */
import { type SpawnSyncReturns, spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
	csharpCacheDir,
	dotnetRequired,
	hasDotnet,
	pinnedDotnet,
	refPack,
	runCsc,
	runDotnet,
	runtimeConfig,
} from "../csharp/__fixtures__/csharp-env.ts"
import { goCacheDir, goRequired, hasGo, runGo } from "../go/__fixtures__/go-env.ts"
import { javaCacheDir, runJava, runJavac, withJava } from "../java/__fixtures__/java-env.ts"
import {
	hasPython,
	pinnedPython,
	pythonCacheDir,
	pythonRequired,
	runPython,
	venv,
} from "../python/__fixtures__/python-env.ts"
import { hasRust, runRustc, rustCacheDir, rustRequired } from "../rust/__fixtures__/rust-env.ts"
import { rng, runs } from "./__fixtures__/rng.ts"
import {
	csDocLines,
	csString,
	goString,
	javaDocLines,
	javaLineComment,
	javaString,
	lineComment,
	pyString,
	rustString,
	wellFormed,
} from "./escape.ts"

const TOKENS: readonly string[] = [
	"a",
	" ",
	'"',
	"'",
	"\\",
	"\n",
	"\r",
	"\t",
	"\0",
	"\u0001",
	"\u001f",
	"\u007f",
	"\u0085",
	"\u2028",
	"\u2029",
	"\uFEFF",
	"\uD800",
	"\uDC00",
	"\u{1F600}",
	"é",
	"*/",
	'"""',
	"${",
	"{}",
	"%s",
]

type Language = {
	readonly file: string
	/** compile and run `path`, a program in `dir`, which prints one hex line per string */
	readonly exec: (path: string, dir: string) => SpawnSyncReturns<string>
	/** where its work dirs go: its toolchain's cache, off /tmp (00-rules) */
	readonly home: () => string
	/** whether its toolchain is here: the pinned one (G10) */
	readonly present: () => boolean
	/** whether a missing toolchain fails rather than skips */
	readonly required: () => boolean
	readonly source: (texts: readonly string[]) => string
	readonly tool: string
}

/** `command args`, its output as text. */
const spawn = (command: string, args: readonly string[]) =>
	spawnSync(command, [...args], { encoding: "utf8", maxBuffer: 1 << 26 })

/** csc's flags for a program: no response file, nullable on, every warning an error, the pinned SDK's references. */
const cscProgram = () => [
	"-nologo",
	"-noconfig",
	"-nullable:enable",
	"-warnaserror",
	"-langversion:latest",
	"-target:exe",
	...readdirSync(refPack())
		.filter((name) => name.endsWith(".dll"))
		.map((name) => `-r:${join(refPack(), name)}`),
]

const LANGUAGES: Readonly<Record<string, Language>> = {
	csharp: {
		/* -doc reads every /// line as XML, badly formed text an error (CS1570); csc reports to stdout */
		exec: (_, dir) => {
			const built = runCsc([...cscProgram(), "-doc:p.xml", "-out:p.dll", "Program.cs"], { cwd: dir })
			if (built.status !== 0) return { ...built, stderr: built.stdout }
			writeFileSync(join(dir, "p.runtimeconfig.json"), runtimeConfig())
			return runDotnet(["p.dll"], { cwd: dir })
		},
		file: "Program.cs",
		home: () => csharpCacheDir("tmp"),
		present: hasDotnet,
		required: dotnetRequired,
		source: (texts) =>
			[
				"using System;",
				"using System.Text;",
				"/// <summary>",
				...texts.flatMap((text) => csDocLines(text).map((line: string) => `/// ${line}`)),
				"/// </summary>",
				"internal static class Program",
				"{",
				"    private static void Main()",
				"    {",
				`        foreach (var s in new string[] { ${texts.map(csString).join(", ")} })`,
				"            Console.WriteLine(Convert.ToHexString(Encoding.UTF8.GetBytes(s)).ToLowerInvariant());",
				"    }",
				"}",
			].join("\n"),
		tool: `dotnet ${pinnedDotnet()}`,
	},
	go: {
		exec: (path) => runGo(["run", path]),
		file: "main.go",
		home: () => goCacheDir("tmp"),
		present: hasGo,
		required: goRequired,
		source: (texts) =>
			[
				"package main",
				'import ("encoding/hex"; "fmt")',
				...texts.flatMap((text) => lineComment(text, "//")),
				"func main() {",
				`for _, s := range []string{${texts.map(goString).join(", ")}} { fmt.Println(hex.EncodeToString([]byte(s))) }`,
				"}",
			].join("\n"),
		tool: "go",
	},
	python: {
		exec: (path) => runPython(venv({ python: pinnedPython(), requirements: [] }), [path]),
		file: "main.py",
		home: () => pythonCacheDir("tmp"),
		present: () => hasPython(),
		required: pythonRequired,
		source: (texts) =>
			[
				...texts.flatMap((text) => lineComment(text, "#")),
				`for s in [${texts.map(pyString).join(", ")}]:`,
				'    print(s.encode("utf-8").hex())',
			].join("\n"),
		tool: `python ${pinnedPython()}`,
	},
	rust: {
		/* edition 2024, the emitted SDK's: a literal's escapes read the same in 2021 */
		exec: (path, dir) => {
			const built = runRustc(["--edition", "2024", "-o", join(dir, "main"), path])
			return built.status === 0 ? spawn(join(dir, "main"), []) : built
		},
		file: "main.rs",
		home: () => rustCacheDir("tmp"),
		present: () => hasRust(),
		required: rustRequired,
		source: (texts) =>
			[
				...texts.flatMap((text) => lineComment(text, "///")),
				"fn main() {",
				`for s in [${texts.map(rustString).join(", ")}] { println!("{}", s.bytes().map(|b| format!("{:02x}", b)).collect::<String>()); }`,
				"}",
			].join("\n"),
		tool: "rustc",
	},
}

/** The languages whose toolchain is here, checked once: a missing one is skipped, or fails where it is required. */
const PRESENT = new Set(Object.keys(LANGUAGES).filter((name) => (LANGUAGES[name] as Language).present()))
const SKIPPED = (name: string) => !PRESENT.has(name) && !(LANGUAGES[name] as Language).required()

/** The hex of each string `language`'s compiler made of the literals of `texts`. */
function compiled(language: Language, texts: readonly string[]): string[] {
	const dir = mkdtempSync(join(language.home(), "honey-f2-"))
	try {
		const path = join(dir, language.file)
		writeFileSync(path, language.source(texts))
		const result = language.exec(path, dir)
		if (result.status !== 0) throw new Error(`${language.tool} failed: ${result.stderr}`)
		return result.stdout.trim().split("\n")
	} finally {
		rmSync(dir, { force: true, recursive: true })
	}
}

describe("F2 cross-check: what the real compilers make of every literal", () => {
	for (const name of Object.keys(LANGUAGES))
		it.skipIf(SKIPPED(name))(
			name,
			() => {
				const language = LANGUAGES[name] as Language
				const r = rng(100)
				const texts = Array.from({ length: runs(200, 3000) }, () => {
					let text = ""
					for (let n = r.int(16); n > 0; n--) text += r.pick(TOKENS)
					return text
				})
				const expected = texts.map((text) => Buffer.from(wellFormed(text), "utf8").toString("hex"))
				/* reached without its toolchain only where that toolchain is required, so it fails */
				const missing = [`${language.tool} is missing where it is required`]
				expect(PRESENT.has(name) ? compiled(language, texts) : missing).toEqual(expected)
			},
			600_000,
		)
})

/** Whether the pinned Java is here: a missing one fails where it is required and skips the Java leg elsewhere (java-env). */
const JAVA = withJava()

/* the Java leg's hostile texts: the escapes javac translates before lexing, a bare `\u`, and the comment closers and tags */
const HOSTILE: readonly string[] = ["\\u000a", "\\u", "\\uZZZZ", "\\\\u", "*/", "{@", "\n@", '"', "\\", "@"]

/** Program.java: each text as a line comment, a Javadoc and a string literal, the literals printed as UTF-8 hex. */
function javaSource(texts: readonly string[]): string {
	return [
		"import java.nio.charset.StandardCharsets;",
		"import java.util.HexFormat;",
		"class Program {",
		...texts.flatMap((text) => javaLineComment(text, "  ")),
		...texts.flatMap((text, i) => [
			"  /**",
			...javaDocLines(text).map((line) => `   * ${line}`),
			"   */",
			`  static final int F${i} = ${i};`,
		]),
		"  public static void main(String[] args) {",
		`    String[] values = { ${texts.map(javaString).join(", ")} };`,
		"    for (String s : values) System.out.println(HexFormat.of().formatHex(s.getBytes(StandardCharsets.UTF_8)));",
		"  }",
		"}",
	].join("\n")
}

/** The hex of each string the pinned javac and java made of the literals of `texts`, one per line of output. */
function compiledJava(texts: readonly string[]): string[] {
	const dir = mkdtempSync(join(javaCacheDir("tmp"), "honey-f2-"))
	try {
		writeFileSync(join(dir, "Program.java"), javaSource(texts))
		const built = runJavac(21, ["-encoding", "UTF-8", "-Xlint:all", "-Werror", "-d", dir, "Program.java"], { cwd: dir })
		if (built.status !== 0) throw new Error(`javac failed: ${built.stdout}${built.stderr}`)
		const ran = runJava(21, ["-cp", dir, "Program"], { cwd: dir })
		if (ran.status !== 0) throw new Error(`java failed: ${ran.stderr}`)
		return ran.stdout.split("\n").slice(0, -1)
	} finally {
		rmSync(dir, { force: true, recursive: true })
	}
}

describe.skipIf(!JAVA)("F2 cross-check: what the pinned javac and java make of every Java literal and comment", () => {
	it("java (JDK 21): each literal, comment and Javadoc of the batch is inert and reads back as its bytes", () => {
		const r = rng(101)
		const texts = Array.from({ length: runs(200, 3000) }, () => {
			let text = ""
			for (let n = r.int(16); n > 0; n--) text += r.pick([...TOKENS, ...HOSTILE])
			return text
		})
		const expected = texts.map((text) => Buffer.from(wellFormed(text), "utf8").toString("hex"))
		expect(compiledJava(texts)).toEqual(expected)
	}, 600_000)
})
