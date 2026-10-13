import { existsSync, readFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { extname, resolve } from "node:path"
import { detectFeaturesInSource, FEATURES, featurePrelude, type HoneyFeature, scanProgram } from "../feature-detect.ts"

/* ---- Public types ---- */

export type HoneyBuildConfig = {
	external?: string[]
	/**
	 * Force optional features on or off. Unset features are detected by scanning the app's
	 * import graph for `.openapi()` / `.manifest()`, `.errorI18n()` and `.serve()` calls.
	 */
	features?: Partial<Record<HoneyFeature, boolean>>
	minify?: boolean
	outDir?: string
	port?: number
	target: "bun" | "cloudflare" | "deno" | "node"
}

/* ---- Internal types ---- */

type ResolvedBuildConfig = {
	entry: string
	export: string
	port: number
}

type BuildAdapterDef = {
	entry(config: ResolvedBuildConfig): string
	/** Bundle every dependency. Workers have no node_modules at run time. */
	noExternal: boolean
	/** Features the target can never use. */
	skipFeatures: HoneyFeature[]
	ssrTarget: "node" | "webworker"
}

/* ---- Entry helpers ---- */

function importApp(entry: string, exportName: string): string {
	if (exportName === "default") return `import app from "./${entry}"`
	return `import { ${exportName} as app } from "./${entry}"`
}

/* server targets start through the same code path as `app.serve()`: WS adapter, env, hostname */
function serverEntry(config: ResolvedBuildConfig, runtime: "bun" | "deno" | "node", env: string, port: string): string {
	return [
		'import { startHoneyServer } from "@lovrozagar/honey/serve"',
		importApp(config.entry, config.export),
		"",
		`const port = Number(${port})`,
		`await startHoneyServer(app, { env: ${env}, hostname: "0.0.0.0", port, runtime: "${runtime}" })`,
	].join("\n")
}

/* ---- Adapter definitions ---- */

const adapters: Record<HoneyBuildConfig["target"], BuildAdapterDef> = {
	bun: {
		entry: (config) => serverEntry(config, "bun", "process.env", `process.env.PORT ?? ${config.port}`),
		noExternal: false,
		skipFeatures: [],
		ssrTarget: "node",
	},
	cloudflare: {
		entry(config) {
			return [
				importApp(config.entry, config.export),
				"",
				"export default {",
				"  fetch: (req, env, ctx) => app.fetch(req, env, ctx),",
				"}",
			].join("\n")
		},
		noExternal: true,
		/* a Worker cannot listen; serve would pull node:http into the bundle */
		skipFeatures: ["serve"],
		ssrTarget: "webworker",
	},
	deno: {
		entry: (config) => serverEntry(config, "deno", "Deno.env.toObject()", `Deno.env.get("PORT") ?? "${config.port}"`),
		noExternal: true,
		skipFeatures: [],
		ssrTarget: "webworker",
	},
	node: {
		entry: (config) => serverEntry(config, "node", "process.env", `process.env.PORT ?? ${config.port}`),
		noExternal: false,
		skipFeatures: [],
		ssrTarget: "node",
	},
}

/* ---- Feature detection over the import graph ---- */

const SCANNED_EXT = /\.(?:[cm]?[jt]sx?)$/

type ParseContext = {
	parse?: (code: string, options?: { lang?: "js" | "jsx" | "ts" | "tsx" }) => unknown
	resolve?: (source: string, importer?: string) => Promise<{ external?: unknown; id: string } | null>
}

function langOf(file: string): "js" | "jsx" | "ts" | "tsx" {
	const ext = extname(file)
	if (ext === ".tsx") return "tsx"
	if (ext === ".jsx") return "jsx"
	return /^\.[cm]?ts$/.test(ext) ? "ts" : "js"
}

/**
 * Walks the app's own modules (never node_modules) from `entry`, following static and dynamic
 * imports, and collects feature calls. Comments and strings do not count.
 */
async function detectGraphFeatures(ctx: ParseContext, entry: string): Promise<Set<HoneyFeature>> {
	const features = new Set<HoneyFeature>()
	const seen = new Set<string>()
	const queue = [entry]
	while (queue.length > 0) {
		const file = queue.pop() as string
		if (seen.has(file)) continue
		seen.add(file)
		if (!SCANNED_EXT.test(file) || file.includes("node_modules") || !existsSync(file)) continue
		const code = readFileSync(file, "utf-8")

		let imports: string[] = []
		let program: unknown
		try {
			program = ctx.parse?.(code, { lang: langOf(file) })
		} catch {
			program = undefined
		}
		if (program) {
			const scanned = scanProgram(program)
			for (const f of scanned.features) features.add(f)
			imports = scanned.imports
		} else {
			for (const f of detectFeaturesInSource(code)) features.add(f)
		}

		if (!ctx.resolve) continue
		for (const source of imports) {
			const resolved = await ctx.resolve(source, file).catch(() => null)
			if (!resolved || resolved.external || resolved.id.startsWith("\0")) continue
			queue.push(resolved.id.split("?")[0] as string)
		}
	}
	return features
}

/* ---- Virtual module constants ---- */

const VIRTUAL_BUILD_ENTRY = "virtual:honey-build-entry"
const RESOLVED_BUILD_ENTRY = `\0${VIRTUAL_BUILD_ENTRY}`

/* ---- Build plugin factory ---- */

export function createBuildPlugin(buildConfig: HoneyBuildConfig, shared: { entry: string; export: string }) {
	const adapter = adapters[buildConfig.target]
	const resolvedConfig: ResolvedBuildConfig = {
		entry: shared.entry,
		export: shared.export,
		port: buildConfig.port ?? 3000,
	}

	let root = ""

	return {
		apply: "build" as const,

		config() {
			return {
				build: {
					emptyOutDir: false,
					minify: buildConfig.minify ?? true,
					outDir: buildConfig.outDir ?? "./dist",
					rolldownOptions: {
						external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`), ...(buildConfig.external ?? [])],
						input: VIRTUAL_BUILD_ENTRY,
						output: { entryFileNames: "index.js" },
					},
					ssr: true,
				},
				ssr: {
					/* node and bun install dependencies next to the bundle; inlining them would also inline native addons */
					...(adapter.noExternal ? { noExternal: true } : {}),
					target: adapter.ssrTarget,
				},
			}
		},

		configResolved(cfg: { root: string }) {
			root = cfg.root
		},

		async load(this: ParseContext | undefined, id: string): Promise<{ code: string; moduleType: string } | undefined> {
			if (id !== RESOLVED_BUILD_ENTRY) return undefined
			const appPath = resolve(root || ".", shared.entry)
			const detected = await detectGraphFeatures(this ?? {}, appPath)
			const features = FEATURES.filter((feature) => {
				if (adapter.skipFeatures.includes(feature)) return false
				return buildConfig.features?.[feature] ?? detected.has(feature)
			})
			const prelude = featurePrelude(features)
			return {
				code: `${prelude ? `${prelude}\n` : ""}${adapter.entry(resolvedConfig)}`,
				moduleType: "js",
			}
		},

		name: "honey:build",

		resolveId(id: string): string | undefined {
			if (id === VIRTUAL_BUILD_ENTRY) return RESOLVED_BUILD_ENTRY
			return undefined
		},
	}
}
