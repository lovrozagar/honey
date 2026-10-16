/**
 * The one way gen runs Rust (G10): every `cargo`, `rustc` and `rustfmt` a test, the conformance runner or
 * the harness spawns goes through here, so it runs the toolchain `rust-toolchain.toml` pins — the same
 * channel locally and in CI, which installs it from that file — with its caches under
 * `$HOME/.cache/honey-tmp/rust/` (never /tmp, 00-rules). `RUSTUP_AUTO_INSTALL=0` makes a missing toolchain
 * fail instead of downloading one. A structure test forbids a Rust spawn elsewhere.
 */
import { type SpawnSyncReturns, spawnSync } from "node:child_process"
import { mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/** The pinned Rust channel, as the repo root's `rust-toolchain.toml` holds it (`1.99.1`). */
export function pinnedRust(): string {
	const toml = readFileSync(resolve(import.meta.dirname, "../../../../../../rust-toolchain.toml"), "utf8")
	const channel = /^channel = "([^"]+)"$/m.exec(toml)?.[1]
	if (channel === undefined) throw new Error(`rust-toolchain.toml names no channel:\n${toml}`)
	return channel
}

/**
 * The toolchain the floor legs check under: the x.y.0 of the `rust-version` every emitted crate declares, so a
 * build and `clippy -D clippy::incompatible_msrv` there prove the floor the crate claims. `sdk-cargo.ts` writes
 * that line; the two move together.
 */
export const RUST_FLOOR = "1.85.0"

/** Where gen's Rust caches live: one area under the toolchain cache, made on first use. */
export function rustCacheDir(...parts: string[]): string {
	const dir = join(process.env.HOME ?? homedir(), ".cache/honey-tmp/rust", ...parts)
	mkdirSync(dir, { recursive: true })
	return dir
}

/**
 * The environment every Rust command runs with; `toolchain` overrides the pin (the floor leg), with a target
 * dir of its own. `RUSTUP_TOOLCHAIN` names the pin because a fixture's cwd under the cache is outside the
 * repo, where `rust-toolchain.toml` does not apply; the empty values keep a caller's `RUSTFLAGS` or a
 * compiler wrapper (sccache) out of every build.
 */
export function rustEnv(toolchain = pinnedRust()): NodeJS.ProcessEnv {
	return {
		...process.env,
		CARGO_BUILD_RUSTC_WRAPPER: "",
		CARGO_HOME: rustCacheDir("cargo"),
		CARGO_INCREMENTAL: "0",
		CARGO_PROFILE_DEV_DEBUG: "0",
		/* named, not made: cargo makes it, so a toolchain that is not installed leaves no dir behind */
		CARGO_TARGET_DIR: join(rustCacheDir(), toolchain === pinnedRust() ? "target" : `target-${toolchain}`),
		CARGO_TERM_COLOR: "never",
		RUSTC_WRAPPER: "",
		RUSTFLAGS: "",
		RUSTUP_AUTO_INSTALL: "0",
		RUSTUP_TOOLCHAIN: toolchain,
		TMPDIR: rustCacheDir("tmp"),
	}
}

/** How a Rust command runs: in `cwd`, with `input` on stdin, under the pin or `toolchain`. */
type RunOptions = { readonly cwd?: string; readonly input?: string; readonly toolchain?: string }

/** `command args` under `rustEnv`. */
function run(command: string, args: readonly string[], options: RunOptions): SpawnSyncReturns<string> {
	return spawnSync(command, [...args], {
		cwd: options.cwd,
		encoding: "utf8",
		env: rustEnv(options.toolchain),
		input: options.input,
		maxBuffer: 1 << 26,
	})
}

/** `cargo args` under the pinned toolchain (or `toolchain`). */
export function runCargo(args: readonly string[], options: RunOptions = {}): SpawnSyncReturns<string> {
	return run("cargo", args, options)
}

/** `rustc args` under the pinned toolchain (or `toolchain`). */
export function runRustc(args: readonly string[], options: RunOptions = {}): SpawnSyncReturns<string> {
	return run("rustc", args, options)
}

/**
 * The toolchain's own rustfmt binary, found by its sysroot: the formatter adapter spawns this path, never
 * the rustup proxy, so it runs that toolchain's rustfmt whatever the cwd.
 */
export function rustfmtPath(toolchain?: string): string {
	const sysroot = runRustc(["--print", "sysroot"], { toolchain })
	if (sysroot.status !== 0) throw new Error(`rustc --print sysroot failed: ${sysroot.stderr}`)
	return join(sysroot.stdout.trim(), "bin", "rustfmt")
}

/** The pinned toolchain's rustfmt (or `toolchain`'s) on `args`. */
export function runRustfmt(args: readonly string[], options: RunOptions = {}): SpawnSyncReturns<string> {
	return run(rustfmtPath(options.toolchain), args, options)
}

/** Whether `toolchain` (the pin by default) is installed: rustup never fetches one here. */
export function hasRust(toolchain = pinnedRust()): boolean {
	return runRustc(["--version"], { toolchain }).status === 0
}

/** Whether a missing Rust must fail rather than skip: CI and the pre-push battery set one of these. */
export function rustRequired(): boolean {
	return process.env.HONEY_REQUIRE_TOOLCHAINS === "1" || process.env.HONEY_REQUIRE_RUST === "1"
}

/**
 * Whether a test runs its Rust half: false only where Rust may be absent. A missing toolchain fails the test
 * where it is required (CI, the pre-push battery), naming the install, and skips the Rust half anywhere else.
 * Callers gate with `describe.skipIf` or `it.skipIf`, never an early return.
 */
export function withRust(toolchain = pinnedRust()): boolean {
	const rust = hasRust(toolchain)
	if (!rust && rustRequired())
		throw new Error(
			`Rust ${toolchain} is required here (HONEY_REQUIRE_RUST or HONEY_REQUIRE_TOOLCHAINS) and is not installed: rustup toolchain install ${toolchain} --profile minimal --component rustfmt --component clippy`,
		)
	return rust
}
