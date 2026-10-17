/**
 * The one way gen runs .NET (G10, G11, R7): every dotnet, MSBuild, csc and `dotnet format` a test, the driver or
 * the harness spawns goes through here. It runs only the SDK the repo root's `global.json` pins (exact,
 * `rollForward: disable`), extracted from Microsoft's tarball into `$HOME/.cache/honey-tmp/dotnet/toolchain/<pin>`
 * by `dotnetInstall` after a check against the committed `dotnet-sdk.sha512`: never `/usr/bin/dotnet`, `~/.dotnet`
 * or a `dotnet` on PATH. The CLI home, the NuGet caches and TMPDIR live under that dir too. HOME stays the
 * caller's: DOTNET_CLI_HOME takes the CLI's state and NuGet's user config (P2). Every build runs lean, with no
 * MSBuild node reuse, no MSBuild server and no compiler server, so a run leaves no process behind (P2-C).
 * Downloads are manual: a missing SDK fails where .NET is required, naming its install, and is never fetched by a
 * run. A structure test forbids a .NET spawn elsewhere.
 */
import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/** The pin file, at the repo root. */
const globalJson = () => resolve(import.meta.dirname, "../../../../../../global.json")

/* this dir, repo-relative, as the install line names it from the repo's top level */
const FIXTURES = "packages/gen/src/emit/csharp/__fixtures__"

/* the cache root as the install line spells it, for a shell to expand */
const SHELL_ROOT = "$HOME/.cache/honey-tmp/dotnet"

/**
 * The pinned SDK, as `global.json` holds it (`10.0.402`): an exact version that rolls forward to no other, so a
 * machine with another SDK refuses to build rather than build with it.
 */
export function pinnedDotnet(): string {
	const text = readFileSync(globalJson(), "utf8")
	const sdk = (JSON.parse(text) as { sdk?: { rollForward?: unknown; version?: unknown } }).sdk
	if (typeof sdk?.version !== "string" || !/^\d+\.\d+\.\d+$/.test(sdk.version) || sdk.rollForward !== "disable")
		throw new Error(`global.json pins no exact SDK with rollForward "disable":\n${text}`)
	return sdk.version
}

/** The one runtime identifier the install names: CI's ubuntu-latest and every contributor machine so far. */
export const DOTNET_RID = "linux-x64"

/** The target framework the pinned SDK's major names (R1: one target, `net10.0`). */
const tfm = () => `net${pinnedDotnet().split(".")[0]}.0`

/** Where gen's .NET lives: one area under the toolchain cache, made on first use. */
export function csharpCacheDir(...parts: string[]): string {
	const dir = join(process.env.HOME ?? homedir(), ".cache/honey-tmp/dotnet", ...parts)
	mkdirSync(dir, { recursive: true })
	return dir
}

/** The pinned SDK's install: the extracted tarball, its `dotnet` muxer at the top. */
export const dotnetRoot = (): string => csharpCacheDir("toolchain", pinnedDotnet())

/** The runtime the pinned SDK carries (`10.0.13`): the one dir under its `shared/Microsoft.NETCore.App`. */
export function dotnetRuntime(): string {
	const dir = join(dotnetRoot(), "shared/Microsoft.NETCore.App")
	const found = existsSync(dir) ? readdirSync(dir) : []
	if (found.length !== 1) throw new Error(`${dir} holds ${found.length} runtimes, not one: ${found.join(", ")}`)
	return found[0] as string
}

/** The reference assemblies csc compiles against, from the pinned SDK's own targeting pack. */
export const refPack = (): string =>
	join(dotnetRoot(), "packs/Microsoft.NETCore.App.Ref", dotnetRuntime(), "ref", tfm())

