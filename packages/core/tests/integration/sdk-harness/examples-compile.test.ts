/* The Go, Rust and Python examples in examples/ (the source of docs/sdk.md's snippets) compile
 * against the SDKs generated from the mock-server spec, so the documented API cannot drift
 * from the generated one. A missing toolchain or registry skips the language. */

import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { generateGoSDK } from "../../../src/codegen-go.ts"
import { generatePythonSDK } from "../../../src/codegen-python.ts"
import { generateRustSDK } from "../../../src/codegen-rust.ts"
import { CARGO_TARGET_DIR } from "../../cargo-env.ts"
import { loadMockSpec } from "./harness-util.ts"

const example = (rel: string) => fileURLToPath(new URL(`../../../examples/${rel}`, import.meta.url))

function has(cmd: string, args: string[]): boolean {
	return spawnSync(cmd, args, { stdio: "ignore" }).status === 0
}

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

const OFFLINE = /dial tcp|no such host|Could not resolve|failed to download|proxy\.golang\.org/i

describe("examples compile against the generated SDKs", () => {
	it.skipIf(!has("go", ["version"]))(
		"examples/go/example.go",
		(ctx) => {
			const dir = mkdtempSync(join(tmpdir(), "honey-ex-go-"))
			try {
				writeTree(join(dir, "sdk"), generateGoSDK(loadMockSpec(), { modulePath: "example.com/mock-sdk" }).files)
				writeFileSync(
					join(dir, "go.mod"),
					"module example.com/ex\n\ngo 1.23\n\nrequire example.com/mock-sdk v0.0.0\n\nreplace example.com/mock-sdk => ./sdk\n",
				)
				copyFileSync(example("go/example.go"), join(dir, "main.go"))
				const tidy = run("go", ["mod", "tidy"], dir)
				if (!tidy.ok && OFFLINE.test(tidy.out)) ctx.skip()
				expect(tidy.ok, tidy.out).toBe(true)
				const vet = run("go", ["vet", "."], dir)
				expect(vet.ok, vet.out).toBe(true)
			} finally {
				rmSync(dir, { force: true, recursive: true })
			}
		},
		600_000,
	)

	it.skipIf(!has("cargo", ["--version"]))(
		"examples/rust/example.rs",
		(ctx) => {
			const dir = mkdtempSync(join(tmpdir(), "honey-ex-rust-"))
			try {
				writeTree(join(dir, "mock-sdk"), generateRustSDK(loadMockSpec(), { crateName: "mock-sdk" }).files)
				writeTree(join(dir, "runner"), {
					"Cargo.toml":
						'[package]\nname = "runner"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nmock-sdk = { path = "../mock-sdk" }\ntokio = { version = "1", features = ["full"] }\ntokio-util = { version = "0.7", features = ["rt"] }\nfutures-util = "0.3"\nbytes = "1"\nasync-trait = "0.1"\nserde_json = "1"\nsha2 = "0.10"\n',
				})
				mkdirSync(join(dir, "runner", "src"), { recursive: true })
				copyFileSync(example("rust/example.rs"), join(dir, "runner", "src", "main.rs"))
				const check = run("cargo", ["check", "--quiet"], join(dir, "runner"), { ...process.env, CARGO_TARGET_DIR })
				if (!check.ok && /failed to download|Could not resolve/.test(check.out) && !/error\[E\d+\]/.test(check.out)) {
					ctx.skip()
				}
				expect(check.ok, check.out).toBe(true)
			} finally {
				rmSync(dir, { force: true, recursive: true })
			}
		},
		600_000,
	)

	const hasMypy = has("python3", ["-m", "mypy", "--version"]) && has("python3", ["-c", "import httpx"])
	it.skipIf(!hasMypy)(
		"examples/python/example.py",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "honey-ex-py-"))
			try {
				writeTree(join(dir, "sdk"), generatePythonSDK(loadMockSpec()).files)
				copyFileSync(example("python/example.py"), join(dir, "example.py"))
				const typed = run(
					"python3",
					["-m", "mypy", "--python-version", "3.11", "--no-error-summary", "example.py"],
					dir,
				)
				expect(typed.ok, typed.out).toBe(true)
			} finally {
				rmSync(dir, { force: true, recursive: true })
			}
		},
		600_000,
	)
})
