#!/usr/bin/env bun
/**
 * Build tier. Every e2e app is built for every deploy target it declares, on the
 * runtime you pick. A target passes when the build exits 0, emits the artifacts its
 * spec names, and stays under its size budget.
 *
 *   bun run e2e/run-build.ts
 *   bun run e2e/run-build.ts --runtime bun
 *   bun run e2e/run-build.ts --runtime all --target cloudflare
 *   bun run e2e/run-build.ts --app kitchen --verbose
 *   bun run e2e/run-build.ts --check-generated
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
	RUNTIME_IDS,
	type RuntimeId,
	TARGET_IDS,
	unregisteredBuildApps,
} from "./apps/builds.ts"

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
	console.error(`e2e apps with no build spec: ${unregistered.join(", ")} — add them to e2e/apps/builds.ts`)
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

interface Result {
	detail?: string
	gzipKb?: number
	ms: number
	name: string
	status: Status
}

function gzipKb(path: string): number {
	return Math.round(gzipSync(readFileSync(path)).length / 1024)
}

async function runBuild(spec: BuildSpec, runtime: RuntimeId): Promise<Result> {
	const name = `${spec.id} on ${runtime}`
	const cwd = buildCwd(spec)
	for (const dir of spec.outDirs) {
		rmSync(join(cwd, dir), { force: true, recursive: true })
	}

	const dirtyBefore = checkGenerated ? await dirtyTrackedFiles(cwd) : []

	const started = Date.now()
	const proc = Bun.spawn(buildCommand(spec, runtime), {
		cwd,
		env: { ...process.env, HONEY_BUILD_TARGET: spec.target, NODE_ENV: "production" },
		stderr: verbose ? "inherit" : "pipe",
		stdin: "ignore",
		stdout: verbose ? "inherit" : "pipe",
	})
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		verbose ? Promise.resolve("") : new Response(proc.stdout).text(),
		verbose ? Promise.resolve("") : new Response(proc.stderr).text(),
	])
	const ms = Date.now() - started

	if (code !== 0) {
		if (!verbose) process.stdout.write(`${stdout}${stderr}`)
		return { detail: `build exited ${code}`, ms, name, status: "fail" }
	}

	const missing = spec.expect.filter((rel) => !existsSync(join(cwd, rel)))
	if (missing.length > 0) {
		return { detail: `missing artifacts: ${missing.join(", ")}`, ms, name, status: "fail" }
	}

	const kb = gzipKb(join(cwd, entryArtifact(spec)))
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
