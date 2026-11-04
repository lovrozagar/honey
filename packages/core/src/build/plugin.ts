/**
 * `honeyPlugin()`, the Vite plugin (`@lovrozagar/honey/plugin`, bit 19 h2): it writes the app's artifacts at build start
 * and, in dev, again on each save a `watch` glob matches, one generation at a time with at most one more queued, and
 * one per save across Vite's environments. With a config file, each generation runs in a `honey generate` child, so
 * it sees edits to every module the app imports and nothing the app starts outlives it. `virtual:honey/routes`,
 * `/manifest` and `/openapi` serve the same artifacts in memory. Its config rides on the plugin object
 * (`api.honeyConfig`), where `honey generate` reads it.
 */
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
	generatedOutputs,
	type HoneyVitePluginConfig,
	isGeneratedOutput,
	type ResolvedHoneyConfig,
	resolveHoneyConfig,
} from "./config.ts"
import { generateAndWrite, inAppGraph, loadClients } from "./generate.ts"
import { compileGlobs, WATCH_IGNORE_RE } from "./glob.ts"

export type { HoneyCodegenConfig, HoneyOpenApiOutputConfig, HoneyVitePluginConfig } from "./config.ts"

const VIRTUAL = { manifest: "virtual:honey/manifest", openApi: "virtual:honey/openapi", routes: "virtual:honey/routes" }
/* written out, not built from VIRTUAL: a property read at the top level is a statement a bundler must keep */
const RESOLVED = {
	manifest: "\0virtual:honey/manifest",
	openApi: "\0virtual:honey/openapi",
	routes: "\0virtual:honey/routes",
}

/** The part of Vite's module graph the plugin reads. */
type ModuleGraph = {
	/** The module registered under `id`, or nothing when the graph has none. */
	getModuleById(id: string): unknown
}
/** The part of Vite's resolved config the plugin reads. */
type ResolvedViteConfig = {
	/** `"build"` for a production build, `"serve"` for the dev server; `"build"` when unset. */
	command?: "build" | "serve"
	/** The Vite config file's path, when the project has one; without it, generation runs in this process. */
	configFile?: string
	/** Vite's mode; when unset, `"development"` under `serve` and `"production"` otherwise. */
	mode?: string
	/** Every plugin in the config, used to find this plugin's position among the `honeyPlugin()` ones. */
	plugins?: readonly unknown[]
	/** The project root, which relative `watch` globs and output paths resolve against. */
	root: string
}
/** The part of Vite's hot-update context the plugin reads. */
type HotUpdate = {
	/** The absolute path of the file that changed. */
	file: string
	/** The modules Vite will update for this change. */
	modules: unknown[]
	/** The dev server, whose module graph is the fallback when the call carries no environment. */
	server: {
		/** The dev server's module graph. */
		moduleGraph: ModuleGraph
	}
	/** When the change happened; with `file` it identifies one save across Vite's environments. */
	timestamp?: number
}

/** The plugin object `honeyPlugin()` returns, shaped for Vite. */
export type HoneyVitePlugin = {
	/** Carries the plugin's config so `honey generate` can read it from a loaded Vite config. */
	api: {
		/** The config passed to `honeyPlugin()`, as given. */
		honeyConfig: HoneyVitePluginConfig
	}
	/**
	 * Writes the app's artifacts. A call while an earlier one is generating joins it, so the calls Vite makes back to
	 * back, one per environment, share one generation. Rejects when the generation fails.
	 */
	buildStart(): Promise<void>
	/** Records the command, config file, mode and root that generations run with. */
	configResolved(cfg: ResolvedViteConfig): void
	/**
	 * Regenerates once on a save a `watch` glob matches, generated files never counting, and returns Vite's modules
	 * with the virtual route tree added. Returns nothing when it ignores the file or has no route tree to add. A failed
	 * generation is written to stderr and the update goes on.
	 */
	hotUpdate(this: unknown, ctx: HotUpdate): Promise<unknown[] | undefined>
	/** Serves the `virtual:honey/*` modules from a fresh load of the app; nothing for an unconfigured output or other id. */
	load(id: string): Promise<
		| {
				/** The module's source. */
				code: string
				/** `"js"`, or `"ts"` for the route tree when Vite or its `transformWithOxc` is missing. */
				moduleType: string
		  }
		| undefined
	>
	/** Always `"honey"`. */
	name: string
	/**
	 * Resolves `virtual:honey/routes` always, `virtual:honey/manifest` when a manifest is configured and
	 * `virtual:honey/openapi` when an OpenAPI output is; nothing for any other id.
	 */
	resolveId(id: string): string | undefined
}

