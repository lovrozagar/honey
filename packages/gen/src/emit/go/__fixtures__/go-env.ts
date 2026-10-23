/**
 * The one way gen runs Go (G10): every `go` and `gofmt` a test, the conformance runner or the
 * harness spawns goes through here, so it runs the toolchain `.go-version` pins — the same binary
 * locally and in CI (`GOTOOLCHAIN`, Go's checksum-verified download) — with its caches under
 * `$HOME/.cache/honey-tmp/go/` (never /tmp, 00-rules). A structure test forbids a Go spawn elsewhere.
 */
import { type SpawnSyncReturns, spawnSync } from "node:child_process"
import { mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/** The pinned Go version, as `.go-version` at the repo root holds it (`1.27.2`). */
export function pinnedGo(): string {
	return readFileSync(resolve(import.meta.dirname, "../../../../../../.go-version"), "utf8").trim()
}

/**
 * The toolchain the floor legs compile under: the oldest Go the emitted `go 1.24` line admits, so
 * a build and vet there prove the floor the module declares. `sdk.ts` writes that line; the two
 * move together.
 */
export const GO_FLOOR = "1.24.0"

/** Where gen's Go caches live: one area under the toolchain cache, made on first use. */
export function goCacheDir(...parts: string[]): string {
	const dir = join(process.env.HOME ?? homedir(), ".cache/honey-tmp/go", ...parts)
	mkdirSync(dir, { recursive: true })
	return dir
}

/** The environment every Go command runs with; `toolchain` overrides the pin (the go 1.24 floor leg). */
export function goEnv(toolchain = pinnedGo()): NodeJS.ProcessEnv {
	return {
		...process.env,
		GOCACHE: goCacheDir("cache"),
		/* -modcacherw keeps the module cache deletable; -mod=readonly never rewrites emitted files */
		GOFLAGS: "-mod=readonly -modcacherw",
		GOMODCACHE: goCacheDir("mod"),
		GOPATH: goCacheDir("path"),
		GOTOOLCHAIN: `go${toolchain}`,
		TMPDIR: goCacheDir("tmp"),
	}
}

/** `go args` in `cwd` under the pinned toolchain (or `toolchain`), with `env` over the toolchain's environment. */
export function runGo(
	args: readonly string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; toolchain?: string } = {},
) {
	return spawnSync("go", [...args], {
		cwd: options.cwd,
		encoding: "utf8",
		env: { ...goEnv(options.toolchain), ...options.env },
		input: options.input,
		maxBuffer: 1 << 26,
	}) as SpawnSyncReturns<string>
}

/** The pinned toolchain's own gofmt: `GOTOOLCHAIN` does not dispatch gofmt, so it is found by GOROOT. */
export function gofmtPath(toolchain?: string): string {
	const goroot = runGo(["env", "GOROOT"], { toolchain })
	if (goroot.status !== 0) throw new Error(`go env GOROOT failed: ${goroot.stderr}`)
	return join(goroot.stdout.trim(), "bin", "gofmt")
}

/** Whether a Go is on PATH to fetch the pinned toolchain with. */
export function hasGo(): boolean {
	return spawnSync("go", ["version"], { env: goEnv(), stdio: "ignore" }).status === 0
}

/** Whether a missing Go must fail rather than skip: CI and the pre-push battery set one of these. */
export function goRequired(): boolean {
	return process.env.HONEY_REQUIRE_TOOLCHAINS === "1" || process.env.HONEY_REQUIRE_GO === "1"
}

/**
 * Whether a test runs its Go half: false only where Go may be absent. A missing Go fails the test
 * where it is required (CI, the pre-push battery) and skips the Go half anywhere else.
 */
export function withGo(): boolean {
	const go = hasGo()
	if (!go && goRequired())
		throw new Error("Go is required here (HONEY_REQUIRE_GO or HONEY_REQUIRE_TOOLCHAINS), and none is on PATH")
	return go
}
