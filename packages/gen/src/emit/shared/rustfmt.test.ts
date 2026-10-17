import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { runRustfmt, rustCacheDir, rustfmtPath, withRust } from "../rust/__fixtures__/rust-env.ts"
import { EMIT_STYLE, formatFiles } from "./format.ts"
import { rustfmtFormatter } from "./rustfmt.ts"

const UNFORMATTED = "fn add(a:i64,b:i64)->i64{a+b}\n"
/* four spaces, whatever EMIT_STYLE says: rustfmt has its own layout and the adapter passes it no options */
const FORMATTED = "fn add(a: i64, b: i64) -> i64 {\n    a + b\n}\n"

/** Whether Rust is here: a missing toolchain fails where it is required and skips these legs elsewhere (rust-env). */
const RUST = withRust()

describe("rustfmtFormatter: the Rust post-pass (R2), under the extension key rs", () => {
	it.skipIf(!RUST)("formats a Rust file with the pinned rustfmt and leaves any other file as it is", async () => {
		const files = await formatFiles(
			{ "Cargo.toml": "[package]\n", "a.go": "package x\n", "a.rs": UNFORMATTED },
			{ rs: rustfmtFormatter(rustfmtPath()) },
		)
		expect(files).toEqual({ "Cargo.toml": "[package]\n", "a.go": "package x\n", "a.rs": FORMATTED })
	})

	it.skipIf(!RUST)("reports a file rustfmt cannot parse as an error, naming it", async () => {
		await expect(formatFiles({ "bad.rs": "fn (\n" }, { rs: rustfmtFormatter(rustfmtPath()) })).rejects.toThrow(
			/could not format bad\.rs: .*unclosed delimiter/,
		)
	})

	it.skipIf(!RUST)("answers a non-zero exit with the source as given and rustfmt's stderr", async () => {
		const source = "fn (\n"
		expect(await rustfmtFormatter(rustfmtPath())("bad.rs", source, EMIT_STYLE)).toEqual({
			code: source,
			errors: [expect.stringMatching(/^error: this file contains an unclosed delimiter/)],
		})
	})

	it("reports a rustfmt it cannot run as an error rather than passing the file through", async () => {
		const { code, errors } = await rustfmtFormatter("/nonexistent/rustfmt")("a.rs", UNFORMATTED, EMIT_STYLE)
		expect({ code, errors: errors.length }).toEqual({ code: UNFORMATTED, errors: 1 })
	})
})

describe("rustfmtFormatter: a rustfmt that stops reading", () => {
	it("answers with its failure when the binary exits before taking the input", async () => {
		const source = `fn main() {}\n// ${"x".repeat(1 << 22)}\n`
		const { code, errors } = await rustfmtFormatter("false")("big.rs", source, EMIT_STYLE)
		expect([code === source, errors.length]).toEqual([true, 1])
	})

	it("answers with its exit status when the binary closes its input and exits later", async () => {
		/* the write fails while the binary still runs: the pipe error is ignored, the exit status answers */
		const dir = mkdtempSync(join(rustCacheDir("tmp"), "rustfmt-closes-"))
		const bin = join(dir, "rustfmt")
		writeFileSync(bin, "#!/bin/sh\nexec 0<&-\nsleep 1\nexit 3\n", { mode: 0o755 })
		try {
			const source = `fn main() {}\n// ${"x".repeat(1 << 22)}\n`
			const { code, errors } = await rustfmtFormatter(bin)("big.rs", source, EMIT_STYLE)
			expect([code === source, errors]).toEqual([true, [`${bin} exited with status 3`]])
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})
})

describe("rustfmtFormatter: no configuration but its own", () => {
	it.skipIf(!RUST)(
		"ignores a rustfmt.toml in the cwd's ancestors: hard_tabs there leaves the output on spaces",
		async () => {
			const root = mkdtempSync(join(rustCacheDir("tmp"), "rustfmt-toml-"))
			const cwd = join(root, "crate", "src")
			mkdirSync(cwd, { recursive: true })
			writeFileSync(join(root, "rustfmt.toml"), "hard_tabs = true\n")
			const back = process.cwd()
			try {
				/* the fixture bites: rustfmt on stdin, given no config path, takes the ancestor's tabs */
				expect(runRustfmt(["--edition", "2024", "--emit", "stdout"], { cwd, input: UNFORMATTED }).stdout).toBe(
					FORMATTED.replace("    ", "\t"),
				)
				/* the adapter takes no cwd: it spawns in the process's own */
				process.chdir(cwd)
				expect(await rustfmtFormatter(rustfmtPath())("a.rs", UNFORMATTED, EMIT_STYLE)).toEqual({
					code: FORMATTED,
					errors: [],
				})
			} finally {
				process.chdir(back)
				rmSync(root, { force: true, recursive: true })
			}
		},
	)
})
