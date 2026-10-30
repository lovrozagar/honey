#!/usr/bin/env bun
/**
 * Build tier. Every e2e app is built for every deploy target it declares, on the
 * runtime you pick. A target passes when the build exits 0, emits the artifacts its
 * spec names, stays under its size budget and its runtime's hang guard, and the median of
 * its BUILD_SAMPLES builds over the median of the honey-free reference builds timed around
 * them (build-window.ts) is within its recorded ceiling (build-gate.ts says how, and why a
 * ratio and a median). Every built cell prints a `REFERENCE build` line, its references'
 * ms, a `REFERENCE0 build` line, the bare reference's timed beside them (bit 21 bref
 * diagnostic, its median the RATIO line's ref0=), and a `RATIO build` line, each build's
 * ms after builds=; BUILD_MODE=record prints
 * them without judging, for CI to record the ceilings from.
 *
 *   bun run packages/core/tests/e2e/run-build.ts
 *   bun run packages/core/tests/e2e/run-build.ts --runtime bun
 *   bun run packages/core/tests/e2e/run-build.ts --runtime all --target cloudflare
 *   bun run packages/core/tests/e2e/run-build.ts --app kitchen --verbose
 *   bun run packages/core/tests/e2e/run-build.ts --check-generated
 */
import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import {
	BUILD_SPECS,
	type BuildSpec,
	buildCommand,
	buildCwd,
	entryArtifact,
	isRuntimeId,
	isTargetId,
	knownBuildApps,
	missingBuildApps,
	REFERENCE_BUILD,
	RUNTIME_IDS,
	type RuntimeId,
	TARGET_IDS,
	type TargetId,
	unregisteredBuildApps,
	viteBuildCommand,
} from "./builds.ts"
import {
	BUILD_SAMPLES,
	judgeBuild,
	LOCAL_REASON,
	median,
	modeOf,
	ratioLine,
	readBaseline,
	recordedCells,
	referenceLine,
	runtimeKey,
} from "./build-gate.ts"
import { type CellMeter, cellMeter } from "./build-window.ts"

function arg(flag: string): string | undefined {
	const i = process.argv.indexOf(flag)
	if (i === -1) return undefined
	return process.argv[i + 1]
}

const verbose = process.argv.includes("--verbose")

/**
 * Generated files (routes.gen.ts, openapi.gen.json, …) are checked in, and the build
 * re-runs codegen through the app's own honey() plugin, so a build must reproduce them
 * byte for byte. Off by default: locally you often build with route edits in flight,
 * where a rewrite is the correct outcome. On in CI, where the checkout is clean and a
 * rewrite means the committed file is stale or codegen is not deterministic.
 */
const checkGenerated = process.argv.includes("--check-generated")

async function dirtyTrackedFiles(cwd: string): Promise<string[]> {
	const proc = Bun.spawn(["git", "status", "--porcelain", "--", cwd], { stderr: "pipe", stdout: "pipe" })
	const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
	return out
		.split("\n")
		.filter((line) => line.trim() !== "" && !line.startsWith("??"))
		.map((line) => line.slice(3).trim())
		.sort()
}

const runtimeRaw = arg("--runtime") ?? process.env.HONEY_BUILD_RUNTIME ?? "node"
if (runtimeRaw !== "all" && !isRuntimeId(runtimeRaw)) {
	console.error(`unknown --runtime ${runtimeRaw}. known: ${RUNTIME_IDS.join(" ")} all`)
	process.exit(1)
}
const runtimes: RuntimeId[] = runtimeRaw === "all" ? [...RUNTIME_IDS] : [runtimeRaw]

const targetRaw = arg("--target")
if (targetRaw !== undefined && !isTargetId(targetRaw)) {
	console.error(`unknown --target ${targetRaw}. known: ${TARGET_IDS.join(" ")}`)
	process.exit(1)
}

const app = arg("--app") ?? process.env.HONEY_BUILD_APP
if (app !== undefined && !knownBuildApps().includes(app)) {
	console.error(`unknown --app ${app}. known: ${knownBuildApps().join(", ")}`)
	process.exit(1)
}

const gone = missingBuildApps()
if (gone.length > 0) {
	console.error(`build specs point at missing apps: ${gone.join(", ")}`)
	process.exit(1)
}

