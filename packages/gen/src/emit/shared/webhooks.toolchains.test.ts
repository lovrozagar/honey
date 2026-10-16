/**
 * The verify helpers against the real toolchains: TS, Go, Rust (the hmac, sha2, subtle, hex and
 * base64 crates, which cargo fetches) and Python each compile their helper and check RFC 4231's
 * HMAC-SHA256 test case 2, hex and base64, behind a prefix, and refuse a tampered, short,
 * unprefixed, oddly encoded or undecodable signature. Runs where the toolchains are;
 * `HONEY_REQUIRE_TOOLCHAINS=1` (the CI harness job) makes a missing one fail. C# and Java are
 * checked structurally until their SDKs (bits 15 and 16).
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { goEnv, goRequired } from "../go/__fixtures__/go-env.ts"
import { verifyHelper } from "./webhooks.ts"

const SECRET = "Jefe"
const PAYLOAD = "what do ya want for nothing?"
const HEX = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
const BASE64 = "W9zBRr9gdU5qBCQmCJV1x1oAPwidJzmDnexYuWTsOEM="

/** Each case: the header value, its encoding and prefix, and whether it verifies. */
const CASES: readonly (readonly [received: string, encoding: string, prefix: string, valid: boolean])[] = [
	[HEX, "hex", "", true],
	[`sha256=${BASE64}`, "base64", "sha256=", true],
	[`${HEX.slice(0, -1)}2`, "hex", "", false],
	[HEX.slice(0, -2), "hex", "", false],
	[HEX, "hex", "sha256=", false],
	[HEX, "utf8", "", false],
	[`${HEX.slice(0, -2)}zz`, "hex", "", false],
]

const EXPECTED = CASES.map(([, , , valid]) => String(valid)).join("\n")

/** The cases as `[received, encoding, prefix]` string triples in a language's array syntax. */
const triples = (open: string, close: string) =>
	CASES.map(
		([received, encoding, prefix]) =>
			`${open}${JSON.stringify(received)}, ${JSON.stringify(encoding)}, ${JSON.stringify(prefix)}${close}`,
	).join(", ")

type Language = {
	/** the environment its commands run with: Go's is the pinned toolchain's (G10) */
	readonly env?: () => NodeJS.ProcessEnv
	/** the commands that compile and run the program in `dir`, printing one true or false per case */
	readonly run: (dir: string) => readonly (readonly string[])[]
	/** write the program into `dir` */
	readonly write: (dir: string) => void
	readonly tool: string
	readonly version: readonly string[]
}

const LANGUAGES: Readonly<Record<string, Language>> = {
	go: {
		run: (dir) => [["go", "run", join(dir, "main.go")]],
		env: () => goEnv(),
		tool: "go",
		version: ["version"],
		write: (dir) =>
			writeFileSync(
				join(dir, "main.go"),
				[
					"package main",
					'import "fmt"',
					verifyHelper("go").replace(/^package \w+\n/, ""),
					"func main() {",
					`	for _, c := range [][3]string{${triples("{", "}")}} {`,
					`		fmt.Println(VerifyWebhookSignature([]byte(${JSON.stringify(SECRET)}), []byte(${JSON.stringify(PAYLOAD)}), c[0], c[1], c[2]))`,
					"	}",
					"}",
				].join("\n"),
			),
	},
	python: {
		run: (dir) => [["python3", join(dir, "main.py")]],
		tool: "python3",
		version: ["--version"],
		write: (dir) =>
			writeFileSync(
				join(dir, "main.py"),
				[
					verifyHelper("python"),
					`for c in [${triples("(", ")")}]:`,
					`    print(str(verify_webhook_signature(${JSON.stringify(SECRET)}.encode(), ${JSON.stringify(PAYLOAD)}.encode(), *c)).lower())`,
				].join("\n"),
			),
	},
	rust: {
		run: (dir) => [["cargo", "run", "--quiet", "--manifest-path", join(dir, "Cargo.toml")]],
		tool: "cargo",
		version: ["--version"],
		write: (dir) => {
			mkdirSync(join(dir, "src"))
			writeFileSync(
				join(dir, "Cargo.toml"),
				'[package]\nname = "verify"\nversion = "0.0.0"\nedition = "2021"\n\n[dependencies]\nbase64 = "0.22"\nhex = "0.4"\nhmac = "0.12"\nsha2 = "0.10"\nsubtle = "2"\n',
			)
			writeFileSync(
				join(dir, "src/main.rs"),
				[
					verifyHelper("rust"),
					"fn main() {",
					`    for c in [${triples("(", ")")}] {`,
					`        println!("{}", verify_webhook_signature(${JSON.stringify(SECRET)}.as_bytes(), ${JSON.stringify(PAYLOAD)}.as_bytes(), c.0, c.1, c.2));`,
					"    }",
					"}",
				].join("\n"),
			)
		},
	},
	ts: {
		run: (dir) => [["node", join(dir, "main.ts")]],
		tool: "node",
		version: ["--version"],
		write: (dir) =>
			writeFileSync(
				join(dir, "main.ts"),
				[
					verifyHelper("ts"),
					`for (const c of [${triples("[", "]")}] as const) {`,
					`	console.log(String(verifyWebhookSignature(${JSON.stringify(SECRET)}, ${JSON.stringify(PAYLOAD)}, c[0], c[1], c[2])))`,
					"}",
				].join("\n"),
			),
	},
}

const has = ({ env, tool, version }: Language) =>
	spawnSync(tool, [...version], { env: env?.(), stdio: "ignore" }).status === 0
/** Whether a missing `language` fails rather than skips: Go's by go-env's rule, the rest under HONEY_REQUIRE_TOOLCHAINS. */
const required = ({ tool }: Language) => (tool === "go" ? goRequired() : process.env.HONEY_REQUIRE_TOOLCHAINS === "1")
/** The languages whose toolchain is here, checked once: a missing one is skipped, or fails where it is required. */
const PRESENT = new Set(Object.keys(LANGUAGES).filter((name) => has(LANGUAGES[name] as Language)))
const SKIPPED = (name: string) => !PRESENT.has(name) && !required(LANGUAGES[name] as Language)

/** What `language`'s program prints for the cases. */
function verified(language: Language): string {
	const dir = mkdtempSync(join(tmpdir(), "honey-webhooks-"))
	try {
		language.write(dir)
		let stdout = ""
		for (const [command, ...args] of language.run(dir)) {
			const result = spawnSync(command as string, args, { cwd: dir, encoding: "utf8", env: language.env?.() })
			if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`)
			stdout = result.stdout
		}
		return stdout.trim()
	} finally {
		rmSync(dir, { force: true, recursive: true })
	}
}

describe("verify helpers: what the real toolchains make of them", () => {
	for (const name of Object.keys(LANGUAGES))
		it.skipIf(SKIPPED(name))(
			`${name} verifies RFC 4231 case 2 in hex and base64 behind a prefix, and refuses every altered signature`,
			() => {
				const language = LANGUAGES[name] as Language
				/* reached without its toolchain only where that toolchain is required, so it fails */
				const missing = `${language.tool} is missing where it is required`
				expect(PRESENT.has(name) ? verified(language) : missing).toBe(EXPECTED)
			},
			600_000,
		)
})
