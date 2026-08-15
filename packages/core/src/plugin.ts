import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import {
	generateManifest,
	generateOpenApi,
	generateRouteTree,
	generateRouteTreeFromApp,
	generateRouteTreeFromRouteTree,
	generateTypes,
	prepareCodegen,
	sanitizeOpenApiSpec,
} from "./codegen.ts";
import type { OpenApiRouteInfo, OpenApiSanitizeOptions } from "./codegen.ts";
import type { Honey } from "./index.ts";
import type { ExtractedChainTypes } from "./type-extractor.ts";

/* ---- generateFromApp (standalone utility) ---- */

type HoneyPluginOptions = {
	manifest?: { output: string };
	openApi?: {
		info: { description?: string; title: string; version: string };
		output: string;
	};
};

type GeneratedArtifacts = {
	manifest?: string;
	openApi?: string;
	routeTree: string;
};

export async function generateFromApp<TEnv, TCtx>(
	app: Honey<TEnv, TCtx, unknown, unknown, unknown, string, string>,
	options?: HoneyPluginOptions,
): Promise<GeneratedArtifacts> {
	const artifacts: GeneratedArtifacts = {
		routeTree: generateRouteTreeFromApp(app),
	};

	if (options?.manifest) {
		const manifest = generateManifest(app);
		artifacts.manifest = JSON.stringify(manifest, null, 2);
	}

	if (options?.openApi) {
		const spec = await generateOpenApi(app, { info: options.openApi.info });
		artifacts.openApi = JSON.stringify(spec, null, 2);
	}

	return artifacts;
}

/* ---- Config types ---- */

export interface HoneyOpenApiOutputConfig {
	description?: string
	filterRoutes?: (route: OpenApiRouteInfo) => boolean
	path?: string
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
	go?: { modulePath?: string; outDir: string };
	python?: { outDir: string };
	rust?: { crateName?: string; outDir: string };
	typescript?: boolean | { outDir?: string };
}

export interface HoneyCodegenConfig {
	cli?: boolean | HoneyGoCliConfig;
	manifest?: boolean | string;
	mergeTree?: string;
	openApi?: HoneyOpenApiOutputConfig | HoneyOpenApiOutputConfig[];
	sdk?: boolean | { name?: string; ports?: HoneySdkPortsConfig; specs?: string[] };
	tree?: boolean | string;
	types?: boolean | string | { baseCtxName?: string; path?: string };
}

export interface HoneyVitePluginConfig {
	app?: string;
	codegen?: HoneyCodegenConfig;
	watch?: string[];
}

/* ---- Resolved config ---- */

export type ResolvedOpenApiOutput = {
	description?: string
	filterRoutes?: (route: OpenApiRouteInfo) => boolean
	path: string
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
	go?: { modulePath: string | undefined; outDir: string };
	python?: { outDir: string };
	rust?: { crateName: string | undefined; outDir: string };
	typescript?: { outDir: string };
};

export interface ResolvedHoneyConfig {
	app?: string;
	codegen: {
		cli: false | ResolvedGoCliConfig;
		manifest: false | string;
		mergeTree: string | undefined;
		openApi: false | ResolvedOpenApiOutput[];
		sdk: false | { name: string; ports: ResolvedSdkPorts; specs?: string[] };
		tree: false | string;
		types: false | { baseCtxName: string | undefined; path: string };
	};
	watch: string[];
}

