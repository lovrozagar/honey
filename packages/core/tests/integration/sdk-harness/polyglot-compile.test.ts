/* Compiles the Go, Rust, Python and Go CLI SDKs generated from the adversarial fixture corpus.
 *
 * The corpus (keywords, prelude/runtime type names, hyphenated and leading-digit keys, colliding
 * names, quotes, backslashes, comment terminators, multi-line text, recursive and union schemas,
 * streaming POST, multipart, urlencoded, text and binary bodies) is what the emitters' naming and
 * literal layer exists for. Each language is compiled with its real toolchain, in both throw and
 * safe modes. A missing toolchain or an unreachable module/crate registry skips the language.
 */

import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { generateGoCLI } from "../../../src/codegen-go-cli.ts"
import { generateGoSDK } from "../../../src/codegen-go.ts"
import { generatePythonSDK } from "../../../src/codegen-python.ts"
import { generateRustSDK } from "../../../src/codegen-rust.ts"
import { CARGO_TARGET_DIR } from "../../cargo-env.ts"
import { adversarialSpec } from "../../unit/codegen/__fixtures__/adversarial-spec.ts"
import { PYTHON } from "../../python-env.ts"

const spec = adversarialSpec as unknown as Record<string, unknown>

function has(cmd: string, args: string[]): boolean {
	return spawnSync(cmd, args, { stdio: "ignore" }).status === 0
}

const hasGo = has("go", ["version"])
const hasCargo = has("cargo", ["--version"])
const hasPython = has(PYTHON, ["--version"])
const hasMypy = hasPython && has(PYTHON, ["-m", "mypy", "--version"])
const hasHttpx = hasPython && has(PYTHON, ["-c", "import httpx"])

function writeTree(root: string, files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) {
		const p = join(root, rel)
		mkdirSync(dirname(p), { recursive: true })
		writeFileSync(p, content, "utf8")
	}
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
	const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env, timeout: 600_000 })
	return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}

/** Dependency download failures are environmental: skip instead of failing. */
const OFFLINE =
	/dial tcp|no such host|Could not resolve|failed to download|network|timed out|proxy\.golang\.org|failed to get/i

describe.skipIf(!hasGo)("adversarial corpus — Go", () => {
	for (const throwOnError of [true, false]) {
		it(`SDK passes go vet (throwOnError=${throwOnError})`, (ctx) => {
			const dir = mkdtempSync(join(tmpdir(), "honey-adv-go-"))
			try {
				writeTree(dir, generateGoSDK(spec, { modulePath: "example.com/advsdk", throwOnError }).files)
				const tidy = run("go", ["mod", "tidy"], dir)
				if (!tidy.ok && OFFLINE.test(tidy.out)) ctx.skip()
				expect(tidy.ok, tidy.out).toBe(true)
				const vet = run("go", ["vet", "./..."], dir)
				expect(vet.ok, vet.out).toBe(true)
			} finally {
				rmSync(dir, { force: true, recursive: true })
			}
		}, 600_000)
	}

	it("CLI builds and maps errors to exit codes", (ctx) => {
		const dir = mkdtempSync(join(tmpdir(), "honey-adv-cli-"))
		try {
			writeTree(dir, generateGoCLI(spec, { binaryName: "adv", modulePath: "example.com/advcli" }).files)
			const tidy = run("go", ["mod", "tidy"], dir)
			if (!tidy.ok && OFFLINE.test(tidy.out)) ctx.skip()
			expect(tidy.ok, tidy.out).toBe(true)
			const vet = run("go", ["vet", "./..."], dir)
			expect(vet.ok, vet.out).toBe(true)
			const build = run("go", ["build", "-o", "adv", "."], dir)
			expect(build.ok, build.out).toBe(true)
			/* a resource named `root` must not replace cmd/root.go */
			const help = run(join(dir, "adv"), ["root", "list", "--help"], dir)
			expect(help.ok, help.out).toBe(true)
			/* unknown flag → usage error, exit 4 */
			const bad = spawnSync(join(dir, "adv"), ["queue", "list", "--nope"], { encoding: "utf8" })
			expect(bad.status).toBe(4)
			/* connection refused → network failure, exit 3 */
			const refused = spawnSync(
				join(dir, "adv"),
				["--base-url", "http://127.0.0.1:1", "--api-key", "k", "pets", "list"],
				{
					encoding: "utf8",
				},
			)
			expect(refused.status).toBe(3)
			/* a query param named like a global flag gets its own flag name */
			const flags = run(join(dir, "adv"), ["queue", "list", "--help"], dir)
			expect(flags.out).toContain("--query-timeout")
			expect(flags.out).toContain("--query-output")
			expect(flags.out).toContain("--query-config")
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 600_000)
})

describe.skipIf(!hasCargo)("adversarial corpus — Rust", () => {
	for (const throwOnError of [true, false]) {
		it(`SDK passes cargo check (throwOnError=${throwOnError})`, (ctx) => {
			const dir = mkdtempSync(join(tmpdir(), "honey-adv-rust-"))
			try {
				writeTree(dir, generateRustSDK(spec, { crateName: "adv-sdk", throwOnError }).files)
				const check = run("cargo", ["check", "--quiet"], dir, { ...process.env, CARGO_TARGET_DIR })
				if (!check.ok && OFFLINE.test(check.out) && !/error\[E\d+\]|error: expected/.test(check.out)) ctx.skip()
				expect(check.ok, check.out).toBe(true)
			} finally {
				rmSync(dir, { force: true, recursive: true })
			}
		}, 600_000)
	}
})

describe.skipIf(!hasPython)("adversarial corpus — Python", () => {
	for (const throwOnError of [true, false]) {
		it(`SDK byte-compiles, imports and type-checks (throwOnError=${throwOnError})`, () => {
			const dir = mkdtempSync(join(tmpdir(), "honey-adv-py-"))
			try {
				writeTree(join(dir, "advsdk"), generatePythonSDK(spec, { throwOnError }).files)
				/* compileall catches what ast.parse misses (duplicate arguments) */
				const compiled = run(PYTHON, ["-m", "compileall", "-q", "advsdk"], dir)
				expect(compiled.ok, compiled.out).toBe(true)
				if (hasHttpx) {
					const imported = run(PYTHON, ["-c", "import advsdk"], dir)
					expect(imported.ok, imported.out).toBe(true)
				}
				if (hasMypy && hasHttpx) {
					const typed = run(PYTHON, ["-m", "mypy", "--python-version", "3.11", "--no-error-summary", "advsdk"], dir)
					expect(typed.ok, typed.out).toBe(true)
				}
			} finally {
				rmSync(dir, { force: true, recursive: true })
			}
		}, 600_000)
	}
})