/** The dirs every .NET command runs with, under `root` (the cache, or the install line's `$D`). */
const dirs = (root: string, version: string) => ({
	DOTNET_CLI_HOME: `${root}/home`,
	DOTNET_ROOT: `${root}/toolchain/${version}`,
	NUGET_HTTP_CACHE_PATH: `${root}/nuget-http`,
	NUGET_PACKAGES: `${root}/nuget`,
	NUGET_PLUGINS_CACHE_PATH: `${root}/nuget-plugins`,
	TMPDIR: `${root}/tmp`,
})

/* no telemetry, banner, first-run work, certificate or PATH edit; English output; no NuGet doc files; and the lean
 * switches (R7, mandatory): no MSBuild node reuse, no MSBuild server, no compiler server */
const SETTINGS = {
	DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: "false",
	DOTNET_CLI_TELEMETRY_OPTOUT: "1",
	DOTNET_CLI_UI_LANGUAGE: "en",
	DOTNET_CLI_USE_MSBUILD_SERVER: "0",
	DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: "1",
	DOTNET_GENERATE_ASPNET_CERTIFICATE: "false",
	DOTNET_NOLOGO: "1",
	DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
	MSBUILDDISABLENODEREUSE: "1",
	NUGET_XMLDOC_MODE: "skip",
	UseSharedCompilation: "false",
} as const

/** The flags every build passes besides the lean variables: the defaults leave `VBCSCompiler` alive (P2-C). */
export const LEAN_BUILD = ["-nodeReuse:false", "-maxcpucount:1", "-p:UseSharedCompilation=false"] as const

/* the variables a caller's shell may set that would steer the SDK, MSBuild (which reads every variable as a
 * property, whatever its case), NuGet, or the runtime's config and profiler hooks */
const STEERING = /^(?:DOTNET_|NUGET_|MSBUILD|COMPLUS_|CORECLR_|USESHAREDCOMPILATION$)/i

/**
 * The environment every .NET command runs with. A caller's .NET, MSBuild, NuGet and runtime settings are removed,
 * not blanked; every dir lies under the cache, made here; HOME is left as it is.
 */
export function dotnetEnv(): NodeJS.ProcessEnv {
	const kept = Object.entries(process.env).filter(([key]) => !STEERING.test(key))
	const made = Object.entries(dirs(csharpCacheDir(), pinnedDotnet()))
	for (const [, dir] of made) mkdirSync(dir, { recursive: true })
	return { ...Object.fromEntries(kept), ...Object.fromEntries(made), ...SETTINGS }
}

/** How a .NET command runs: in `cwd`, with `input` on stdin. */
type RunOptions = { readonly cwd?: string; readonly input?: string }

/** The pinned `dotnet` on `args`: the muxer the install extracted, never one on PATH. */
export function runDotnet(args: readonly string[], options: RunOptions = {}): SpawnSyncReturns<string> {
	return spawnSync(join(dotnetRoot(), "dotnet"), [...args], {
		cwd: options.cwd,
		encoding: "utf8",
		env: dotnetEnv(),
		input: options.input,
		maxBuffer: 1 << 26,
	})
}

/** What an asynchronous run gave back. */
export type Ran = { status: number; stderr: string; stdout: string }

/**
 * `runDotnet` as a promise, so an in-process server keeps answering meanwhile. A program that exits without
 * reading all of `input` answers by its exit status.
 */
export function execDotnet(args: readonly string[], options: RunOptions = {}): Promise<Ran> {
	return new Promise((done, fail) => {
		const child = spawn(join(dotnetRoot(), "dotnet"), [...args], { cwd: options.cwd, env: dotnetEnv() })
		let stdout = ""
		let stderr = ""
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
		child.once("error", fail)
		child.once("close", (status) => done({ status: status ?? 1, stderr, stdout }))
		child.stdin.on("error", () => {
			/* a program that exits without reading all its input: its exit status answers */
		})
		child.stdin.end(options.input ?? "")
	})
}

