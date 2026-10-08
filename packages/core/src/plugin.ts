import { readFileSync } from "node:fs"
import { dirname, resolve, sep } from "node:path"
import { createModuleLoader, honeyConfigOf, type ModuleLoader } from "./codegen-load.ts"
import {
	generateManifest,
	generateOpenApi,
	generateRouteTree,
	generateRouteTreeFromApp,
	generateRouteTreeFromRouteTree,
	generateTypes,
	prepareCodegen,
	sanitizeOpenApiSpec,
} from "./codegen.ts"
import type { OpenApiRouteInfo, OpenApiSanitizeOptions, OpenApiSpecInput } from "./codegen.ts"
import type { Honey } from "./index.ts"
import type { InvalidateCheckConfig } from "./invalidate-check.ts"
import { detectFeaturesInSource, featurePrelude, importsFeatureEntry } from "./feature-detect.ts"
import { runCli } from "./gen-process.ts"
import { writeGenFile, writeGenJsonFile, writeGenYamlFile, writeOutputDir } from "./gen-write.ts"
import { matchesGlob } from "./glob.ts"
import { overlaySchemas } from "./tree.ts"
import type { ExtractedChainTypes } from "./type-extractor.ts"
import { toYaml, yamlSiblingPath } from "./yaml.ts"

export type { InvalidateCheckConfig, InvalidateCheckLevel } from "./invalidate-check.ts"

/* ---- generateFromApp (standalone utility) ---- */

type HoneyPluginOptions = {
	manifest?: { output: string }
	openApi?: {
		info: { description?: string; title: string; version: string }
		output: string
	}
}

type GeneratedArtifacts = {
	manifest?: string
	openApi?: string
	openApiYaml?: string
	routeTree: string
}

export async function generateFromApp<
	TEnv,
	TCtx,
	TRoutes,
	TMeta,
	TFactory,
	TDefaults extends string,
	TBase extends string,
>(
	app: Honey<TEnv, TCtx, TRoutes, TMeta, TFactory, TDefaults, TBase>,
	options?: HoneyPluginOptions,
): Promise<GeneratedArtifacts> {
	const host = app as unknown as Honey<TEnv, TCtx, unknown, unknown, unknown, string, string>
	const artifacts: GeneratedArtifacts = {
		routeTree: generateRouteTreeFromApp(host),
	}

	if (options?.manifest) {
		const manifest = generateManifest(host)
		artifacts.manifest = JSON.stringify(manifest, null, 2)
	}

	if (options?.openApi) {
		const spec = await generateOpenApi(host, { info: options.openApi.info })
		artifacts.openApi = JSON.stringify(spec, null, 2)
		artifacts.openApiYaml = toYaml(spec)
	}

	return artifacts
}

/* ---- Config types ---- */

export interface HoneyOpenApiOutputConfig {
	description?: string
	filterRoutes?: (route: OpenApiRouteInfo) => boolean
	path?: string
	/** Named metaSpec profile selecting which emitted keys this document carries */
	profile?: string
	sanitize?: OpenApiSanitizeOptions
	securitySchemes?: Record<string, unknown>
	title: string
	version: string
}

export interface HoneyGoCliConfig {
	binaryName: string
	configName?: string
	defaultBaseURL?: string
	envPrefix?: string
	modulePath?: string
	out: string
	sdkModulePath?: string
}

export interface HoneySdkPortsConfig {
	go?: { modulePath?: string; outDir: string }
	python?: { outDir: string }
	rust?: { crateName?: string; outDir: string }
	typescript?: boolean | { outDir?: string }
}

export interface HoneyCodegenConfig {
	cli?: boolean | HoneyGoCliConfig
	/**
	 * Report mutations that declare no `invalidate` — it drives generated SDK invalidation, so a
	 * gap means clients refresh nothing after the call. Default `"warn"`. Applies to the first
	 * openApi document only, so emitting several does not repeat the same report.
	 */
	invalidate?: InvalidateCheckConfig
	manifest?: boolean | string
	mergeTree?: string
	openApi?: HoneyOpenApiOutputConfig | HoneyOpenApiOutputConfig[]
	sdk?: boolean | { name?: string; ports?: HoneySdkPortsConfig; specs?: string[] }
	tree?: boolean | string
	types?: boolean | string | { baseCtxName?: string; path?: string }
}

export interface HoneyVitePluginConfig {
	app?: string
	codegen?: HoneyCodegenConfig
	watch?: string[]
}

