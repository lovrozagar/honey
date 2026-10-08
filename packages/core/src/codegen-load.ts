/** Loads user modules (Vite config, app, merge tree) for codegen. Not a package export. */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { HoneyVitePluginConfig } from "./plugin.ts"
import { isCodegenProcess, setCodegenProcess } from "./serve-slot.ts"

export type ModuleLoader = (path: string) => Promise<Record<string, unknown>>

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"

/** True when this module runs from `src/*.ts` rather than the compiled `dist/*.js`. */
export const runningFromSource = import.meta.url.endsWith(".ts")

/**
 * Creates a loader for one generation. Each path is evaluated at most once per loader, so the app
 * is not executed twice. `fresh` drops jiti's module cache between loaders — needed when the
 * process outlives one generation (the Vite plugin without a config file). A process that runs a
 * single generation (the CLI) keeps the cache so shared modules load once.
 *
 * While a module evaluates, `app.serve()` resolves without binding a port.
 */
export async function createModuleLoader(options: { fresh: boolean; from: string }): Promise<ModuleLoader> {
	const { createJiti } = await import("jiti")
	const jiti = createJiti(options.from, {
		alias: sourceAliases(),
		fsCache: false,
		interopDefault: true,
		moduleCache: !options.fresh,
	})
	const loaded = new Map<string, Promise<Record<string, unknown>>>()
	return (path) => {
		const abs = resolve(path)
		let mod = loaded.get(abs)
		if (!mod) {
			mod = withCodegenFlag(() => jiti.import(abs) as Promise<Record<string, unknown>>)
			loaded.set(abs, mod)
		}
		return mod
	}
}

let evaluating = 0
let flagWasSet = false

/* overlapping loads share one flag; a flag the caller set for the whole process stays set */
async function withCodegenFlag<T>(run: () => Promise<T>): Promise<T> {
	if (evaluating++ === 0) {
		flagWasSet = isCodegenProcess()
		setCodegenProcess(true)
	}
	try {
		return await run()
	} finally {
		if (--evaluating === 0 && !flagWasSet) setCodegenProcess(false)
	}
}

/**
 * When honey runs from source under Node (inside this repository), the app's imports of the
 * package must reach the same source, not a `dist/` that may be missing or stale. Bun resolves the
 * `bun` export condition to source on its own; a compiled install needs no alias.
 */
function sourceAliases(): Record<string, string> | undefined {
	if (!runningFromSource || isBun) return undefined
	const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
	const pkgPath = join(pkgRoot, "package.json")
	if (!existsSync(pkgPath)) return undefined
	const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
		exports?: Record<string, { "honey-source"?: string }>
		name?: string
	}
	if (!pkg.name || !pkg.exports) return undefined
	const aliases: Record<string, string> = {}
	for (const [subpath, target] of Object.entries(pkg.exports)) {
		const source = target["honey-source"]
		if (!source) continue
		aliases[pkg.name + subpath.slice(1)] = join(pkgRoot, source)
	}
	return aliases
}

/* ---- Vite config ---- */

export const VITE_CONFIG_FILES = [
	"vite.config.ts",
	"vite.config.mts",
	"vite.config.cts",
	"vite.config.js",
	"vite.config.mjs",
	"vite.config.cjs",
]

export function findViteConfig(cwd: string): string | undefined {
	for (const name of VITE_CONFIG_FILES) {
		const path = join(cwd, name)
		if (existsSync(path)) return path
	}
	return undefined
}

export type ViteConfigEnv = { command: "build" | "serve"; mode: string }

/**
 * Every `honey()` plugin config in a Vite config file, in plugin order. Function-form configs are
 * called with `env`; nested and promised plugin arrays are flattened like Vite does. The config is
 * read off the plugin object, so it works across module instances and runtimes.
 */
export async function loadHoneyPluginConfigs(
	configPath: string,
	load: ModuleLoader,
	env: ViteConfigEnv,
): Promise<HoneyVitePluginConfig[]> {
	const mod = await load(configPath)
	let config: unknown = "default" in mod ? mod.default : mod
	if (typeof config === "function") {
		config = await (config as (env: Record<string, unknown>) => unknown)({
			command: env.command,
			isPreview: false,
			isSsrBuild: false,
			mode: env.mode,
		})
	}
	config = await config
	const plugins = await flattenPlugins((config as { plugins?: unknown } | null | undefined)?.plugins)
	const found: HoneyVitePluginConfig[] = []
	for (const plugin of plugins) {
		const honeyConfig = honeyConfigOf(plugin)
		if (honeyConfig) found.push(honeyConfig)
	}
	return found
}

/** The config a `honey()` plugin object carries, or undefined for any other plugin. */
export function honeyConfigOf(plugin: unknown): HoneyVitePluginConfig | undefined {
	if (plugin === null || typeof plugin !== "object") return undefined
	const p = plugin as { api?: { honeyConfig?: HoneyVitePluginConfig }; name?: unknown }
	return p.name === "honey" ? p.api?.honeyConfig : undefined
}

async function flattenPlugins(value: unknown): Promise<unknown[]> {
	const resolved = await value
	if (!resolved) return []
	if (Array.isArray(resolved)) {
		const out: unknown[] = []
		for (const item of resolved) out.push(...(await flattenPlugins(item)))
		return out
	}
	return [resolved]
}