export function resolveHoneyConfig(
	raw: HoneyVitePluginConfig,
): ResolvedHoneyConfig {
	const c = raw.codegen;

	const resolvePathFlag = (
		val: boolean | string | undefined,
		defaultPath: string,
		defaultEnabled: boolean,
	): false | string => {
		if (val === false) return false;
		if (val === true || (val === undefined && defaultEnabled))
			return defaultPath;
		if (typeof val === "string") return val;
		return false;
	};

	let types: false | { baseCtxName: string | undefined; path: string } = false;
	if (c?.types !== undefined && c.types !== false) {
		if (typeof c.types === "string") {
			types = { baseCtxName: undefined, path: c.types };
		} else if (c.types === true) {
			types = { baseCtxName: undefined, path: "src/_gen/types.gen.d.ts" };
		} else {
			types = {
				baseCtxName: c.types.baseCtxName,
				path: c.types.path ?? "src/_gen/types.gen.d.ts",
			};
		}
	}

	let sdk: false | { name: string; ports: ResolvedSdkPorts; specs?: string[] } = false;
	if (c?.sdk !== undefined && c.sdk !== false) {
		if (typeof c.sdk === "string") {
			throw new Error("codegen.sdk string form removed — pass object { name?, specs?, ports }")
		}
		if (c.sdk === true) {
			sdk = { name: "SDK", ports: { typescript: { outDir: "src/_gen" } } };
		} else {
			const rawPorts = c.sdk.ports ?? { typescript: true };
			const ports: ResolvedSdkPorts = {};
			if (rawPorts.typescript !== undefined && rawPorts.typescript !== false) {
				if (rawPorts.typescript === true) {
					ports.typescript = { outDir: "src/_gen" };
				} else {
					ports.typescript = { outDir: rawPorts.typescript.outDir ?? "src/_gen" };
				}
			}
			if (rawPorts.python) {
				ports.python = { outDir: rawPorts.python.outDir };
			}
			if (rawPorts.go) {
				ports.go = { modulePath: rawPorts.go.modulePath, outDir: rawPorts.go.outDir };
			}
			if (rawPorts.rust) {
				ports.rust = { crateName: rawPorts.rust.crateName, outDir: rawPorts.rust.outDir };
			}
			sdk = {
				name: c.sdk.name ?? "SDK",
				ports,
				specs: c.sdk.specs,
			};
		}
	}

	let openApi: false | ResolvedOpenApiOutput[] = false
	if (c?.openApi) {
		const entries = Array.isArray(c.openApi) ? c.openApi : [c.openApi]
		openApi = entries.map((entry) => ({
			description: entry.description,
			filterRoutes: entry.filterRoutes,
			path: entry.path ?? "src/_gen/openapi.gen.json",
			sanitize: entry.sanitize,
			securitySchemes: entry.securitySchemes,
			title: entry.title,
			version: entry.version,
		}))
	}

	let cli: false | ResolvedGoCliConfig = false
	if (c?.cli !== undefined && c.cli !== false) {
		if (c.cli === true) {
			throw new Error(
				"codegen.cli=true requires `out` and `binaryName` — pass an object { out, binaryName }",
			)
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
			manifest: resolvePathFlag(
				c?.manifest,
				"src/_gen/manifest.gen.json",
				false,
			),
			mergeTree: c?.mergeTree,
			openApi,
			sdk,
			tree: resolvePathFlag(c?.tree, "src/_gen/routes.gen.ts", true),
			types,
		},
		watch: raw.watch ?? [],
	};
}

/* ---- Config stash for CLI ---- */

let _lastConfig: HoneyVitePluginConfig | undefined;

export function getLastHoneyConfig(): HoneyVitePluginConfig | undefined {
	return _lastConfig;
}

/* ---- writeGenFile / writeGenJsonFile ---- */

function writeGenFile(filePath: string, body: string, generator: string): boolean {
	const normalized = body.replace(/\n*$/, "\n");
	const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 12);

	const ext = filePath.endsWith(".d.ts") ? ".d.ts" : extname(filePath);
	const header = ext === ".sql"
		? `-- @generated by ${generator} — do not edit. checksum: ${hash}`
		: `/* @generated by ${generator} — do not edit. checksum: ${hash} */`;
	const fullContent = `${header}\n${normalized}`;

	if (existsSync(filePath)) {
		const existing = readFileSync(filePath, "utf-8");
		const firstLine = existing.split("\n")[0] ?? "";
		const match = firstLine.match(/checksum: ([0-9a-f]{12})/);
		if (match?.[1] === hash) return false;
	}

	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, fullContent, "utf-8");
	return true;
}