/* ---- Resolved config ---- */

export type ResolvedOpenApiOutput = {
	description?: string
	filterRoutes?: (route: OpenApiRouteInfo) => boolean
	path: string
	/** Named metaSpec profile selecting which emitted keys this document carries */
	profile?: string
	sanitize?: OpenApiSanitizeOptions
	securitySchemes?: Record<string, unknown>
	title: string
	version: string
}

export type ResolvedGoCliConfig = {
	binaryName: string
	configName: string | undefined
	defaultBaseURL: string | undefined
	envPrefix: string | undefined
	modulePath: string | undefined
	out: string
	sdkModulePath: string | undefined
}

export type ResolvedSdkPorts = {
	go?: { modulePath: string | undefined; outDir: string }
	python?: { outDir: string }
	rust?: { crateName: string | undefined; outDir: string }
	typescript?: { outDir: string }
}

export type ResolvedInvalidateCheck = InvalidateCheckConfig | undefined

export interface ResolvedHoneyConfig {
	app?: string
	codegen: {
		cli: false | ResolvedGoCliConfig
		invalidate: ResolvedInvalidateCheck
		manifest: false | string
		mergeTree: string | undefined
		openApi: false | ResolvedOpenApiOutput[]
		sdk: false | { name: string; ports: ResolvedSdkPorts; specs?: string[] }
		tree: false | string
		types: false | { baseCtxName: string | undefined; path: string }
	}
	watch: string[]
}

export function resolveHoneyConfig(raw: HoneyVitePluginConfig): ResolvedHoneyConfig {
	const c = raw.codegen

	const resolvePathFlag = (
		val: boolean | string | undefined,
		defaultPath: string,
		defaultEnabled: boolean,
	): false | string => {
		if (val === false) return false
		if (val === true || (val === undefined && defaultEnabled)) return defaultPath
		if (typeof val === "string") return val
		return false
	}

	let types: false | { baseCtxName: string | undefined; path: string } = false
	if (c?.types !== undefined && c.types !== false) {
		if (typeof c.types === "string") {
			types = { baseCtxName: undefined, path: c.types }
		} else if (c.types === true) {
			types = { baseCtxName: undefined, path: "src/_gen/types.gen.d.ts" }
		} else {
			types = {
				baseCtxName: c.types.baseCtxName,
				path: c.types.path ?? "src/_gen/types.gen.d.ts",
			}
		}
	}

	let sdk: false | { name: string; ports: ResolvedSdkPorts; specs?: string[] } = false
	if (c?.sdk !== undefined && c.sdk !== false) {
		if (typeof c.sdk === "string") {
			throw new Error("codegen.sdk string form removed — pass object { name?, specs?, ports }")
		}
		if (c.sdk === true) {
			sdk = { name: "SDK", ports: { typescript: { outDir: "src/_gen" } } }
		} else {
			const rawPorts = c.sdk.ports ?? { typescript: true }
			const ports: ResolvedSdkPorts = {}
			if (rawPorts.typescript !== undefined && rawPorts.typescript !== false) {
				if (rawPorts.typescript === true) {
					ports.typescript = { outDir: "src/_gen" }
				} else {
					ports.typescript = { outDir: rawPorts.typescript.outDir ?? "src/_gen" }
				}
			}
			if (rawPorts.python) {
				ports.python = { outDir: rawPorts.python.outDir }
			}
			if (rawPorts.go) {
				ports.go = { modulePath: rawPorts.go.modulePath, outDir: rawPorts.go.outDir }
			}
			if (rawPorts.rust) {
				ports.rust = { crateName: rawPorts.rust.crateName, outDir: rawPorts.rust.outDir }
			}
			sdk = {
				name: c.sdk.name ?? "SDK",
				ports,
				specs: c.sdk.specs,
			}
		}
	}

	let openApi: false | ResolvedOpenApiOutput[] = false
	if (c?.openApi) {
		const entries = Array.isArray(c.openApi) ? c.openApi : [c.openApi]
		openApi = entries.map((entry) => ({
			description: entry.description,
			filterRoutes: entry.filterRoutes,
			path: entry.path ?? "src/_gen/openapi.gen.json",
			profile: entry.profile,
			sanitize: entry.sanitize,
			securitySchemes: entry.securitySchemes,
			title: entry.title,
			version: entry.version,
		}))
	}

	let cli: false | ResolvedGoCliConfig = false
	if (c?.cli !== undefined && c.cli !== false) {
		if (c.cli === true) {
			throw new Error("codegen.cli=true requires `out` and `binaryName` — pass an object { out, binaryName }")
		}
		if (!c.cli.out || !c.cli.binaryName) {
			throw new Error("codegen.cli requires `out` and `binaryName`")
		}
		cli = {
			binaryName: c.cli.binaryName,
			configName: c.cli.configName,
			defaultBaseURL: c.cli.defaultBaseURL,
			envPrefix: c.cli.envPrefix,
			modulePath: c.cli.modulePath,
			out: c.cli.out,
			sdkModulePath: c.cli.sdkModulePath,
		}
	}

	return {
		app: raw.app,
		codegen: {
			cli,
			invalidate: c?.invalidate,
			manifest: resolvePathFlag(c?.manifest, "src/_gen/manifest.gen.json", false),
			mergeTree: c?.mergeTree,
			openApi,
			sdk,
			tree: resolvePathFlag(c?.tree, "src/_gen/routes.gen.ts", true),
			types,
		},
		watch: raw.watch ?? [],
	}
}

