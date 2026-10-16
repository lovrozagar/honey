/**
 * The verify helpers against the real toolchains: TS, Go, Rust (the hmac, sha2, subtle, hex and
 * base64 crates, which cargo fetches) and Python each compile their helper and check RFC 4231's
 * HMAC-SHA256 test case 2, hex and base64, behind a prefix, and refuse a tampered, short,
 * unprefixed, oddly encoded or undecodable signature. Runs where the toolchains are;
 * `HONEY_REQUIRE_TOOLCHAINS=1` (CI's test and harness jobs) makes a missing one fail. C# and Java are
 * checked structurally until their SDKs (bits 15 and 16).
 */
import { type SpawnSyncReturns, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { goCacheDir, goRequired, hasGo, runGo } from "../go/__fixtures__/go-env.ts"
import { hasRust, runCargo, rustCacheDir, rustRequired } from "../rust/__fixtures__/rust-env.ts"
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
	/** compile and run the program in `dir`, which prints one true or false per case */
	readonly exec: (dir: string) => SpawnSyncReturns<string>
	/** where its work dirs go: Go's and Rust's toolchain caches, off /tmp (00-rules); Node's and Python's one source file stays in the OS temp dir */
	readonly home: () => string
	/** whether its toolchain is here: Go's and Rust's are the pinned ones (G10) */
	readonly present: () => boolean
	/** whether a missing toolchain fails rather than skips */
	readonly required: () => boolean
	readonly tool: string
	/** write the program into `dir` */
	readonly write: (dir: string) => void
}

/** `command args` in `dir`, its output as text. */
const spawn = (command: string, args: readonly string[], dir?: string) =>
	spawnSync(command, [...args], { cwd: dir, encoding: "utf8" })

/** Whether `command --version` runs. */
const runs = (command: string) => spawn(command, ["--version"]).status === 0

/** Whether a missing toolchain without a fixture of its own fails rather than skips. */
const toolchainsRequired = () => process.env.HONEY_REQUIRE_TOOLCHAINS === "1"

/* the crates the Rust helper uses, which cargo resolves and fetches once per manifest (Fb10) */
const CARGO_TOML =
	'[package]\nname = "verify"\nversion = "0.0.0"\nedition = "2024"\n\n[dependencies]\nbase64 = "0.22"\nhex = "0.4"\nhmac = "0.12"\nsha2 = "0.10"\nsubtle = "2"\n'

/**
 * Gives the crate in `dir` its lock: resolved and its crates fetched on the first run for this manifest, kept
 * beside the registry under a name keyed by the manifest's hash, and copied in on every later run, so the
 * build runs `--locked --offline`.
 */
function lock(dir: string): void {
	const kept = join(
		rustCacheDir("cargo", `.webhooks-${createHash("sha256").update(CARGO_TOML).digest("hex").slice(0, 12)}`),
		"Cargo.lock",
	)
	if (!existsSync(kept)) {
		for (const args of [["generate-lockfile"], ["fetch", "--locked"]]) {
			const result = runCargo([...args, "--manifest-path", join(dir, "Cargo.toml")], { cwd: dir })
			if (result.status !== 0) throw new Error(`cargo ${args[0]} failed: ${result.stderr}`)
		}
		/* fetched first and renamed into place, so a lock that is there names crates that are there */
		copyFileSync(join(dir, "Cargo.lock"), `${kept}.${process.pid}`)
		renameSync(`${kept}.${process.pid}`, kept)
	}
	copyFileSync(kept, join(dir, "Cargo.lock"))
}

const LANGUAGES: Readonly<Record<string, Language>> = {
	go: {
		exec: (dir) => runGo(["run", join(dir, "main.go")], { cwd: dir }),
		home: () => goCacheDir("tmp"),
		present: hasGo,
		required: goRequired,
		tool: "go",
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
		exec: (dir) => spawn("python3", [join(dir, "main.py")], dir),
		home: tmpdir,
		present: () => runs("python3"),
		required: toolchainsRequired,
		tool: "python3",
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
		exec: (dir) => {
			lock(dir)
			return runCargo(["run", "--quiet", "--locked", "--offline", "--manifest-path", join(dir, "Cargo.toml")], {
				cwd: dir,
			})
		},
		home: () => rustCacheDir("tmp"),
		present: () => hasRust(),
		required: rustRequired,
		tool: "cargo",
		write: (dir) => {
			mkdirSync(join(dir, "src"))
			writeFileSync(join(dir, "Cargo.toml"), CARGO_TOML)
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
		exec: (dir) => spawn("node", [join(dir, "main.ts")], dir),
		home: tmpdir,
		present: () => runs("node"),
		required: toolchainsRequired,
		tool: "node",
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

/** The languages whose toolchain is here, checked once: a missing one is skipped, or fails where it is required. */
const PRESENT = new Set(Object.keys(LANGUAGES).filter((name) => (LANGUAGES[name] as Language).present()))
const SKIPPED = (name: string) => !PRESENT.has(name) && !(LANGUAGES[name] as Language).required()

/** What `language`'s program prints for the cases. */
function verified(language: Language): string {
	const dir = mkdtempSync(join(language.home(), "honey-webhooks-"))
	try {
		language.write(dir)
		const result = language.exec(dir)
		if (result.status !== 0) throw new Error(`${language.tool} failed: ${result.stderr}`)
		return result.stdout.trim()
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
