/**
 * Build registry. Every production bundle a honey app can be asked for,
 * paired with the artifacts that build must emit and the size it must stay under.
 *
 * A target is one (app, deploy target) pair. The runtime that *runs* the build is
 * orthogonal — see RUNTIME_IDS. Both axes matter: the deploy target decides which
 * feature prelude `createBuildPlugin` injects and whether node builtins are external,
 * and the build runtime catches a plugin that assumes one host's APIs.
 */
import { existsSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** Runtime that executes `vite build`. */
export const RUNTIME_IDS = ["node", "bun"] as const
export type RuntimeId = (typeof RUNTIME_IDS)[number]

/** Deploy target the bundle is produced for — honey/build's `target`. */
export const TARGET_IDS = ["node", "bun", "cloudflare"] as const
export type TargetId = (typeof TARGET_IDS)[number]

const e2eRoot = dirname(fileURLToPath(import.meta.url))
const appsRoot = join(e2eRoot, "apps")

export interface BuildSpec {
	/** e2e app directory name. */
	app: string
	/** Vite config, relative to the app. */
	config: string
	/** Paths, relative to the app, the build must emit. */
	expect: string[]
	/** `<app>×<target>`. */
	id: string
	/**
	 * Ceiling for the entry bundle, in KB gzipped. A honey bundle rots by silently
	 * absorbing an optional dependency — `effect` and `zod` are loaded dynamically and
	 * must stay out of a bundle that never calls them. Size is the only signal that
	 * catches that, so it is asserted rather than merely reported.
	 */
	maxGzipKb: number
	/** Ceiling for one build of it, in ms, per runtime that runs the build (MAX_BUILD_MS). */
	maxBuildMs: Record<RuntimeId, number>
	/** Paths, relative to the app, wiped before the build. */
	outDirs: string[]
	/** Runtimes that can run this build. */
	runtimes: RuntimeId[]
	/** Deploy target the build produces. */
	target: TargetId
}

const ALL_RUNTIMES: RuntimeId[] = [...RUNTIME_IDS]

/**
 * Every e2e app builds for every target. The apps are deliberately uniform — one
 * `src/gen-app.ts` exporting `app` — so the matrix is generated rather than written
 * out 20 times. Per-app deviations belong here, as fields on the entry.
 */
type AppBuild = {
	app: string
	/** Override the default ceiling for this app, per target. */
	maxGzipKb?: Partial<Record<TargetId, number>>
	/** Targets this app opts out of, with the reason. */
	skipTargets?: Partial<Record<TargetId, string>>
}

/**
 * Node and bun keep dependencies external, so their bundles are small. Cloudflare
 * bundles everything, which is why it is the target that regresses first when a
 * dynamic import stops being opaque.
 */
const DEFAULT_MAX_GZIP_KB: Record<TargetId, number> = {
	bun: 110,
	cloudflare: 110,
	node: 110,
}

/**
 * One build's ceiling per runtime that runs `vite build` (bit 19 j2), every app and target alike: that runtime's worst
 * per-cell median, times the CI runner's factor over this machine (1.91 at most: ceb5570, CI run 40563108456's build
 * jobs against the same commit timed here), times that runtime's own spread (a cell's slowest build over its median),
 * rounded up to the next second. Measured on v1, 5 builds of each cell (j2/buildtimes.tsv):
 * - bun 1.3.11: worst median 1.7 s (surface×node), spread 1.33 → 1.7 × 1.91 × 1.33 = 4.3 s → 5 s. CI's first v1 run
 *   (40582174256) built every Bun cell in 2.4–2.8 s.
 * - Node (22 and current): worst median 4.6 s (defaults×bun on Node 22), spread 3.96 → 4.6 × 1.91 × 3.96 = 34.8 s →
 *   35 s. That spread was measured at load averages of 13–28 on a shared machine (Bun's at 8–10): a re-measure on a
 *   quiet runner is the reason to tighten it. CI built every Node cell in 6.0–6.5 s.
 * One shared ceiling would give Bun Node's 35 s, so a 10x Bun regression would pass.
 */
const MAX_BUILD_MS: Record<RuntimeId, number> = { bun: 5_000, node: 35_000 }

const APP_BUILDS: AppBuild[] = [
	{ app: "compose" },
	{ app: "defaults" },
	{ app: "gateway" },
	{ app: "kitchen" },
	{ app: "surface" },
]

export const BUILD_SPECS: BuildSpec[] = APP_BUILDS.flatMap((entry) =>
	TARGET_IDS.filter((target) => entry.skipTargets?.[target] === undefined).map((target) => ({
		app: entry.app,
		config: "vite.build.config.ts",
		expect: [`dist/${target}/index.js`],
		id: `${entry.app}×${target}`,
		maxBuildMs: MAX_BUILD_MS,
		maxGzipKb: entry.maxGzipKb?.[target] ?? DEFAULT_MAX_GZIP_KB[target],
		outDirs: [`dist/${target}`],
		runtimes: ALL_RUNTIMES,
		target,
	})),
)

/** Why a build of `spec` on `runtime` that took `ms` is over its ceiling, or null when it is within it. */
export function overBuildCeiling(spec: BuildSpec, runtime: RuntimeId, ms: number): string | null {
	const ceiling = spec.maxBuildMs[runtime]
	return ms > ceiling ? `built in ${ms}ms, over its ${ceiling}ms ceiling on ${runtime}` : null
}

export function isRuntimeId(name: string): name is RuntimeId {
	return (RUNTIME_IDS as readonly string[]).includes(name)
}

export function isTargetId(name: string): name is TargetId {
	return (TARGET_IDS as readonly string[]).includes(name)
}

export function buildCwd(spec: BuildSpec): string {
	return join(appsRoot, spec.app)
}

/** The bundle a size budget applies to. */
export function entryArtifact(spec: BuildSpec): string {
	return spec.expect[0]
}

/** Apps that ship a build spec. */
export function knownBuildApps(): string[] {
	return [...new Set(BUILD_SPECS.map((spec) => spec.app))].sort()
}

/** Apps on disk with no build spec — a new app must not silently skip this tier. */
export function unregisteredBuildApps(): string[] {
	const known = new Set(knownBuildApps())
	return readdirSync(appsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(appsRoot, entry.name, "package.json")))
		.map((entry) => entry.name)
		.filter((app) => !known.has(app))
		.sort()
}

/** Specs pointing at an app that no longer exists. */
export function missingBuildApps(): string[] {
	const onDisk = new Set(
		readdirSync(appsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && existsSync(join(appsRoot, entry.name, "package.json")))
			.map((entry) => entry.name),
	)
	return knownBuildApps().filter((app) => !onDisk.has(app))
}

/* vite's bin, started by the runtime itself: bunx drops BUN_OPTIONS, the honey-source condition a checkout build needs */
const VITE_BIN = join(dirname(createRequire(import.meta.url).resolve("vite/package.json")), "bin/vite.js")

export function buildCommand(spec: BuildSpec, runtime: RuntimeId): string[] {
	const cfg = ["--config", spec.config]
	if (runtime === "bun") {
		return ["bun", "--bun", VITE_BIN, "build", ...cfg]
	}
	return ["node", VITE_BIN, "build", ...cfg]
}