/* ---- Config stash ---- */

let _lastConfig: HoneyVitePluginConfig | undefined

/**
 * Config of the most recent `honey()` call in this module instance.
 * @deprecated Read the config off the plugin object (`plugin.api.honeyConfig`); this is a single
 * global and does not survive a second module instance.
 */
export function getLastHoneyConfig(): HoneyVitePluginConfig | undefined {
	return _lastConfig
}

/* ---- Outputs ---- */

const TS_SDK_FILES = [
	"sdk.types.gen.ts",
	"sdk.map.gen.ts",
	"sdk.client.gen.ts",
	"sdk.index.gen.ts",
	"sdk.runtime.gen.ts",
]

/** Every file and directory a generation writes, as absolute paths. Watchers must ignore these. */
export function generatedOutputs(config: ResolvedHoneyConfig, root: string): { dirs: string[]; files: string[] } {
	const cg = config.codegen
	const files: string[] = []
	const dirs: string[] = []
	if (cg.tree) files.push(resolve(root, cg.tree))
	if (cg.types) files.push(resolve(root, cg.types.path))
	if (cg.manifest) files.push(resolve(root, cg.manifest))
	for (const entry of cg.openApi || []) {
		const json = resolve(root, entry.path)
		files.push(json, yamlSiblingPath(json))
	}
	if (cg.sdk) {
		const ports = cg.sdk.ports
		if (ports.typescript) {
			const outDir = resolve(root, ports.typescript.outDir)
			files.push(...TS_SDK_FILES.map((name) => resolve(outDir, name)))
		}
		if (ports.python) dirs.push(resolve(root, ports.python.outDir))
		if (ports.go) dirs.push(resolve(root, ports.go.outDir))
		if (ports.rust) dirs.push(resolve(root, ports.rust.outDir))
	}
	if (cg.cli) dirs.push(resolve(root, cg.cli.out))
	return { dirs, files }
}

export function isGeneratedOutput(file: string, outputs: { dirs: string[]; files: string[] }): boolean {
	const abs = resolve(file)
	if (outputs.files.includes(abs)) return true
	return outputs.dirs.some((dir) => abs === dir || abs.startsWith(dir + sep))
}

/* ---- Loaders ---- */

type HoneyApp = Honey<unknown, unknown, unknown, unknown, unknown, string, string>
type TreeResult = { root: import("./tree.ts").TreeNode }

async function loadAppOrTree(load: ModuleLoader, entryPath: string): Promise<unknown> {
	const mod = await load(entryPath)

	/* prefer named exports, then unwrap interop default */
	if (mod.app && isHoneyApp(mod.app)) return mod.app
	if (mod.tree && isRouteTree(mod.tree)) return mod.tree
	if (mod.default) {
		const def = mod.default as Record<string, unknown>
		/* interopDefault may wrap: { default: { app: Honey } } */
		if (isHoneyApp(def)) return def
		if (isRouteTree(def)) return def
		if (def.app && isHoneyApp(def.app)) return def.app
		if (def.tree && isRouteTree(def.tree)) return def.tree
	}
	return undefined
}

function isHoneyApp(val: unknown): val is HoneyApp {
	if (val === null || typeof val !== "object") return false
	return typeof (val as Record<string, unknown>).fetch === "function"
}

