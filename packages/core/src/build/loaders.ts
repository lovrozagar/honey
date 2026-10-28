/**
 * The build tooling's loaders: user modules (the Vite config, the app) through jiti on Node, so `honey generate`
 * reads a TypeScript config on plain Node (H70b), and through Bun's own import on Bun; and Effect's JSON Schema converter, when effect is
 * installed, for the documents core generates (core never imports a validator, F2).
 */
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { EffectConverter } from "../schema/to-json-schema.ts"

export type ModuleLoader = (path: string) => Promise<Record<string, unknown>>

export type ModuleLoaderOptions = {
	/** no module shared with an earlier fresh loader: a generation's redo pass sees the tree its first pass wrote */
	fresh: boolean
	/** the file imports resolve from */
	from: string
	/** a fresh loader after one that evaluated the project in this process: on Bun it must evict some module */
	reload?: boolean
}

/** Bun's module registry, its ES modules included, keyed by path: what a fresh loader evicts. */
export type ModuleRegistry = Record<string, unknown>

/**
 * A loader for one generation: each path evaluated at most once, so the app never runs twice. Through jiti on Node;
 * on Bun (`registry` is its module registry), Bun's own import: jiti there re-evaluates a module that threw through
 * its Babel, whose stack hook then breaks Bun (bit 20 k-fix).
 */
export async function createModuleLoader(
	options: ModuleLoaderOptions,
	registry = bunRegistry(),
): Promise<ModuleLoader> {
	const evaluate = registry === undefined ? await jitiEvaluator(options) : bunEvaluator(registry, options)
	const loaded = new Map<string, Promise<Record<string, unknown>>>()
	return (path) => {
		const abs = resolve(path)
		let mod = loaded.get(abs)
		if (!mod) {
			mod = evaluate(abs)
			loaded.set(abs, mod)
		}
		return mod
	}
}

function bunRegistry(): ModuleRegistry | undefined {
	return typeof (globalThis as { Bun?: unknown }).Bun === "undefined" ? undefined : createRequire(import.meta.url).cache
}

async function jitiEvaluator(
	options: ModuleLoaderOptions,
): Promise<(path: string) => Promise<Record<string, unknown>>> {
	const { createJiti } = await import("jiti")
	const jiti = createJiti(options.from, { fsCache: false, interopDefault: true, moduleCache: !options.fresh })
	return (path) => jiti.import(path) as Promise<Record<string, unknown>>
}

function bunEvaluator(
	registry: ModuleRegistry,
	options: ModuleLoaderOptions,
): (path: string) => Promise<Record<string, unknown>> {
	/* Bun keeps a module for the process: evicted, the next import evaluates it anew. Every module outside
	 * node_modules goes, what a user may have edited or a generation written (a gateway's tree) */
	const evicted = options.fresh ? Object.keys(registry).filter((key) => !/[\\/]node_modules[\\/]/.test(key)) : []
	for (const key of evicted) delete registry[key]
	/* a registry keyed otherwise than this reads (a Bun upgrade) leaves a reload the stale graph: said, not served */
	if (options.reload === true && evicted.length === 0)
		throw new Error("Bun's module registry held none of the project's modules to evict: a reload would read them stale")
	return (path) => import(pathToFileURL(path).href) as Promise<Record<string, unknown>>
}

export const VITE_CONFIG_FILES: readonly string[] = [
	"vite.config.ts",
	"vite.config.mts",
	"vite.config.cts",
	"vite.config.js",
	"vite.config.mjs",
	"vite.config.cjs",
]

/** The Vite config file in `cwd`, by Vite's own order; undefined when there is none. */
export function findViteConfig(cwd: string): string | undefined {
	return VITE_CONFIG_FILES.map((name) => join(cwd, name)).find((path) => existsSync(path))
}

export type ViteConfigEnv = { command: "build" | "serve"; mode: string }

/**
 * The config each `honey()` plugin in a Vite config file carries, in plugin order: a function-form config is called
 * with `env`, and nested and promised plugin arrays flatten as Vite flattens them. Read off the plugin object (its
 * name `honey`, its `api.honeyConfig`), so it holds across module instances and runtimes.
 */
export async function loadPluginConfigs<T>(configPath: string, load: ModuleLoader, env: ViteConfigEnv): Promise<T[]> {
	const mod = await load(configPath)
	let config: unknown = "default" in mod ? mod.default : mod
	if (typeof config === "function") {
		config = (config as (env: object) => unknown)({ ...env, isPreview: false, isSsrBuild: false })
	}
	const plugins = await flattened((await config) as { plugins?: unknown } | null | undefined)
	return plugins.flatMap((plugin) => {
		const p = plugin as { api?: { honeyConfig?: T }; name?: unknown } | null
		return p?.name === "honey" && p.api?.honeyConfig !== undefined ? [p.api.honeyConfig] : []
	})
}

async function flattened(config: { plugins?: unknown } | null | undefined): Promise<unknown[]> {
	const flat = async (value: unknown): Promise<unknown[]> => {
		const resolved = await value
		if (Array.isArray(resolved)) return (await Promise.all(resolved.map(flat))).flat()
		return resolved ? [resolved] : []
	}
	return flat(config?.plugins)
}

/** Effect's `JSONSchema.make` for core's converters, when effect is installed; else undefined. */
export async function effectConverter(specifier = ["eff", "ect"].join("")): Promise<EffectConverter | undefined> {
	try {
		/* an opaque specifier: a literal one is folded into a Worker bundle, pulling the optional dependency in */
		const effect = (await import(specifier)) as { JSONSchema?: { make?: unknown } }
		const make = effect.JSONSchema?.make
		return typeof make === "function" ? (make as EffectConverter) : undefined
	} catch {
		/* effect is not installed: core then documents each Effect schema unconstrained and reports it */
		return undefined
	}
}