function writeGenJsonFile(filePath: string, data: unknown, generator: string): boolean {
	const json = JSON.stringify(data, null, 2);
	const hash = createHash("sha256").update(json).digest("hex").slice(0, 12);
	const marker = `${generator} checksum:${hash}`;

	if (existsSync(filePath)) {
		try {
			const existing = readFileSync(filePath, "utf-8");
			const parsed = JSON.parse(existing) as Record<string, unknown>;
			if (parsed._generated === marker) return false;
		} catch {
			/* invalid JSON — proceed to write */
		}
	}

	const output = { _generated: marker, ...(data as Record<string, unknown>) };
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(output, null, 2)}\n`, "utf-8");
	return true;
}

/* ---- Loaders ---- */

type HoneyApp = Honey<
	unknown,
	unknown,
	unknown,
	unknown,
	unknown,
	string,
	string
>;
type TreeResult = { root: import("./tree.ts").TreeNode };

async function loadDefaultWithJiti(entryPath: string): Promise<unknown> {
	const { createJiti } = await import("jiti");
	const jiti = createJiti(entryPath, { interopDefault: true });
	const mod = (await jiti.import(entryPath)) as Record<string, unknown>;

	/* prefer named exports, then unwrap interop default */
	if (mod.app && isHoneyApp(mod.app)) return mod.app;
	if (mod.tree && isRouteTree(mod.tree)) return mod.tree;
	if (mod.default) {
		const def = mod.default as Record<string, unknown>;
		/* interopDefault may wrap: { default: { app: Honey } } */
		if (isHoneyApp(def)) return def;
		if (isRouteTree(def)) return def;
		if (def.app && isHoneyApp(def.app)) return def.app;
		if (def.tree && isRouteTree(def.tree)) return def.tree;
	}
	return undefined;
}

function isHoneyApp(val: unknown): val is HoneyApp {
	if (val === null || typeof val !== "object") return false;
	return typeof (val as Record<string, unknown>).fetch === "function";
}

function isRouteTree(val: unknown): val is TreeResult {
	if (val === null || typeof val !== "object") return false;
	const obj = val as Record<string, unknown>;
	return obj.root !== undefined && typeof obj.root === "object";
}

/* ---- Generation ---- */

export async function generateAndWrite(
	config: ResolvedHoneyConfig,
	root: string,
): Promise<void> {
	await prepareCodegen()
	const cg = config.codegen;

	/* phase 1: route tree — from mergeTree source or app */
	if (cg.tree && (cg.mergeTree || config.app)) {
		const treeSrc = resolve(root, cg.mergeTree ?? config.app ?? "");
		const exported = await loadDefaultWithJiti(treeSrc);

		let treeCode: string;
		if (isHoneyApp(exported)) {
			treeCode = generateRouteTreeFromApp(exported);
		} else if (isRouteTree(exported)) {
			treeCode = generateRouteTreeFromRouteTree(exported);
		} else {
			throw new Error(
				`Expected Honey app or RouteTree default export in ${treeSrc}`,
			);
		}

		writeGenFile(resolve(root, cg.tree), treeCode, "honey");
	}

	/* phase 2: types, manifest, openapi, sdk, cli — app needed unless sdk has specs */
	const sdkHasSpecs = cg.sdk && cg.sdk.specs && cg.sdk.specs.length > 0
	const needsApp = cg.types || cg.manifest || cg.openApi || (cg.sdk && !sdkHasSpecs) || cg.cli;

	let app: unknown
	let appPath: string | undefined
	if (needsApp) {
		if (!config.app) {
			throw new Error("No app configured — required for types/manifest/openapi/sdk without specs/cli")
		}
		appPath = resolve(root, config.app);
		const appExported = await loadDefaultWithJiti(appPath);
		if (!isHoneyApp(appExported)) {
			throw new Error(`Expected Honey app default export in ${appPath}`);
		}
		app = appExported;
	}

	/* manifest */
	if (cg.manifest) {
		const manifest = generateManifest(app);
		writeGenJsonFile(resolve(root, cg.manifest), manifest, "honey");
	}

	/* openapi */
	if (cg.openApi) {
		for (const entry of cg.openApi) {
			let spec = await generateOpenApi(app, {
				filterRoutes: entry.filterRoutes,
				info: {
					description: entry.description,
					title: entry.title,
					version: entry.version,
				},
				securitySchemes: entry.securitySchemes,
			});
			if (entry.sanitize) {
				spec = sanitizeOpenApiSpec(spec, entry.sanitize);
			}
			writeGenJsonFile(resolve(root, entry.path), spec, "honey");
		}
	}

	/* types */
	if (cg.types) {
		const typesPath = resolve(root, cg.types.path);
		const typesDir = dirname(typesPath);

		if (!appPath) {
			throw new Error("Type generation requires a configured app")
		}
		const { extractChainTypes } = await import("./type-extractor.ts").catch(
			() => {
				throw new Error(
					'Type generation requires "ts-morph" — install it as a dev dependency',
				);
			},
		);

		/* prefer appBase (middleware-only, simpler type) over app (with routes) */
		let extracted: ExtractedChainTypes;
		try {
			extracted = await extractChainTypes({
				entryPath: appPath,
				exportName: "appBase",
				outputDir: typesDir,
			});
		} catch {
			extracted = await extractChainTypes({
				entryPath: appPath,
				exportName: "app",
				outputDir: typesDir,
			});
		}

		const typesCode = generateTypes(app, {
			baseCtxName: cg.types.baseCtxName,
			inlineEnvType: extracted.base.envType,
			inlineMiddlewareType: extracted.base.middlewareType,
			inlineTapsType: extracted.base.tapsType,
			routeMiddleware: extracted.routeMiddleware,
			routeMiddlewareProps: extracted.routeMiddlewareProps,
		});
		writeGenFile(typesPath, typesCode, "honey");
	}

	/* sdk */
	if (cg.sdk) {
		const { generateOpenApi: genOA, generateSDK: genSDK, mergeSpecs } = await import(
			"./codegen.ts"
		);

		let spec: Record<string, unknown>
		if (cg.sdk.specs && cg.sdk.specs.length > 0) {
			const specs = cg.sdk.specs.map((s) => {
				const abs = resolve(root, s)
				return JSON.parse(readFileSync(abs, "utf-8"))
			})
			spec = mergeSpecs(...specs)
		} else {
			const primaryOA = cg.openApi && cg.openApi.length > 0 ? cg.openApi[0] : null
			const info = primaryOA
				? { title: primaryOA.title, version: primaryOA.version }
				: { title: "API", version: "1.0.0" };
			spec = await genOA(app, { info });
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
			const outDir = resolve(root, ports.python.outDir)
			for (const [filename, content] of Object.entries(files)) {
				const absPath = resolve(outDir, filename)
				mkdirSync(dirname(absPath), { recursive: true })
				writeFileSync(absPath, content, "utf-8")
			}
		}

		if (ports.go) {
			const { generateGoSDK } = await import("./codegen-go.ts")
			const { files } = generateGoSDK(spec, { modulePath: ports.go.modulePath })
			const outDir = resolve(root, ports.go.outDir)
			for (const [filename, content] of Object.entries(files)) {
				const absPath = resolve(outDir, filename)
				mkdirSync(dirname(absPath), { recursive: true })
				writeFileSync(absPath, content, "utf-8")
			}
		}

		if (ports.rust) {
			const { generateRustSDK } = await import("./codegen-rust.ts")
			const { files } = generateRustSDK(spec, { crateName: ports.rust.crateName })
			const outDir = resolve(root, ports.rust.outDir)
			for (const [relPath, content] of Object.entries(files)) {
				const absPath = resolve(outDir, relPath)
				mkdirSync(dirname(absPath), { recursive: true })
				writeFileSync(absPath, content, "utf-8")
			}
		}
	}

	/* cli */
	if (cg.cli) {
		const { generateGoCLI } = await import("./codegen-go-cli.ts")

		const primaryOA = cg.openApi && cg.openApi.length > 0 ? cg.openApi[0] : null
		const info = primaryOA
			? { title: primaryOA.title, version: primaryOA.version }
			: { title: "API", version: "1.0.0" }
		const spec = await generateOpenApi(app, { info })

		const { files } = generateGoCLI(spec, {
			binaryName: cg.cli.binaryName,
			configName: cg.cli.configName,
			defaultBaseURL: cg.cli.defaultBaseURL,
			envPrefix: cg.cli.envPrefix,
			modulePath: cg.cli.modulePath,
			sdkModulePath: cg.cli.sdkModulePath,
		})

		const outDir = resolve(root, cg.cli.out)
		for (const [relPath, content] of Object.entries(files)) {
			const absPath = resolve(outDir, relPath)
			mkdirSync(dirname(absPath), { recursive: true })
			writeFileSync(absPath, content, "utf-8")
		}
	}
}

/* ---- Vite plugin ---- */

const VIRTUAL_ROUTES = "virtual:honey/routes";
const VIRTUAL_MANIFEST = "virtual:honey/manifest";
const VIRTUAL_OPENAPI = "virtual:honey/openapi";
const RESOLVED_ROUTES = `\0${VIRTUAL_ROUTES}`;
const RESOLVED_MANIFEST = `\0${VIRTUAL_MANIFEST}`;
const RESOLVED_OPENAPI = `\0${VIRTUAL_OPENAPI}`;

function matchesGlob(filePath: string, patterns: string[]): boolean {
	for (const pattern of patterns) {
		const re = pattern
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replace(/\*\*\//g, "(.+/)?")
			.replace(/\*/g, "[^/]*");
		if (new RegExp(`(^|/)${re}$`).test(filePath)) return true;
	}
	return false;
}

export function honey(config: HoneyVitePluginConfig) {
	_lastConfig = config;

	const resolved = resolveHoneyConfig(config);

	let root = "";

	const plugin: {
		buildStart(): Promise<void>;
		configResolved(cfg: { root: string }): void;
		hotUpdate(ctx: {
			file: string;
			modules: unknown[];
			server: {
				moduleGraph: { getModuleById(id: string): unknown };
				reloadModule(mod: unknown): void;
			};
		}): Promise<unknown[] | undefined>;
		load(id: string): Promise<{ code: string; moduleType: string } | undefined>;
		name: string;
		resolveId(id: string): string | undefined;
	} = {
		async buildStart() {
			await generateAndWrite(resolved, root);
		},

		configResolved(cfg: { root: string }) {
			root = cfg.root;
		},

		async hotUpdate(ctx: {
			file: string;
			modules: unknown[];
			server: {
				moduleGraph: { getModuleById(id: string): unknown };
				reloadModule(mod: unknown): void;
			};
		}) {
			const patterns = config.watch;
			if (!patterns || patterns.length === 0) return;
			if (!matchesGlob(ctx.file, patterns)) return;

			await generateAndWrite(resolved, root);

			const mod = ctx.server.moduleGraph.getModuleById(RESOLVED_ROUTES);
			if (mod) {
				ctx.server.reloadModule(mod);
			}
			return [];
		},

		async load(
			id: string,
		): Promise<{ code: string; moduleType: string } | undefined> {
			if (id === RESOLVED_ROUTES) {
				const treeSrc = resolved.codegen.mergeTree
					? resolve(root, resolved.codegen.mergeTree)
					: resolve(root, config.app);
				const exported = await loadDefaultWithJiti(treeSrc);
				let code: string;
				if (isHoneyApp(exported)) {
					code = generateRouteTreeFromApp(exported);
				} else if (isRouteTree(exported)) {
					code = generateRouteTreeFromRouteTree(exported);
				} else {
					throw new Error(`Expected Honey app or RouteTree in ${treeSrc}`);
				}
				return { code, moduleType: "js" };
			}
			if (id === RESOLVED_MANIFEST && resolved.codegen.manifest) {
				const appPath = resolve(root, config.app);
				const exported = await loadDefaultWithJiti(appPath);
				if (isHoneyApp(exported)) {
					const manifest = generateManifest(exported);
					return {
						code: `export default ${JSON.stringify(manifest, null, 2)};`,
						moduleType: "js",
					};
				}
			}
			if (id === RESOLVED_OPENAPI && resolved.codegen.openApi) {
				const primary = resolved.codegen.openApi[0]
				const appPath = resolve(root, config.app);
				const exported = await loadDefaultWithJiti(appPath);
				if (isHoneyApp(exported)) {
					let spec = await generateOpenApi(exported, {
						filterRoutes: primary.filterRoutes,
						info: {
							description: primary.description,
							title: primary.title,
							version: primary.version,
						},
						securitySchemes: primary.securitySchemes,
					});
					if (primary.sanitize) {
						spec = sanitizeOpenApiSpec(spec, primary.sanitize);
					}
					return {
						code: `export default ${JSON.stringify(spec, null, 2)};`,
						moduleType: "js",
					};
				}
			}
			return undefined;
		},

		name: "honey",

		resolveId(id: string): string | undefined {
			if (id === VIRTUAL_ROUTES) return RESOLVED_ROUTES;
			if (id === VIRTUAL_MANIFEST && resolved.codegen.manifest)
				return RESOLVED_MANIFEST;
			if (id === VIRTUAL_OPENAPI && resolved.codegen.openApi)
				return RESOLVED_OPENAPI;
			return undefined;
		},
	};

	return [plugin];
}

export { generateRouteTree };
