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
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** Runtime that executes `vite build`. */
export const RUNTIME_IDS = ["node", "bun"] as const
export type RuntimeId = (typeof RUNTIME_IDS)[number]

/** Deploy target the bundle is produced for — honey/build's `target`. */
export const TARGET_IDS = ["node", "bun", "deno", "cloudflare"] as const
export type TargetId = (typeof TARGET_IDS)[number]

const e2eRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
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
 * Node and bun keep dependencies external, so their bundles are small. Deno and
 * cloudflare bundle everything, which is why they carry the looser ceiling — and why
 * they are the two that regress first when a dynamic import stops being opaque.
 */
const DEFAULT_MAX_GZIP_KB: Record<TargetId, number> = {
	bun: 110,
	cloudflare: 110,
	deno: 110,
	node: 110,
}

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
		maxGzipKb: entry.maxGzipKb?.[target] ?? DEFAULT_MAX_GZIP_KB[target],
		outDirs: [`dist/${target}`],
		runtimes: ALL_RUNTIMES,
		target,
	})),
)

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

export function buildCommand(spec: BuildSpec, runtime: RuntimeId): string[] {
	const cfg = ["--config", spec.config]
	if (runtime === "bun") {
		return ["bunx", "--bun", "vite", "build", ...cfg]
	}
	return ["bunx", "vite", "build", ...cfg]
}
