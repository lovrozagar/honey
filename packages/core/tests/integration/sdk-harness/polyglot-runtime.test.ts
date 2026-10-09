/* Behavior checks for the Go, Python and Rust SDK runtimes (tests/integration/sdk-runtime-checks/): auth refresh
 * resends replayable bodies, keeps the token and refreshes once; streams are not retried;
 * timeouts bound calls but not streams; no cross-host redirects; path params validated and
 * the base path kept; one header per name; error messages capped and cleaned; 3xx raises;
 * invalidation keeps unresolved templates as patterns; realtime gives up after bounded
 * attempts, survives a canceled connect ctx, closes cleanly under -race (Go), reconnects on a
 * clean stream end and propagates cancellation (Python), and stays usable after a dropped
 * recv (Rust); send errors keep their cause (Rust). */

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

const check = (name: string) => fileURLToPath(new URL(`../sdk-runtime-checks/${name}`, import.meta.url))

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
	return { err: r.stderr ?? "", ok: r.status === 0, out: r.stdout ?? "" }
}

function expectAllTrue(stdout: string): void {
	const results = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as Record<string, boolean>
	expect(Object.keys(results).length).toBeGreaterThan(5)
	for (const [name, ok] of Object.entries(results)) expect(ok, name).toBe(true)
}

describe("SDK runtime behavior", () => {
	it.skipIf(!has("go", ["version"]))(
		"Go (go test -race)",
		(ctx) => {
			const dir = mkdtempSync(join(tmpdir(), "honey-rt-go-"))
			try {
				writeTree(dir, generateGoSDK(loadMockSpec(), { modulePath: "example.com/mock-sdk" }).files)
				copyFileSync(check("runtime_test.go"), join(dir, "zz_runtime_test.go"))
				const tidy = run("go", ["mod", "tidy"], dir)
				if (!tidy.ok && /dial tcp|no such host|proxy\.golang\.org/.test(tidy.err)) ctx.skip()
				expect(tidy.ok, tidy.err).toBe(true)
				const test = run("go", ["test", "-race", "-count=1", "./..."], dir)
				expect(test.ok, `${test.out}\n${test.err}`).toBe(true)
			} finally {
				rmSync(dir, { force: true, recursive: true })
			}
		},
		600_000,
	)

	it.skipIf(!has("python3", ["-c", "import httpx"]))(
		"Python",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "honey-rt-py-"))
			try {
				writeTree(join(dir, "sdk"), generatePythonSDK(loadMockSpec()).files)
				copyFileSync(check("runtime_check.py"), join(dir, "runtime_check.py"))
				const r = run("python3", ["runtime_check.py"], dir)
				expect(r.ok, r.err).toBe(true)
				expectAllTrue(r.out)
			} finally {
				rmSync(dir, { force: true, recursive: true })
			}
		},
		600_000,
	)

	it.skipIf(!has("cargo", ["--version"]))(
		"Rust",
		(ctx) => {
			const dir = mkdtempSync(join(tmpdir(), "honey-rt-rust-"))
			try {
				writeTree(join(dir, "mock-sdk"), generateRustSDK(loadMockSpec(), { crateName: "mock-sdk" }).files)
				writeTree(join(dir, "runner"), {
					"Cargo.toml":
						'[package]\nname = "runner"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nmock-sdk = { path = "../mock-sdk" }\ntokio = { version = "1", features = ["full"] }\nasync-trait = "0.1"\nserde_json = "1"\n',
				})
				mkdirSync(join(dir, "runner", "src"), { recursive: true })
				copyFileSync(check("runtime_check.rs"), join(dir, "runner", "src", "main.rs"))
				const r = run("cargo", ["run", "--quiet"], join(dir, "runner"), { ...process.env, CARGO_TARGET_DIR })
				if (!r.ok && /failed to download|Could not resolve/.test(r.err) && !/error\[E\d+\]/.test(r.err)) ctx.skip()
				expect(r.ok, r.err).toBe(true)
				expectAllTrue(r.out)
			} finally {
				rmSync(dir, { force: true, recursive: true })
			}
		},
		600_000,
	)
})
