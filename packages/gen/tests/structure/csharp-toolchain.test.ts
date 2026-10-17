/**
 * Toolchain parity (G10, G11, R7) for C#: gen runs .NET only through `src/emit/csharp/__fixtures__/csharp-env.ts`,
 * under the SDK the repo root's `global.json` pins (exact, `rollForward: disable`), extracted from Microsoft's
 * tarball after a check against the committed `dotnet-sdk.sha512` into `$HOME/.cache/honey-tmp/dotnet` (never
 * `/usr/bin/dotnet`, `~/.dotnet` or a `dotnet` on PATH), and CI installs exactly that, by the command a missing SDK
 * names. As with Python, importing the env file does not license a raw spawn. It hands out two paths, the SDK root
 * and the reference pack, and only to the compile fixture and the toolchain legs. Every build runs lean (no MSBuild
 * node reuse, no MSBuild server, no compiler server), so a build leaves no process behind. A run never installs,
 * and every dir it sets lies under the cache; HOME stays the caller's.
 */
import {
	existsSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as env from "../../src/emit/csharp/__fixtures__/csharp-env.ts"

const { LEAN_BUILD, csharpCacheDir, dotnetEnv, dotnetInstall, dotnetRoot, pinnedDotnet, runDotnet, withDotnet } = env

const GEN = resolve(import.meta.dirname, "../..")
const REPO = join(GEN, "../..")
const ROOTS = ["src", "tests", "scripts"]
const SELF = "tests/structure/csharp-toolchain.test.ts"
const ENV = "src/emit/csharp/__fixtures__/csharp-env.ts"
const FIXTURE_DIR = join(GEN, "src/emit/csharp/__fixtures__")

/* a spawn of a .NET tool, or a list of commands whose entry starts with one (a list of language names is not one) */
const CS_COMMAND =
	/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*"(?:dotnet|csc|msbuild|nuget)"|\[\[\s*"(?:dotnet|csc|msbuild|nuget)",/

/* the files besides the env that may name the SDK root or the reference pack: the compile fixture (csc's
 * references) and the toolchain legs, which compile and run their programs with csc */
const HANDED = [
	"src/emit/csharp/__fixtures__/compiled.ts",
	"src/emit/shared/escape.toolchains.test.ts",
	"src/emit/shared/webhooks.toolchains.test.ts",
]

/** Every TS file under `dir`, recursively, gen-relative. */
function tsFiles(dir: string): string[] {
	return readdirSync(join(GEN, dir)).flatMap((name) => {
		const path = join(dir, name)
		if (statSync(join(GEN, path)).isDirectory()) return name === "_tokenizer" ? [] : tsFiles(path)
		return name.endsWith(".ts") ? [path] : []
	})
}

/** Every gen TS file but this one and the env file, with its text. */
const others = () =>
	ROOTS.flatMap(tsFiles)
		.filter((path) => path !== SELF && path !== ENV)
		.map((path) => ({ path, text: readFileSync(join(GEN, path), "utf8") }))

describe(".NET runs through csharp-env.ts only", () => {
	it("leaves no gen file spawning dotnet, csc, msbuild or nuget but csharp-env.ts", () => {
		expect(
			others()
				.filter(({ text }) => CS_COMMAND.test(text))
				.map(({ path }) => path),
		).toEqual([])
	})

	it("recognizes a raw spawn and a command list as running .NET", () => {
		expect(
			[
				'spawnSync("dotnet", ["build"])',
				'spawn("csc")',
				'run: [["dotnet", "format"]]',
				'spawnSync("node")',
				'["go", "rust", "python", "csharp"]',
			].map((t) => CS_COMMAND.test(t)),
		).toEqual([true, true, true, false, false])
	})

	it("hands out two paths, the SDK root and the reference pack, and only to the compile fixture and the toolchain legs", () => {
		expect(Object.keys(env).filter((name) => /path|pack|root/i.test(name))).toEqual(["dotnetRoot", "refPack"])
		const loose = others().filter(
			({ path, text }) => !HANDED.includes(path) && (text.includes("refPack(") || text.includes("dotnetRoot(")),
		)
		expect(loose.map(({ path }) => path)).toEqual([])
	})
})

/** The `<name>` element's text in an MSBuild project, or undefined. */
const property = (project: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(project)?.[1]

describe("the pins", () => {
	it("pin one exact SDK that rolls forward to no other", () => {
		expect(JSON.parse(readFileSync(join(REPO, "global.json"), "utf8"))).toEqual({
			sdk: { rollForward: "disable", version: expect.stringMatching(/^\d+\.\d+\.\d+$/) },
		})
		expect(pinnedDotnet()).toMatch(/^\d+\.\d+\.\d+$/)
	})

	it("check the pinned SDK's linux-x64 tarball against one sha512, in sha512sum -c form", () => {
		const name = `dotnet-sdk-${pinnedDotnet().replaceAll(".", "\\.")}-linux-x64\\.tar\\.gz`
		expect(readFileSync(join(FIXTURE_DIR, "dotnet-sdk.sha512"), "utf8")).toMatch(
			new RegExp(`^[0-9a-f]{128} {2}${name}\\n$`),
		)
	})

	/* R1: one target framework, the pinned SDK's major; the seed restores what an AOT-compatible build pulls */
	it("restore the seed at the target framework the SDK's major names, AOT-compatible", () => {
		const seed = readFileSync(join(FIXTURE_DIR, "seed/Seed.csproj"), "utf8")
		expect([property(seed, "TargetFramework"), property(seed, "IsAotCompatible")]).toEqual([
			`net${pinnedDotnet().split(".")[0]}.0`,
			"true",
		])
	})
})

const WORKFLOW = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8")

/* the step that installs the pinned SDK, from the file: the same command a missing SDK names */
const SDK_PIN = `"$(sed -n 's/.*"version": "\\(.*\\)",/\\1/p' global.json)"`
const INSTALL = dotnetInstall(SDK_PIN)

/** Each job's body under `jobs:`, by name. */
function jobs(workflow: string): Record<string, string> {
	const body = workflow.slice(workflow.indexOf("\njobs:\n"))
	return Object.fromEntries(
		[...body.matchAll(/^ {2}([\w-]+):\n((?: {4}.*\n|\n)*)/gm)].map(([, name, text]) => [name, text]),
	)
}

/** Each step of a job body, as its text. */
const steps = (job: string) => job.split(/^ {6}- /m)

/** The trimmed lines of each step's `run` in a job body. */
const runs = (job: string) =>
	steps(job).map((step) =>
		(/\brun: [|>]-?\n((?: {10}.*\n)*)|\brun: (.*)\n/.exec(step) ?? [])
			.slice(1)
			.join("")
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean),
	)

/** Whether a step saves or restores the dotnet cache, keyed on content hashes. */
const cachesDotnet = (step: string) =>
	/^uses: actions\/cache(?:\/restore)?@v4\n/.test(step) &&
	/\}\}-dotnet-\$\{\{ hashFiles\(/.test(step.replace(/\s+/g, " "))

describe("CI installs the SDK global.json pins", () => {
	/* the jobs that run gen's .NET: the csharp project's shard, and the rust project's, whose toolchain files reach
	 * every language (vitest.config.ts, Fb13); the harness (`bun run test:harness`) joins them in phase e */
	it("in every job that runs gen's .NET, by the command a missing SDK names, beside the dotnet cache", () => {
		const testing = Object.entries(jobs(WORKFLOW)).filter(([, job]) => /--project (?:csharp|rust)\b/.test(job))
		expect(testing.map(([name]) => name).sort()).toEqual(["gen-csharp", "gen-rust"])
		const missing = testing.filter(
			([, job]) => !runs(job).some((lines) => lines.includes(INSTALL)) || !steps(job).some(cachesDotnet),
		)
		expect(missing.map(([name]) => name)).toEqual([])
	})

	/* SDK_PIN's sed prints the version on any line holding `"version": "<v>",`, so the formatted file must keep
	 * one such line: `version` last among the keys (no comma) would hand the install an empty pin */
	it("reads the pin from global.json as formatted, by SDK_PIN's sed pattern", () => {
		const lines = readFileSync(join(REPO, "global.json"), "utf8").split("\n")
		expect(lines.flatMap((line) => /.*"version": "(.*)",/.exec(line)?.slice(1) ?? [])).toEqual([pinnedDotnet()])
	})

	it("names no other .NET: no setup action, no install script, no version input, no dotnet but the install's", () => {
		const setups = WORKFLOW.match(
			/actions\/setup-dotnet\S*|dotnet-install\.sh|dot\.net\/v1|\bdotnet-version:.*|\bglobal-json-file:.*/g,
		)
		expect(setups ?? []).toEqual([])
		const commands = Object.values(jobs(WORKFLOW))
			.flatMap(runs)
			.flat()
			.filter((line) => line !== INSTALL && /(?:^|[\s;&|("/])dotnet"?(?:\s|$)/.test(line))
		expect(commands).toEqual([])
	})
})

/** The `~/.dotnet/tools` entries that point into the honey cache, by link or by the path a shim holds. */
function toolsIntoCache(): string[] {
	const tools = join(process.env.HOME ?? homedir(), ".dotnet/tools")
	if (!existsSync(tools)) return []
	return readdirSync(tools).filter((name) => {
		const path = join(tools, name)
		if (lstatSync(path).isSymbolicLink()) return resolve(tools, readlinkSync(path)).includes("/.cache/honey-tmp/")
		return statSync(path).isFile() && readFileSync(path, "latin1").includes("/.cache/honey-tmp/")
	})
}

describe("the SDK a run uses", () => {
	const DOTNET = withDotnet()

	it.skipIf(!DOTNET)("runs the pinned SDK from the honey cache, the only SDK there", () => {
		expect(runDotnet(["--version"]).stdout.trim()).toBe(pinnedDotnet())
		const sdks = runDotnet(["--list-sdks"]).stdout.trim().split("\n")
		expect(sdks).toEqual([`${pinnedDotnet()} [${join(dotnetRoot(), "sdk")}]`])
	})

	it.skipIf(!DOTNET)("keeps the CLI's first-use state in the cache's CLI home", () => {
		runDotnet(["--version"], { cwd: csharpCacheDir("tmp") })
		expect(existsSync(join(csharpCacheDir("home"), ".dotnet", `${pinnedDotnet()}.dotnetFirstUseSentinel`))).toBe(true)
	})

	it.skipIf(!DOTNET)(
		"runs a program that never reads its stdin, however large the input, its exit status the answer",
		async () => {
			const dir = mkdtempSync(join(csharpCacheDir("tmp"), "stdin-"))
			try {
				const refs = readdirSync(env.refPack())
					.filter((name) => name.endsWith(".dll"))
					.map((name) => `-r:${join(env.refPack(), name)}`)
				writeFileSync(
					join(dir, "P.cs"),
					"public static class P { public static void Main() => System.Console.WriteLine(3); }\n",
				)
				writeFileSync(join(dir, "p.runtimeconfig.json"), env.runtimeConfig())
				const built = env.runCsc(["-nologo", "-noconfig", "-warnaserror", "-out:p.dll", ...refs, "P.cs"], { cwd: dir })
				expect([built.status, built.stdout]).toEqual([0, ""])
				/* more than a pipe holds: the program exits before the write ends, which must not surface as EPIPE */
				expect(await env.execDotnet(["p.dll"], { cwd: dir, input: "x".repeat(4 << 20) })).toEqual({
					status: 0,
					stderr: "",
					stdout: "3\n",
				})
			} finally {
				rmSync(dir, { force: true, recursive: true })
			}
		},
	)
})

describe("what a run never does", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("never installs a missing SDK: it skips, or fails naming the install where .NET is required", () => {
		vi.stubEnv("HONEY_REQUIRE_TOOLCHAINS", "")
		vi.stubEnv("HONEY_REQUIRE_DOTNET", "")
		vi.stubEnv("HOME", csharpCacheDir("tmp", "no-dotnet"))
		expect(withDotnet()).toBe(false)
		vi.stubEnv("HONEY_REQUIRE_DOTNET", "1")
		expect(() => withDotnet()).toThrow(dotnetInstall(pinnedDotnet()))
	})

	it("sets every dir under the cache and leaves HOME the caller's, with no tool linked into ~/.dotnet/tools", () => {
		const cache = `${join(process.env.HOME ?? homedir(), ".cache/honey-tmp/dotnet")}/`
		const dirs = Object.entries(dotnetEnv()).filter(
			([key, value]) => process.env[key] !== value && value?.includes("/"),
		)
		expect(dirs.map(([key]) => key).sort()).toEqual([
			"DOTNET_CLI_HOME",
			"DOTNET_ROOT",
			"NUGET_HTTP_CACHE_PATH",
			"NUGET_PACKAGES",
			"NUGET_PLUGINS_CACHE_PATH",
			"TMPDIR",
		])
		expect(dirs.filter(([, value]) => !value?.startsWith(cache))).toEqual([])
		expect(dotnetEnv().HOME).toBe(process.env.HOME)
		expect(toolsIntoCache()).toEqual([])
	})

	it("drops every variable a caller sets that would steer the SDK, MSBuild, NuGet or the runtime", () => {
		const steering = ["CORECLR_ENABLE_PROFILING", "COMPlus_gcServer", "DOTNET_ROLL_FORWARD", "MSBuildSDKsPath"]
		for (const key of [...steering, "NUGET_CERT_REVOCATION_MODE"]) vi.stubEnv(key, "1")
		vi.stubEnv("UseSharedCompilation", "true")
		const set = dotnetEnv()
		expect([...steering, "NUGET_CERT_REVOCATION_MODE"].filter((key) => key in set)).toEqual([])
		expect(set.UseSharedCompilation).toBe("false")
	})
})

/** The pinned SDK's compiler servers and MSBuild nodes alive now, as `pid cmdline`. */
function buildServers(): string[] {
	const sdk = join(dotnetRoot(), "sdk")
	return readdirSync("/proc")
		.filter((name) => /^\d+$/.test(name))
		.flatMap((pid) => {
			const path = join("/proc", pid, "cmdline")
			/* a process that ended since the listing has no cmdline left to read */
			const line = existsSync(path) ? readFileSync(path, "utf8").replaceAll("\0", " ") : ""
			return line.includes(sdk) && /VBCSCompiler|MSBuild\.dll/.test(line) ? [`${pid} ${line.trim()}`] : []
		})
}

describe("lean builds", () => {
	const DOTNET = withDotnet()

	it("run with no MSBuild node reuse, no MSBuild server and no compiler server", () => {
		expect(dotnetEnv()).toMatchObject({
			DOTNET_CLI_USE_MSBUILD_SERVER: "0",
			MSBUILDDISABLENODEREUSE: "1",
			UseSharedCompilation: "false",
		})
		expect(LEAN_BUILD).toEqual(["-nodeReuse:false", "-maxcpucount:1", "-p:UseSharedCompilation=false"])
	})

	/* the defaults leave VBCSCompiler (and reusable MSBuild nodes) alive, reparented away from the build once it
	 * exits (P2-C): so a fresh build is made here, and every server of the pinned SDK it could leave is looked
	 * for, by its command line, never killed */
	it.skipIf(!DOTNET)("leave no compiler server or MSBuild node behind a fresh build", async () => {
		const before = new Set(buildServers())
		const dir = mkdtempSync(join(csharpCacheDir("tmp"), "lean-"))
		try {
			const tfm = `net${pinnedDotnet().split(".")[0]}.0`
			writeFileSync(
				join(dir, "Lean.csproj"),
				`<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>${tfm}</TargetFramework>\n  </PropertyGroup>\n</Project>\n`,
			)
			writeFileSync(join(dir, "One.cs"), "public static class One { public static int Value => 1; }\n")
			writeFileSync(
				join(dir, "NuGet.Config"),
				"<configuration><packageSources><clear /></packageSources></configuration>\n",
			)
			writeFileSync(join(dir, "global.json"), readFileSync(join(REPO, "global.json")))
			const args = ["build", "Lean.csproj", "-c", "Release", "--artifacts-path", "art", ...LEAN_BUILD, "-v", "q"]
			const built = runDotnet(args, { cwd: dir })
			const diagnostics = built.stdout.split("\n").filter((line) => /: (?:error|warning) [A-Z]+\d+/.test(line))
			expect({ diagnostics, status: built.status }).toEqual({ diagnostics: [], status: 0 })
			expect(existsSync(join(dir, "art/bin/Lean/release/Lean.dll"))).toBe(true)
			await vi.waitFor(() => expect(buildServers().filter((line) => !before.has(line))).toEqual([]), {
				interval: 100,
				timeout: 3_000,
			})
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})
})
