/**
 * The `honey()` plugin's config (bit 19 h2): what it takes, resolved with its defaults (the route tree on, every
 * other artifact off), and every path a generation writes, which a watcher must never take for an edit. An OpenAPI
 * output path ending `.yaml` or `.yml` is that YAML file alone; any other is JSON there plus its `.yaml` sibling
 * (Q7: core's openapi/yaml.ts writes it). The SDKs, the CLI and MCP are honey-codegen's (Q1), so their keys are refused.
 */
import { dirname, resolve } from "node:path"
import type { OpenApiRouteInfo } from "../openapi/generate.ts"
import type { InvalidateCheckConfig } from "../routing/invalidate-check.ts"
import type { OpenApiSanitizeOptions } from "../schema/sanitize-spec.ts"

/** One OpenAPI document a generation writes. */
export type HoneyOpenApiOutputConfig = {
	readonly description?: string
	/** leave out every route this answers false for */
	readonly filterRoutes?: (route: OpenApiRouteInfo) => boolean
	/** default `src/_gen/openapi.gen.json` */
	readonly path?: string
	/** the metaSpec profile this document carries */
	readonly profile?: string
	/** what the published document leaves out */
	readonly sanitize?: OpenApiSanitizeOptions
	readonly securitySchemes?: Readonly<Record<string, unknown>>
	readonly title: string
	readonly version: string
}

export type HoneyCodegenConfig = {
	/** mutations that declare no `invalidate`, reported once per generation; default `"warn"` */
	readonly invalidate?: InvalidateCheckConfig
	/** the route manifest; `true` is `src/_gen/manifest.gen.json` */
	readonly manifest?: boolean | string
	/** a gateway's route tree source: a module exporting its services' merged tree */
	readonly mergeTree?: string
	/** one document, or several from the same routes */
	readonly openApi?: HoneyOpenApiOutputConfig | readonly HoneyOpenApiOutputConfig[]
	/** the route tree module; on by default at `src/_gen/routes.gen.ts` */
	readonly tree?: boolean | string
	/** the app's types; `true` is `src/_gen/types.gen.d.ts` */
	readonly types?: boolean | string | { readonly baseCtxName?: string; readonly path?: string }
}

export type HoneyVitePluginConfig = {
	/** the module exporting the app (`app`, else the default export) */
	readonly app?: string
	readonly codegen?: HoneyCodegenConfig
	/** globs, from the project root, whose edits regenerate in dev */
	readonly watch?: readonly string[]
}

export type ResolvedOpenApiOutput = Omit<HoneyOpenApiOutputConfig, "path"> & { readonly path: string }

export type ResolvedHoneyConfig = {
	readonly app: string | undefined
	readonly codegen: {
		readonly invalidate: InvalidateCheckConfig | undefined
		readonly manifest: false | string
		readonly mergeTree: string | undefined
		readonly openApi: readonly ResolvedOpenApiOutput[]
		readonly tree: false | string
		readonly types: false | { readonly baseCtxName: string | undefined; readonly path: string }
	}
	readonly watch: readonly string[]
}

const TYPES = "src/_gen/types.gen.d.ts"

/** `value` as a path: `true` (or nothing, when on by default) is `fallback`, `false` is off. */
function pathOf(value: boolean | string | undefined, fallback: string, on: boolean): false | string {
	if (typeof value === "string") return value
	return value === true || (value === undefined && on) ? fallback : false
}

/** `raw` with its defaults; a key honey-codegen owns is an error naming where it went. */
export function resolveHoneyConfig(raw: HoneyVitePluginConfig): ResolvedHoneyConfig {
	const c = raw.codegen ?? {}
	for (const key of ["sdk", "cli"])
		if (Object.hasOwn(c, key))
			throw new Error(`codegen.${key}: the SDKs, the CLI and MCP are honey-codegen's: honey-codegen generate --app`)
	const types = typeof c.types === "object" ? c.types : { path: pathOf(c.types, TYPES, false) || undefined }
	const outputs = c.openApi === undefined ? [] : Array.isArray(c.openApi) ? c.openApi : [c.openApi]
	return {
		app: raw.app,
		codegen: {
			invalidate: c.invalidate,
			manifest: pathOf(c.manifest, "src/_gen/manifest.gen.json", false),
			mergeTree: c.mergeTree,
			openApi: (outputs as readonly HoneyOpenApiOutputConfig[]).map((entry) => ({
				...entry,
				path: entry.path ?? "src/_gen/openapi.gen.json",
			})),
			tree: pathOf(c.tree, "src/_gen/routes.gen.ts", true),
			types:
				c.types === undefined || c.types === false
					? false
					: { baseCtxName: "baseCtxName" in types ? types.baseCtxName : undefined, path: types.path ?? TYPES },
		},
		watch: raw.watch ?? [],
	}
}

/** Where an OpenAPI output configured at `path` goes: a `.yaml`/`.yml` path is YAML alone, else JSON plus `.yaml`. */
export function openApiOutputPaths(path: string): { json: string | null; yaml: string } {
	if (/\.ya?ml$/.test(path)) return { json: null, yaml: path }
	return { json: path, yaml: path.endsWith(".json") ? `${path.slice(0, -5)}.yaml` : `${path}.yaml` }
}

/** Every file a generation writes, absolute, and the directories it creates them in. */
export function generatedOutputs(config: ResolvedHoneyConfig, root: string): { dirs: string[]; files: string[] } {
	const { manifest, openApi, tree, types } = config.codegen
	const files = [tree, types === false ? false : types.path, manifest]
		.filter((path): path is string => path !== false)
		.map((path) => resolve(root, path))
	for (const entry of openApi) {
		const { json, yaml } = openApiOutputPaths(resolve(root, entry.path))
		files.push(...(json === null ? [] : [json]), yaml)
	}
	return { dirs: [...new Set(files.map((file) => dirname(file)))], files }
}

/** Whether `file` is one a generation writes (its atomic write's temp file is WATCH_IGNORE_RE's `.tmp`). */
export const isGeneratedOutput = (file: string, outputs: { files: readonly string[] }): boolean =>
	outputs.files.includes(resolve(file))