/** The pinned SDK's own C# compiler on `args`, run by its muxer (Fb9): a program or a check, no MSBuild. */
export function runCsc(args: readonly string[], options: RunOptions = {}): SpawnSyncReturns<string> {
	return runDotnet([join(dotnetRoot(), "sdk", pinnedDotnet(), "Roslyn/bincore/csc.dll"), ...args], options)
}

/** The `<program>.runtimeconfig.json` a csc-built program runs with: the pinned runtime, rolling forward to none. */
export function runtimeConfig(): string {
	const framework = { name: "Microsoft.NETCore.App", version: dotnetRuntime() }
	return JSON.stringify({ runtimeOptions: { framework, rollForward: "Disable", tfm: tfm() } })
}

/**
 * The command that installs SDK `version` into the honey cache, from anywhere in the repo: Microsoft's tarball,
 * checked against `dotnet-sdk.sha512` before anything is extracted, extracted whole or not at all, then the seed
 * restore under the env every run uses, the one NuGet fetch (the build-time package an AOT-compatible build
 * pulls), so every later restore is offline. Its HOME is the cache's, since the fetch's certificate checks write
 * the runtime's revocation cache under HOME, and the user's `~/.dotnet` is left as it is.
 */
export function dotnetInstall(version: string): string {
	const tarball = `"$D/dl/dotnet-sdk-$V-${DOTNET_RID}.tar.gz"`
	const env = Object.entries({ ...dirs("$D", "$V"), HOME: "$D/home", ...SETTINGS })
		.map(([key, value]) => `${key}="${value}"`)
		.join(" ")
	return [
		`V=${version}`,
		`D="${SHELL_ROOT}"`,
		`F="$(git rev-parse --show-toplevel)/${FIXTURES}"`,
		`T="$D/toolchain/$V"`,
		`mkdir -p "$D/dl" "$D/home" "$D/tmp"`,
		`curl -fsSL -o ${tarball} "https://builds.dotnet.microsoft.com/dotnet/Sdk/$V/dotnet-sdk-$V-${DOTNET_RID}.tar.gz"`,
		`(cd "$D/dl" && sha512sum -c "$F/dotnet-sdk.sha512")`,
		`rm -rf "$T" "$T.partial"`,
		`mkdir -p "$T.partial"`,
		`tar -xzf ${tarball} -C "$T.partial"`,
		`mv "$T.partial" "$T"`,
		`rm ${tarball}`,
		`${env} "$T/dotnet" restore "$F/seed/Seed.csproj" --source https://api.nuget.org/v3/index.json --artifacts-path "$D/tmp/seed"`,
	].join(" && ")
}

/** Whether the pinned SDK and the seed's package are installed: nothing is fetched here. */
export function hasDotnet(): boolean {
	if (!existsSync(join(dotnetRoot(), "dotnet"))) return false
	const version = runDotnet(["--version"], { cwd: csharpCacheDir("tmp") }).stdout.trim()
	return version === pinnedDotnet() && existsSync(join(csharpCacheDir("nuget"), "microsoft.net.illink.tasks"))
}

/** Whether a missing SDK must fail rather than skip: CI and the pre-push battery set one of these. */
export function dotnetRequired(): boolean {
	return process.env.HONEY_REQUIRE_TOOLCHAINS === "1" || process.env.HONEY_REQUIRE_DOTNET === "1"
}

/**
 * Whether a test runs its .NET half: false only where .NET may be absent. A missing SDK fails the test where it is
 * required (CI, the pre-push battery), naming its install, and skips the .NET half anywhere else. Callers gate with
 * `describe.skipIf` or `it.skipIf`, never an early return.
 */
export function withDotnet(): boolean {
	const present = hasDotnet()
	if (!present && dotnetRequired())
		throw new Error(
			`.NET SDK ${pinnedDotnet()} is required here (HONEY_REQUIRE_DOTNET or HONEY_REQUIRE_TOOLCHAINS) and is not installed: ${dotnetInstall(pinnedDotnet())}`,
		)
	return present
}