/** `honey generate <args>` in a child (core's own bin on this runtime); resolves when it exits 0, rejects otherwise. */
export function runGenerate(
	args: readonly string[],
	options: {
		/** The directory the child runs in. */
		cwd: string
		/** Variables added to the parent's environment for the child. */
		env: NodeJS.ProcessEnv
	},
): Promise<void> {
	const bin = fileURLToPath(new URL("../../bin/honey.js", import.meta.url))
	return new Promise((done, fail) => {
		const child = spawn(process.execPath, [bin, "generate", ...args], {
			cwd: options.cwd,
			env: { ...process.env, ...options.env, HONEY_NO_BUN_HANDOFF: "1" },
			stdio: ["ignore", "inherit", "inherit"],
		})
		child.on("error", fail)
		child.on("exit", (code, signal) =>
			code === 0 ? done() : fail(new Error(`honey generate failed (${signal ?? `exit ${code}`})`)),
		)
	})
}

/** `generate` serialized: one run at a time, and any call during a run joins the one run queued behind it. */
export function serialized(generate: () => Promise<unknown>): () => Promise<unknown> {
	let running: Promise<unknown> | undefined
	let queued: Promise<unknown> | undefined
	const regenerate = (): Promise<unknown> => {
		if (running === undefined) {
			running = generate().finally(() => (running = undefined))
			return running
		}
		queued ??= running
			/* the running generation's failure is its own caller's: the one queued behind it runs regardless */
			.catch(() => undefined)
			.then(() => {
				queued = undefined
				return regenerate()
			})
		return queued
	}
	return regenerate
}

/** How many recent saves a dev server remembers: Vite reports a save once per environment, back to back. */
export const SAVES_REMEMBERED = 64

/** `run` once per key, the last `limit` keys remembered: a call with a remembered key joins its run. */
export function oncePerKey(run: () => Promise<unknown>, limit: number): (key: string) => Promise<unknown> {
	const seen = new Map<string, Promise<unknown>>()
	return (key) => {
		const known = seen.get(key)
		if (known !== undefined) return known
		const started = run()
		seen.set(key, started)
		if (seen.size > limit) seen.delete(seen.keys().next().value as string)
		return started
	}
}

/** The route tree module as JavaScript: a dev server serves a virtual module untransformed. */
export async function toJavaScript(
	code: string,
	vite: () => Promise<unknown> = () => import("vite"),
): Promise<{
	/** The module's source: JavaScript, or the original TypeScript when Vite or its `transformWithOxc` is missing. */
	code: string
	/** `"js"` when transformed, `"ts"` when Vite or its `transformWithOxc` is missing. */
	moduleType: string
}> {
	/* no Vite to transform with: the tree is served as TypeScript, which the bundler strips */
	const loaded = (await vite().catch(() => ({}))) as {
		transformWithOxc?: (code: string, file: string, options: object) => Promise<{ code: string }>
	}
	if (loaded.transformWithOxc === undefined) return { code, moduleType: "ts" }
	return { code: (await loaded.transformWithOxc(code, "routes.gen.ts", { lang: "ts" })).code, moduleType: "js" }
}

/** A virtual module's code, from a fresh load of the app (or a gateway's merge entry); none for any other id. */
async function virtualModule(id: string, config: ResolvedHoneyConfig, root: string) {
	const kind = (Object.keys(RESOLVED) as (keyof typeof RESOLVED)[]).find((key) => RESOLVED[key] === id)
	if (kind === undefined || (kind === "manifest" && config.codegen.manifest === false)) return undefined
	if (kind === "openApi" && config.codegen.openApi.length === 0) return undefined
	const code = await (await inAppGraph(root)).virtualCode(kind, config, { codegen: () => loadClients(), root })
	return kind === "routes" ? toJavaScript(code) : { code, moduleType: "js" }
}

