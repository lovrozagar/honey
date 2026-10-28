/**
 * No process of a Bun build replaces `Error.prepareStackTrace` (bit 20 k-fix's class, fixture/stack-hook-trap.ts says
 * why it reds a build). One real cold `vite build` of the defaults e2e app for Cloudflare, the command run-build.ts's
 * defaults×cloudflare cell runs, with the trap preloaded into Vite and the honey generate child the plugin starts. Its
 * TMPDIR (Node's compile cache, any jiti cache) and Bun's transpiler cache are new and empty; Vite writes the bundled
 * config anew per build under a unique name. Defaults is the smallest app whose build reaches both processes.
 *
 * It runs on the pinned Bun (package.json's packageManager, CI's) and on PATH's when that is another version, so a
 * newer local Bun is held to it too. In CI both are the pin: one build, about 1.5 s.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { withPinnedBun } from "../../../gen/src/gen/__fixtures__/pinned-bun.ts"
import { BUILD_SPECS, type BuildSpec, buildCommand, buildCwd, entryArtifact } from "../e2e/builds.ts"
import { scratch } from "./fixture/packed.ts"

const TRAP = join(import.meta.dirname, "fixture", "stack-hook-trap.ts")
function defaultsCell(): BuildSpec {
	const found = BUILD_SPECS.find((candidate) => candidate.id === "defaults×cloudflare")
	if (found === undefined) throw new Error("builds.ts has no defaults×cloudflare cell")
	return found
}
const spec = defaultsCell()

const versionOf = (bun: string) => spawnSync(bun, ["--version"], { encoding: "utf8" }).stdout?.trim() ?? ""

/* each distinct Bun once: the pinned one (a skip without it, a failure under HONEY_REQUIRE_TOOLCHAINS), then PATH's */
const buns = new Map<string, string>()
for (const bun of [withPinnedBun(), "bun"]) {
	const version = bun === undefined ? "" : versionOf(bun)
	if (bun !== undefined && version !== "" && !buns.has(version)) buns.set(version, bun)
}

const files = scratch("stack-hook")
afterAll(() => files.done())

type Entry = { argv: string[]; kind: "replaced" | "start"; pid: number; stack?: string }

function coldBuild(bun: string, version: string) {
	const dir = join(files.out, version)
	const tmp = join(dir, "tmp")
	mkdirSync(join(dir, "transpiler"), { recursive: true })
	mkdirSync(tmp, { recursive: true })
	const log = join(dir, "trap.jsonl")
	const [, ...args] = buildCommand(spec, "bun")
	const built = spawnSync(bun, args, {
		cwd: buildCwd(spec),
		encoding: "utf8",
		env: {
			...process.env,
			BUN_OPTIONS: `--conditions=honey-source --preload ${TRAP}`,
			BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(dir, "transpiler"),
			HONEY_BUILD_TARGET: "cloudflare",
			HONEY_STACK_HOOK_LOG: log,
			NODE_ENV: "production",
			NODE_OPTIONS: "--conditions=honey-source",
			TMPDIR: tmp,
		},
		timeout: 120_000,
	})
	const entries = existsSync(log)
		? readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Entry)
		: []
	return { code: built.status, entries, output: `${built.stdout}${built.stderr}` }
}

describe.skipIf(buns.size === 0)("a cold Bun build of an e2e app", () => {
	it.each([...buns])("replaces no Error.prepareStackTrace on Bun %s", (version, bun) => {
		const { code, entries, output } = coldBuild(bun, version)
		/* the trap ran in Vite and in the generate child, or a clean log would prove nothing */
		const started = entries.filter((entry) => entry.kind === "start")
		expect([
			started.some((entry) => entry.argv.some((arg) => arg.endsWith("vite.js"))),
			started.some((entry) => entry.argv.includes("generate")),
		]).toEqual([true, true])
		/* every replacement with its replacer's stack: the list must be empty */
		expect(entries.filter((entry) => entry.kind === "replaced").map((entry) => entry.stack)).toEqual([])
		expect({ code, output: code === 0 ? "" : output }).toEqual({ code: 0, output: "" })
		expect(existsSync(join(buildCwd(spec), entryArtifact(spec)))).toBe(true)
	})
})
