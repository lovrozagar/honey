/**
 * The build tooling's loaders: user modules (the Vite config, the app) through jiti on any runtime, so `honey
 * generate` reads a TypeScript config on plain Node (H70b); and Effect's JSON Schema converter, when effect is
 * installed, for the documents core generates (core never imports a validator, F2).
 */
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { EffectConverter } from "../schema/to-json-schema.ts"

export type ModuleLoader = (path: string) => Promise<Record<string, unknown>>

export type ModuleLoaderOptions = {
	/** specifiers jiti maps to files, as `sourceAliases` gives them */
	alias?: Record<string, string>
	/** no module cache between loaders: a process that outlives one generation sees edited modules */
	fresh: boolean
	/** the file imports resolve from */
	from: string
}

/** A loader for one generation: each path evaluated at most once, so the app never runs twice. */
export async function createModuleLoader(options: ModuleLoaderOptions): Promise<ModuleLoader> {
	const { createJiti } = await import("jiti")
	const jiti = createJiti(options.from, {
		alias: options.alias,
		fsCache: false,
		interopDefault: true,
		moduleCache: !options.fresh,
	})
	const loaded = new Map<string, Promise<Record<string, unknown>>>()
	return (path) => {
		const abs = resolve(path)
		let mod = loaded.get(abs)
		if (!mod) {
			mod = jiti.import(abs) as Promise<Record<string, unknown>>
			loaded.set(abs, mod)
		}
		return mod
	}
}

/**
 * The package's specifiers mapped to its source, for running honey from source on Node: each export's
 * `honey-source` file under `packageRoot`. Undefined when the package names none.
 */
export function sourceAliases(packageRoot: string): Record<string, string> | undefined {
	const path = join(packageRoot, "package.json")
	if (!existsSync(path)) return undefined
	const pkg = JSON.parse(readFileSync(path, "utf8")) as {
		exports?: Record<string, { "honey-source"?: string } | string>
		name?: string
	}
	const aliases: Record<string, string> = {}
	for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
		const source = typeof target === "object" ? target["honey-source"] : undefined
		if (source && pkg.name) aliases[pkg.name + subpath.slice(1)] = join(packageRoot, source)
	}
	return Object.keys(aliases).length > 0 ? aliases : undefined
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
