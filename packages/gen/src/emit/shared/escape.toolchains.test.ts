/**
 * The F2 cross-check against the real compilers: a seeded batch of literals (and comments) goes
 * into one program per language, which prints each string's UTF-8 bytes; they must equal the bytes
 * of the text as written. This lifts the fuzz's spec-derived readers to compiler-verified. Runs
 * where the toolchains are; `HONEY_REQUIRE_TOOLCHAINS=1` (the CI harness job) makes a missing one fail.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { goEnv } from "../go/__fixtures__/go-env.ts"
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
	/** the commands that compile and run `path`, printing one hex line per string */
	readonly run: (path: string, dir: string) => readonly (readonly string[])[]
	readonly source: (texts: readonly string[]) => string
	/** the environment its commands run with: Go's is the pinned toolchain's (G10) */
	readonly env?: () => NodeJS.ProcessEnv
	readonly tool: string
	/** the arguments that make the tool print its version: its presence check */
	readonly version: readonly string[]
}

const LANGUAGES: Readonly<Record<string, Language>> = {
	go: {
		file: "main.go",
		run: (path) => [["go", "run", path]],
		source: (texts) =>
			[
				"package main",
				'import ("encoding/hex"; "fmt")',
				...texts.flatMap((text) => lineComment(text, "//")),
				"func main() {",
				`for _, s := range []string{${texts.map(goString).join(", ")}} { fmt.Println(hex.EncodeToString([]byte(s))) }`,
				"}",
			].join("\n"),
		env: () => goEnv(),
		tool: "go",
		version: ["version"],
	},
	python: {
		file: "main.py",
		run: (path) => [["python3", path]],
		source: (texts) =>
			[
				...texts.flatMap((text) => lineComment(text, "#")),
				`for s in [${texts.map(pyString).join(", ")}]:`,
				'    print(s.encode("utf-8").hex())',
			].join("\n"),
		tool: "python3",
		version: ["--version"],
	},
	rust: {
		file: "main.rs",
		run: (path, dir) => [["rustc", "--edition", "2021", "-o", join(dir, "main"), path], [join(dir, "main")]],
		source: (texts) =>
			[
				...texts.flatMap((text) => lineComment(text, "///")),
				"fn main() {",
				`for s in [${texts.map(rustString).join(", ")}] { println!("{}", s.bytes().map(|b| format!("{:02x}", b)).collect::<String>()); }`,
				"}",
			].join("\n"),
		tool: "rustc",
		version: ["--version"],
	},
}

const has = ({ env, tool, version }: Language) =>
	spawnSync(tool, [...version], { env: env?.(), stdio: "ignore" }).status === 0
const required = process.env.HONEY_REQUIRE_TOOLCHAINS === "1"

/** The hex of each string `language`'s compiler made of the literals of `texts`. */
function compiled(language: Language, texts: readonly string[]): string[] {
	const dir = mkdtempSync(join(tmpdir(), "honey-f2-"))
	try {
		const path = join(dir, language.file)
		writeFileSync(path, language.source(texts))
		let stdout = ""
		for (const [command, ...args] of language.run(path, dir)) {
			const result = spawnSync(command as string, args, { encoding: "utf8", env: language.env?.(), maxBuffer: 1 << 26 })
			if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`)
			stdout = result.stdout
		}
		return stdout.trim().split("\n")
	} finally {
		rmSync(dir, { force: true, recursive: true })
	}
}

describe("F2 cross-check: what the real compilers make of every literal", () => {
	it.each(Object.keys(LANGUAGES))(
		"%s",
		(name) => {
			const language = LANGUAGES[name] as Language
			const r = rng(100)
			const texts = Array.from({ length: runs(200, 3000) }, () => {
				let text = ""
				for (let n = r.int(16); n > 0; n--) text += r.pick(TOKENS)
				return text
			})
			const expected = texts.map((text) => Buffer.from(wellFormed(text), "utf8").toString("hex"))
			/* a missing toolchain passes locally and fails where it is required */
			const missing = required ? [`${language.tool} is missing under HONEY_REQUIRE_TOOLCHAINS=1`] : expected
			expect(has(language) ? compiled(language, texts) : missing).toEqual(expected)
		},
		600_000,
	)
})