function isRouteTree(val: unknown): val is TreeResult {
	if (val === null || typeof val !== "object") return false
	const obj = val as Record<string, unknown>
	return obj.root !== undefined && typeof obj.root === "object"
}

/* ---- Generation ---- */

export type GenerateOptions = {
	/**
	 * Loads the app, merge tree and type sources. Defaults to a fresh jiti loader per call. Modules
	 * imported transitively may still come from the runtime's cache under Bun — run generation in
	 * its own process (`honey generate`) when that matters.
	 */
	load?: ModuleLoader
}

export async function generateAndWrite(
	config: ResolvedHoneyConfig,
	root: string,
	options: GenerateOptions = {},
): Promise<void> {
	await prepareCodegen()
	const cg = config.codegen
	const load = options.load ?? (await createModuleLoader({ fresh: true, from: resolve(root, "index.ts") }))

	/* phase 1: route tree — from mergeTree source or app */
	let mergeSource: TreeResult | undefined
	if (cg.tree && (cg.mergeTree || config.app)) {
		const treeSrc = resolve(root, cg.mergeTree ?? config.app ?? "")
		const exported = await loadAppOrTree(load, treeSrc)

		let treeCode: string
		if (isHoneyApp(exported)) {
			treeCode = generateRouteTreeFromApp(exported)
		} else if (isRouteTree(exported)) {
			treeCode = generateRouteTreeFromRouteTree(exported)
			mergeSource = exported
		} else {
			throw new Error(`Expected Honey app or RouteTree default export in ${treeSrc}`)
		}

		writeGenFile(resolve(root, cg.tree), treeCode, "honey")
	} else if (cg.mergeTree && cg.openApi) {
		const exported = await loadAppOrTree(load, resolve(root, cg.mergeTree))
		if (isRouteTree(exported)) mergeSource = exported
	}

	/* phase 2: types, manifest, openapi, sdk, cli — app needed unless sdk has specs */
	const sdkHasSpecs = cg.sdk && cg.sdk.specs && cg.sdk.specs.length > 0
	const needsApp = cg.types || cg.manifest || cg.openApi || (cg.sdk && !sdkHasSpecs) || cg.cli

	let app: HoneyApp | undefined
	let appPath: string | undefined
	if (needsApp) {
		if (!config.app) {
			throw new Error("No app configured — required for types/manifest/openapi/sdk without specs/cli")
		}
		appPath = resolve(root, config.app)
		/* the loader evaluates each file once, so the tree pass above did not cost a second load */
		const appExported = await loadAppOrTree(load, appPath)
		if (!isHoneyApp(appExported)) {
			throw new Error(`Expected Honey app default export in ${appPath}`)
		}
		app = appExported
		/* the app serves the intern tree (no schemas); document merged routes from their source */
		if (mergeSource) overlaySchemas(app.toRouteTree().root, mergeSource.root)
	}

	/* manifest */
	if (cg.manifest) {
		if (!app) throw new Error("Manifest generation requires a configured app")
		const manifest = generateManifest(app)
		writeGenJsonFile(resolve(root, cg.manifest), manifest, "honey")
	}

	/* openapi */
	if (cg.openApi) {
		if (!app) throw new Error("OpenAPI generation requires a configured app")
		for (const entry of cg.openApi) {
			let spec = await generateOpenApi(app, {
				filterRoutes: entry.filterRoutes,
				info: {
					description: entry.description,
					title: entry.title,
					version: entry.version,
				},
				/* one report per generate, not one per emitted document */
				invalidate: entry === cg.openApi[0] ? cg.invalidate : "off",
				profile: entry.profile,
				securitySchemes: entry.securitySchemes,
			})
			if (entry.sanitize) {
				spec = sanitizeOpenApiSpec(spec, entry.sanitize)
			}
			const jsonPath = resolve(root, entry.path)
			writeGenJsonFile(jsonPath, spec, "honey")
			writeGenYamlFile(yamlSiblingPath(jsonPath), spec, "honey")
		}
	}

	/* types */
	if (cg.types) {
		const typesPath = resolve(root, cg.types.path)
		const typesDir = dirname(typesPath)

		if (!appPath) {
			throw new Error("Type generation requires a configured app")
		}
		const { extractChainTypes } = await import("./type-extractor.ts").catch(() => {
			throw new Error('Type generation requires "ts-morph" — install it as a dev dependency')
		})

		/* prefer appBase (middleware-only, simpler type) over app (with routes) */
		const appModule = await load(appPath)
		const exportName = "appBase" in appModule ? "appBase" : "app"
		const extracted: ExtractedChainTypes = await extractChainTypes({
			entryPath: appPath,
			exportName,
			outputDir: typesDir,
		})

		if (!app) throw new Error("Type generation requires a configured app")
		const typesCode = generateTypes(app, {
			baseCtxName: cg.types.baseCtxName,
			inlineEnvType: extracted.base.envType,
			inlineMiddlewareType: extracted.base.middlewareType,
			inlineTapsType: extracted.base.tapsType,
			routeMiddleware: extracted.routeMiddleware,
			routeMiddlewareProps: extracted.routeMiddlewareProps,
		})
		writeGenFile(typesPath, typesCode, "honey")
	}

	/* sdk */
	if (cg.sdk) {
		const { generateOpenApi: genOA, generateSDK: genSDK, mergeSpecs } = await import("./codegen.ts")

		let spec: OpenApiSpecInput
		if (cg.sdk.specs && cg.sdk.specs.length > 0) {
			const specs = cg.sdk.specs.map((s) => {
				const abs = resolve(root, s)
				return JSON.parse(readFileSync(abs, "utf-8")) as OpenApiSpecInput
			})
			spec = mergeSpecs(...specs)
		} else {
			if (!app) throw new Error("SDK generation requires a configured app or specs")
			const primaryOA = cg.openApi && cg.openApi.length > 0 ? cg.openApi[0] : null
			const info = primaryOA
				? { title: primaryOA.title, version: primaryOA.version }
				: { title: "API", version: "1.0.0" }
			spec = await genOA(app, { info })
		}

		const ports = cg.sdk.ports

		if (ports.typescript) {
			const tsOutDir = resolve(root, ports.typescript.outDir)
			const { files } = genSDK(spec, { name: cg.sdk.name, stem: "sdk" })
			writeGenFile(resolve(tsOutDir, "sdk.types.gen.ts"), files.types, "honey")
			writeGenFile(resolve(tsOutDir, "sdk.map.gen.ts"), files.map, "honey")
			writeGenFile(resolve(tsOutDir, "sdk.client.gen.ts"), files.client, "honey")
			writeGenFile(resolve(tsOutDir, "sdk.index.gen.ts"), files.index, "honey")
			if (files.runtime) {
				writeGenFile(resolve(tsOutDir, "sdk.runtime.gen.ts"), files.runtime, "honey")
			}
		}

		if (ports.python) {
			const { generatePythonSDK } = await import("./codegen-python.ts")
			const { files } = generatePythonSDK(spec, { name: cg.sdk.name })
			writeOutputDir(resolve(root, ports.python.outDir), files)
		}

		if (ports.go) {
			const { generateGoSDK } = await import("./codegen-go.ts")
			const { files } = generateGoSDK(spec, { modulePath: ports.go.modulePath })
			writeOutputDir(resolve(root, ports.go.outDir), files)
		}

		if (ports.rust) {
			const { generateRustSDK } = await import("./codegen-rust.ts")
			const { files } = generateRustSDK(spec, { crateName: ports.rust.crateName })
			writeOutputDir(resolve(root, ports.rust.outDir), files)
		}
	}

	/* cli */
	if (cg.cli) {
		const { generateGoCLI } = await import("./codegen-go-cli.ts")

		const primaryOA = cg.openApi && cg.openApi.length > 0 ? cg.openApi[0] : null
		const info = primaryOA ? { title: primaryOA.title, version: primaryOA.version } : { title: "API", version: "1.0.0" }
		if (!app) throw new Error("CLI generation requires a configured app")
		const spec = await generateOpenApi(app, { info })

		const { files } = generateGoCLI(spec, {
			binaryName: cg.cli.binaryName,
			configName: cg.cli.configName,
			defaultBaseURL: cg.cli.defaultBaseURL,
			envPrefix: cg.cli.envPrefix,
			modulePath: cg.cli.modulePath,
			sdkModulePath: cg.cli.sdkModulePath,
		})
		writeOutputDir(resolve(root, cg.cli.out), files)
	}
}

