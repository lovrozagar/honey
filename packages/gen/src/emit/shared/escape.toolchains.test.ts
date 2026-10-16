/**
 * The F2 cross-check against the real compilers: a seeded batch of literals (and comments) goes
 * into one program per language, which prints each string's UTF-8 bytes; they must equal the bytes
 * of the text as written. This lifts the fuzz's spec-derived readers to compiler-verified. Runs
 * where the toolchains are; `HONEY_REQUIRE_TOOLCHAINS=1` (CI's test and harness jobs) makes a missing one fail.
 */
import { type SpawnSyncReturns, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { goCacheDir, goRequired, hasGo, runGo } from "../go/__fixtures__/go-env.ts"
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
import { goString, lineComment, pyString, rustString, wellFormed } from "./escape.ts"

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

const LANGUAGES: Readonly<Record<string, Language>> = {
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