/* a new e2e app must opt into this tier deliberately, not skip it by being forgotten */
const unregistered = unregisteredBuildApps()
if (unregistered.length > 0) {
	console.error(
		`e2e apps with no build spec: ${unregistered.join(", ")} — add them to packages/core/tests/e2e/builds.ts`,
	)
	process.exit(1)
}

const specs = BUILD_SPECS.filter(
	(spec) => (app === undefined || spec.app === app) && (targetRaw === undefined || spec.target === targetRaw),
)
if (specs.length === 0) {
	console.error("no build targets matched")
	process.exit(1)
}

type Status = "fail" | "pass" | "skip"

const mode = modeOf(process.env)
const baseline = readBaseline()

interface Result {
	detail?: string
	gzipKb?: number
	ms: number
	name: string
	status: Status
}

const SOURCE_CONDITION = "--conditions=honey-source"

function gzipKb(path: string): number {
	return Math.round(gzipSync(readFileSync(path)).length / 1024)
}

/** One `vite build` in `cwd` for `target`, timed: its exit code, output and wall time in ms. */
async function timedBuild(command: string[], cwd: string, target: TargetId) {
	const started = performance.now()
	const proc = Bun.spawn(command, {
		cwd,
		/* core is read as source in this checkout (R3): every process the build starts, on Node or Bun, the honey
		   generate child the plugin spawns included, resolves it through the honey-source condition */
		env: {
			...process.env,
			BUN_OPTIONS: SOURCE_CONDITION,
			HONEY_BUILD_TARGET: target,
			NODE_ENV: "production",
			NODE_OPTIONS: SOURCE_CONDITION,
		},
		stderr: verbose ? "inherit" : "pipe",
		stdin: "ignore",
		stdout: verbose ? "inherit" : "pipe",
	})
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		verbose ? Promise.resolve("") : new Response(proc.stdout).text(),
		verbose ? Promise.resolve("") : new Response(proc.stderr).text(),
	])
	return { code, ms: performance.now() - started, output: `${stdout}${stderr}` }
}

/* the version each runtime that runs `vite build` reports, for the key its ceilings are kept under */
const versions = new Map<RuntimeId, string>()
async function keyOf(runtime: RuntimeId): Promise<string> {
	if (!versions.has(runtime)) {
		const proc = Bun.spawn([runtime, "--version"], { stderr: "pipe", stdout: "pipe" })
		const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
		versions.set(runtime, out.trim())
	}
	return runtimeKey(runtime, versions.get(runtime) as string)
}

/* each runtime's meter, so a runtime's first cell of a target warms that target's reference on that runtime */
const meters = new Map<RuntimeId, CellMeter>()
function meterOf(runtime: RuntimeId): CellMeter {
	const known = meters.get(runtime)
	if (known !== undefined) return known
	const timed = (config: string) => {
		const command = viteBuildCommand(config, runtime)
		return async (target: string) => {
			const built = await timedBuild(command, REFERENCE_BUILD.cwd, target as TargetId)
			if (built.code !== 0) {
				process.stdout.write(built.output)
				throw new Error(`the reference build (${config}) for ${target} on ${runtime} exited ${built.code}`)
			}
			return built.ms
		}
	}
	const meter = cellMeter(timed(REFERENCE_BUILD.config), timed(REFERENCE_BUILD.bare))
	meters.set(runtime, meter)
	return meter
}