/* ---- Vite plugin ---- */

const VIRTUAL_ROUTES = "virtual:honey/routes"
const VIRTUAL_MANIFEST = "virtual:honey/manifest"
const VIRTUAL_OPENAPI = "virtual:honey/openapi"
const RESOLVED_ROUTES = `\0${VIRTUAL_ROUTES}`
const RESOLVED_MANIFEST = `\0${VIRTUAL_MANIFEST}`
const RESOLVED_OPENAPI = `\0${VIRTUAL_OPENAPI}`

/** Generated files carry these markers; a save of one must never trigger another generation. */
const GEN_FILE_RE = /(^|[/\\])_gen[/\\]|\.gen\.(tsx?|json|ya?ml|d\.ts)$/

type ModuleGraphLike = { getModuleById(id: string): unknown }

type PluginThis = {
	environment?: { config?: { consumer?: string }; moduleGraph?: ModuleGraphLike }
}

type ResolvedViteConfigLike = {
	command?: "build" | "serve"
	configFile?: string
	mode?: string
	plugins?: readonly unknown[]
	root: string
}

type HotUpdateContext = {
	file: string
	modules: unknown[]
	server: { moduleGraph: ModuleGraphLike }
	timestamp?: number
}

/* the route tree codegen emits TypeScript; a virtual module must be JavaScript in dev */
async function toJavaScript(code: string): Promise<{ code: string; moduleType: string }> {
	try {
		const vite = (await import("vite")) as {
			transformWithOxc?: (code: string, file: string, options: Record<string, unknown>) => Promise<{ code: string }>
		}
		if (vite.transformWithOxc) {
			const out = await vite.transformWithOxc(code, "routes.gen.ts", { lang: "ts", sourcemap: false })
			return { code: out.code, moduleType: "js" }
		}
	} catch {
		/* no Vite 8 transform available — let the bundler strip types */
	}
	return { code, moduleType: "ts" }
}