/** Whether `plugin` is one `honeyPlugin()` returned, as `honey generate` finds one. */
const isHoneyPlugin = (plugin: unknown) =>
	(plugin as { name?: unknown } | null)?.name === "honey" &&
	(plugin as { api?: { honeyConfig?: unknown } }).api?.honeyConfig !== undefined

/**
 * The honey Vite plugin: writes the configured artifacts at build start, regenerates them in dev when a watched file
 * changes, and serves `virtual:honey/routes`, plus `virtual:honey/manifest` and `virtual:honey/openapi` (the first
 * OpenAPI output) when configured. Throws on a `codegen.sdk` or `codegen.cli` key, which belong to honey-clients, and
 * on an MCP output path that is not a `.ts` module.
 */
export function honeyPlugin(config: HoneyVitePluginConfig): [HoneyVitePlugin] {
	const resolved = resolveHoneyConfig(config)
	const matchesWatch = compileGlobs(resolved.watch)
	const at = { command: "build" as "build" | "serve", configFile: undefined as string | undefined, index: -1 }
	let [root, mode, outputs] = [process.cwd(), "production", generatedOutputs(resolved, process.cwd())]
	let starting: Promise<unknown> | undefined
	const regenerate = serialized(async () => {
		if (at.configFile === undefined || at.index < 0) return generateAndWrite(resolved, root)
		/* a child: a fresh module graph, and whatever the app starts dies with it */
		return runGenerate(["--config", at.configFile, "--plugin", String(at.index)], {
			cwd: root,
			env: { HONEY_VITE_COMMAND: at.command, HONEY_VITE_MODE: mode },
		})
	})
	const perSave = oncePerKey(
		/* reported on stderr: a failed generation must not stop the dev server's HMR */
		() => regenerate().catch((error: unknown) => process.stderr.write(`honey: generation failed: ${error}\n`)),
		SAVES_REMEMBERED,
	)
	const plugin: HoneyVitePlugin = {
		/** read by `honey generate` to find this plugin's config in a loaded Vite config */
		api: { honeyConfig: config },
		/* Vite calls this once per environment, back to back: the second joins the first's generation */
		async buildStart() {
			starting ??= regenerate().finally(() => (starting = undefined))
			await starting
		},
		configResolved(cfg: ResolvedViteConfig) {
			Object.assign(at, { command: cfg.command ?? "build", configFile: cfg.configFile })
			at.index = (cfg.plugins ?? []).filter(isHoneyPlugin).indexOf(plugin)
			root = cfg.root
			mode = cfg.mode ?? (at.command === "serve" ? "development" : "production")
			outputs = generatedOutputs(resolved, root)
		},
		/** Regenerates on a watched save, then lets HMR go on with the virtual route tree added; once per save. */
		async hotUpdate(this: unknown, ctx: HotUpdate): Promise<unknown[] | undefined> {
			if (WATCH_IGNORE_RE.test(ctx.file) || isGeneratedOutput(ctx.file, outputs)) return undefined
			if (resolved.watch.length === 0 || !matchesWatch(ctx.file, root)) return undefined
			await perSave(`${ctx.file}\0${ctx.timestamp ?? Date.now()}`)
			/* Vite passes the environment as `this`; its graph, else the server's */
			const environment = (this as { environment?: { moduleGraph?: ModuleGraph } } | undefined)?.environment
			const routes = (environment?.moduleGraph ?? ctx.server.moduleGraph).getModuleById(RESOLVED.routes)
			return routes === undefined || routes === null || ctx.modules.includes(routes)
				? undefined
				: [...ctx.modules, routes]
		},
		load: (id: string) => virtualModule(id, resolved, root),
		name: "honey",
		resolveId(id: string): string | undefined {
			if (id === VIRTUAL.routes) return RESOLVED.routes
			if (id === VIRTUAL.manifest && resolved.codegen.manifest !== false) return RESOLVED.manifest
			if (id === VIRTUAL.openApi && resolved.codegen.openApi.length > 0) return RESOLVED.openApi
			return undefined
		},
	}
	return [plugin]
}