async function runBuild(spec: BuildSpec, runtime: RuntimeId): Promise<Result> {
	const name = `${spec.id} on ${runtime}`
	const cwd = buildCwd(spec)
	const dirtyBefore = checkGenerated ? await dirtyTrackedFiles(cwd) : []

	/*
	 * BUILD_SAMPLES builds from a clean output each, judged on their median over the median of the references timed
	 * around them (build-window.ts); the artifacts checked are the last build's
	 */
	const measured = await meterOf(runtime)(spec.target, async () => {
		for (const dir of spec.outDirs) {
			rmSync(join(cwd, dir), { force: true, recursive: true })
		}
		return timedBuild(buildCommand(spec, runtime), cwd, spec.target)
	})
	if ("failed" in measured) {
		process.stdout.write(measured.failed.output)
		return { detail: `build exited ${measured.failed.code}`, ms: measured.failed.ms, name, status: "fail" }
	}
	const { bare, builds, references } = measured
	const reference = median(references)
	const ms = median(builds)

	const missing = spec.expect.filter((rel) => !existsSync(join(cwd, rel)))
	if (missing.length > 0) {
		return { detail: `missing artifacts: ${missing.join(", ")}`, ms, name, status: "fail" }
	}

	const kb = gzipKb(join(cwd, entryArtifact(spec)))
	const key = await keyOf(runtime)
	console.log(referenceLine("REFERENCE", key, spec.id, references))
	console.log(referenceLine("REFERENCE0", key, spec.id, bare))
	const verdict = judgeBuild({
		builds,
		ceiling: baseline?.builds[key]?.[spec.id],
		mode,
		referenceMs: reference,
		runtime,
	})
	console.log(ratioLine(key, spec.id, verdict.ratio, builds, { bare: median(bare), worked: reference }))
	if (verdict.failures.length > 0) {
		return { detail: verdict.failures.join("; "), gzipKb: kb, ms, name, status: "fail" }
	}
	if (kb > spec.maxGzipKb) {
		return {
			detail: `bundle ${kb}KB gzipped exceeds the ${spec.maxGzipKb}KB budget — an optional dependency is likely being bundled`,
			gzipKb: kb,
			ms,
			name,
			status: "fail",
		}
	}

	if (checkGenerated) {
		const before = new Set(dirtyBefore)
		const rewritten = (await dirtyTrackedFiles(cwd)).filter((file) => !before.has(file))
		if (rewritten.length > 0) {
			return { detail: `build rewrote checked-in files: ${rewritten.join(", ")}`, gzipKb: kb, ms, name, status: "fail" }
		}
	}
	return { gzipKb: kb, ms, name, status: "pass" }
}

const results: Result[] = []
console.log(`build runtimes=${runtimes.join(",")} targets=${specs.map((s) => s.id).join(",")}\n`)
/* what this run does with its ratios, and why; the hang guard judges in every case */
function gateLine(): string {
	if (mode === "record") return "record mode, ratios printed and not judged (the hang guard still judges)"
	if (mode === "local") return `${LOCAL_REASON} (the hang guard still judges)`
	if (recordedCells(baseline) === 0) {
		const why = baseline === undefined ? "" : `: ${baseline.note}`
		return `no recorded ceilings in blueprint/baselines/build.json, ratios report-only${why}`
	}
	return `ratios of the median of ${BUILD_SAMPLES} builds judged against blueprint/baselines/build.json`
}
console.log(`build gate: ${gateLine()}\n`)

for (const runtime of runtimes) {
	for (const spec of specs) {
		const name = `${spec.id} on ${runtime}`
		if (!spec.runtimes.includes(runtime)) {
			results.push({
				detail: `${spec.target} builds run on ${spec.runtimes.join("/")} only`,
				ms: 0,
				name,
				status: "skip",
			})
			console.log(`${name}: skip — ${spec.target} builds run on ${spec.runtimes.join("/")} only\n`)
			continue
		}
		console.log(`──────── ${name} ────────`)
		const result = await runBuild(spec, runtime)
		results.push(result)
		console.log(
			`${name}: ${result.status === "pass" ? "pass" : "FAIL"} (${(result.ms / 1000).toFixed(1)}s` +
				(result.gzipKb !== undefined ? `, ${result.gzipKb}KB gz` : "") +
				")" +
				(result.detail ? ` — ${result.detail}` : "") +
				"\n",
		)
	}
}

const label: Record<Status, string> = { fail: "FAIL", pass: "pass", skip: "skip" }
console.log("\n========== build summary ==========")
for (const r of results) {
	console.log(
		`${label[r.status].padEnd(4)}  ${r.name.padEnd(30)} ${(r.ms / 1000).toFixed(1)}s` +
			(r.gzipKb !== undefined ? `  ${String(r.gzipKb).padStart(4)}KB gz` : ""),
	)
}
const failed = results.filter((r) => r.status === "fail")
const passed = results.filter((r) => r.status === "pass")
const skipped = results.filter((r) => r.status === "skip")
console.log(
	`\n${passed.length}/${passed.length + failed.length} passed` +
		(skipped.length > 0 ? `, ${skipped.length} skipped` : "") +
		(failed.length > 0 ? ` — failed: ${failed.map((r) => r.name).join(", ")}` : ""),
)
process.exit(failed.length > 0 ? 1 : 0)