export function honey(config: HoneyVitePluginConfig) {
	_lastConfig = config

	const resolved = resolveHoneyConfig(config)
	const watchPatterns = config.watch ?? []

	let root = ""
	let configFile: string | undefined
	let pluginIndex = -1
	let command: "build" | "serve" = "build"
	let mode = "production"
	let outputs: { dirs: string[]; files: string[] } = { dirs: [], files: [] }

	/* one generation at a time; any request during a run schedules exactly one more */
	let running: Promise<void> | undefined
	let rerun: Promise<void> | undefined
	const savesSeen = new Map<string, Promise<void>>()

	async function generateOnce(): Promise<void> {
		if (configFile && pluginIndex >= 0) {
			/* a child process: fresh module graph, and the app's side effects die with it */
			await runCli(["generate", "--config", configFile, "--plugin", String(pluginIndex)], {
				cwd: root,
				env: { HONEY_VITE_COMMAND: command, HONEY_VITE_MODE: mode },
			})
			return
		}
		await generateAndWrite(resolved, root)
	}

	function regenerate(): Promise<void> {
		if (!running) {
			running = generateOnce().finally(() => {
				running = undefined
			})
			return running
		}
		if (!rerun) {
			rerun = running
				.catch(() => undefined)
				.then(() => {
					rerun = undefined
					return regenerate()
				})
		}
		return rerun
	}

	const plugin = {
		/** Read by `honey generate` to find this plugin's config in a loaded Vite config. */
		api: { honeyConfig: config },

		async buildStart() {
			await regenerate()
		},

		configResolved(cfg: ResolvedViteConfigLike) {
			root = cfg.root
			configFile = cfg.configFile
			command = cfg.command ?? "build"
			mode = cfg.mode ?? (command === "serve" ? "development" : "production")
			outputs = generatedOutputs(resolved, root)
			const honeyPlugins = (cfg.plugins ?? []).filter((p) => honeyConfigOf(p) !== undefined)
			pluginIndex = honeyPlugins.findIndex((p) => p === plugin || honeyConfigOf(p) === config)
		},

		/**
		 * Regenerates when a watched file changes, then lets Vite's normal HMR proceed, adding the
		 * virtual route tree to the update. Vite calls this once per environment; the generation
		 * runs once per save.
		 */
		async hotUpdate(this: PluginThis | void, ctx: HotUpdateContext): Promise<unknown[] | undefined> {
			if (watchPatterns.length === 0) return undefined
			if (GEN_FILE_RE.test(ctx.file) || isGeneratedOutput(ctx.file, outputs)) return undefined
			if (!matchesGlob(ctx.file, watchPatterns, root)) return undefined

			const key = `${ctx.file}\0${ctx.timestamp ?? Date.now()}`
			let run = savesSeen.get(key)
			if (!run) {
				run = regenerate().catch((err: unknown) => {
					console.error("honey: generation failed", err)
				})
				savesSeen.set(key, run)
				if (savesSeen.size > 64) savesSeen.delete(savesSeen.keys().next().value as string)
			}
			await run

			const graph = (this && this.environment?.moduleGraph) || ctx.server.moduleGraph
			const routes = graph.getModuleById(RESOLVED_ROUTES)
			if (!routes || ctx.modules.includes(routes)) return undefined
			return [...ctx.modules, routes]
		},

		async load(id: string): Promise<{ code: string; moduleType: string } | undefined> {
			if (id === RESOLVED_ROUTES) {
				if (!resolved.codegen.mergeTree && !config.app) {
					throw new Error("Route tree virtual module requires app or mergeTree")
				}
				const treeSrc = resolved.codegen.mergeTree
					? resolve(root, resolved.codegen.mergeTree)
					: resolve(root, config.app ?? "")
				const load = await createModuleLoader({ fresh: true, from: treeSrc })
				const exported = await loadAppOrTree(load, treeSrc)
				let code: string
				if (isHoneyApp(exported)) {
					code = generateRouteTreeFromApp(exported)
				} else if (isRouteTree(exported)) {
					code = generateRouteTreeFromRouteTree(exported)
				} else {
					throw new Error(`Expected Honey app or RouteTree in ${treeSrc}`)
				}
				return toJavaScript(code)
			}
			if (id === RESOLVED_MANIFEST && resolved.codegen.manifest) {
				if (!config.app) throw new Error("Manifest virtual module requires app")
				const appPath = resolve(root, config.app)
				const exported = await loadAppOrTree(await createModuleLoader({ fresh: true, from: appPath }), appPath)
				if (isHoneyApp(exported)) {
					const manifest = generateManifest(exported)
					return {
						code: `export default ${JSON.stringify(manifest, null, 2)};`,
						moduleType: "js",
					}
				}
			}
			if (id === RESOLVED_OPENAPI && resolved.codegen.openApi) {
				const primary = resolved.codegen.openApi[0] as ResolvedOpenApiOutput
				if (!config.app) throw new Error("OpenAPI virtual module requires app")
				const appPath = resolve(root, config.app)
				const exported = await loadAppOrTree(await createModuleLoader({ fresh: true, from: appPath }), appPath)
				if (isHoneyApp(exported)) {
					let spec = await generateOpenApi(exported, {
						filterRoutes: primary.filterRoutes,
						info: {
							description: primary.description,
							title: primary.title,
							version: primary.version,
						},
						/* generation already reported; a virtual module load must not repeat it */
						invalidate: "off",
						profile: primary.profile,
						securitySchemes: primary.securitySchemes,
					})
					if (primary.sanitize) {
						spec = sanitizeOpenApiSpec(spec, primary.sanitize)
					}
					return {
						code: `export default ${JSON.stringify(spec, null, 2)};`,
						moduleType: "js",
					}
				}
			}
			return undefined
		},

		name: "honey",

		/**
		 * Imports the entries of optional features a module uses, ahead of its code, on the same
		 * line so line numbers stay put. Server environments only: browser code never serves.
		 */
		transform(this: PluginThis | void, code: string, id: string): { code: string; map: null } | undefined {
			if (this && this.environment?.config?.consumer === "client") return undefined
			if (id.includes("\0") || id.includes("node_modules")) return undefined
			const features = [...detectFeaturesInSource(code)].filter((f) => !importsFeatureEntry(code, f))
			if (features.length === 0) return undefined
			const prelude = featurePrelude(features)
			if (code.startsWith("#!")) {
				const eol = code.indexOf("\n")
				if (eol === -1) return { code: `${code}\n${prelude}`, map: null }
				return { code: `${code.slice(0, eol + 1)}${prelude} ${code.slice(eol + 1)}`, map: null }
			}
			return { code: `${prelude} ${code}`, map: null }
		},

		resolveId(id: string): string | undefined {
			if (id === VIRTUAL_ROUTES) return RESOLVED_ROUTES
			if (id === VIRTUAL_MANIFEST && resolved.codegen.manifest) return RESOLVED_MANIFEST
			if (id === VIRTUAL_OPENAPI && resolved.codegen.openApi) return RESOLVED_OPENAPI
			return undefined
		},
	}

	return [plugin]
}

export { generateRouteTree }
