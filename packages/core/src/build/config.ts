/**
 * `honeyPlugin()`'s config (bit 19 h2): what it takes, resolved with its defaults (the route tree on, every
 * other artifact off), and every path a generation writes, which a watcher must never take for an edit. An OpenAPI
 * output writes each of its formats under its path's stem, JSON unless the path is YAML (plan 39 7.4; core's
 * openapi/yaml.ts writes the YAML), and shows the security schemes the codegen declares once that it lists, else
 * the ones its routes name. The SDKs, the CLI and the MCP server package are honey-clients's (Q1), so
 * their keys are refused. Bit 21 e: `mcp` writes the handler an app mounts (`_gen/mcp.gen.ts`, its runtime and SDK in
 * the companion directory named by its stem, `_gen/mcp/`), H24.3.
 */
import { dirname, join, resolve } from "node:path"
import type { OpenApiExternalDocs, OpenApiRouteInfo, OpenApiServer, OpenApiTag } from "../openapi/generate.ts"
import type { InvalidateCheckConfig } from "../routing/invalidate-check.ts"
import type { OpenApiSanitizeOptions } from "../schema/sanitize-spec.ts"

/** A file format an OpenAPI document is written in. */
export type OpenApiFormat = "json" | "yaml"

/** One OpenAPI document a generation writes. */
export type HoneyOpenApiOutputConfig = {
	/** The document's `info.description`; left out when unset. */
	readonly description?: string
	/** The document's own external docs. */
	readonly externalDocs?: OpenApiExternalDocs
	/** leave out every route this answers false for */
	readonly filterRoutes?: (route: OpenApiRouteInfo) => boolean
	/**
	 * The files written, each under the path's stem: `["yaml"]` when the path ends `.yaml` or `.yml`, else `["json"]`.
	 */
	readonly formats?: readonly OpenApiFormat[]
	/** The document's name, unique among the outputs; generated code that points at the document keys it by this. */
	readonly name?: string
	/** default `src/_gen/openapi.gen.json` */
	readonly path?: string
	/** the metaSpec profile this document carries */
	readonly profile?: string
	/** what the published document leaves out */
	readonly sanitize?: {
		/** The `x-*` keys to drop: `true` for every one honey and its generators do not read, or a list of names. */
		readonly stripXExtensions?: OpenApiSanitizeOptions["stripXExtensions"]
	}
	/**
	 * The schemes of `codegen.securitySchemes` the document shows: a requirement naming another is left out, and so is
	 * its definition. Unset: every scheme its routes name.
	 */
	readonly security?: readonly string[]
	/** The servers it lists, in place of the stripped prefix. */
	readonly servers?: readonly OpenApiServer[]
	/** Metadata for the tags its operations name, listed in this order; the tags no entry names follow. */
	readonly tags?: readonly OpenApiTag[]
	/** The document's `info.title`. */
	readonly title: string
	/** The document's `info.version`: the API's own version, not the OpenAPI version. */
	readonly version: string
}

/** The MCP handler an app mounts with `mcp(app, path, mcpHandler)` from @lovrozagar/honey/mcp. */
export type HoneyMcpOutputConfig = {
	/** leave out every route this answers false for; a tool is a route whose meta has `mcp: true` */
	readonly filterRoutes?: (route: OpenApiRouteInfo) => boolean
	/** the server's name; by default the first OpenAPI output's title's */
	readonly name?: string
	/** default `src/_gen/mcp.gen.ts`; its runtime and SDK go in the directory its stem names beside it */
	readonly path?: string
}

/** Which artifacts a generation writes. The route tree is on by default; every other one is off until configured. */
export type HoneyCodegenConfig = {
	/**
	 * The directory a Worker serves as assets, from the project root; default wrangler's `assets.directory`. A named
	 * OpenAPI document's files are listed under it in `src/_gen/openapi-sources.gen.ts`.
	 */
	readonly assetsDir?: string
	/** mutations that declare no `invalidate`, reported once per generation; default `"warn"` */
	readonly invalidate?: InvalidateCheckConfig
	/** the route manifest; `true` is `src/_gen/manifest.gen.json` */
	readonly manifest?: boolean | string
	/** the MCP handler the app mounts; `true` is `src/_gen/mcp.gen.ts` */
	readonly mcp?: boolean | string | HoneyMcpOutputConfig
	/** a gateway's route tree source: a module exporting its services' merged tree */
	readonly mergeTree?: string
	/** one document, or several from the same routes */
	readonly openApi?: HoneyOpenApiOutputConfig | readonly HoneyOpenApiOutputConfig[]
	/**
	 * Every security scheme the routes name, keyed by name: each document shows those it lists, or those its routes
	 * name. A route naming a scheme missing here is an error, or a warning when none are declared.
	 */
	readonly securitySchemes?: Readonly<Record<string, unknown>>
	/** the route tree module; on by default at `src/_gen/routes.gen.ts` */
	readonly tree?: boolean | string
	/** the app's types; `true` is `src/_gen/types.gen.d.ts` */
	readonly types?:
		| boolean
		| string
		| {
				/** The name the generated file gives the app's base context type; default `BaseCtx`. */
				readonly baseCtxName?: string
				/** Where the types file is written; default `src/_gen/types.gen.d.ts`. */
				readonly path?: string
		  }
}

/** What `honeyPlugin()` takes: the app module, the artifacts to generate, and the files whose edits regenerate them. */
export type HoneyVitePluginConfig = {
	/** the module exporting the app (`app`, else the default export) */
	readonly app?: string
	/** Which artifacts a generation writes; only the route tree when unset. */
	readonly codegen?: HoneyCodegenConfig
	/** globs, from the project root, whose edits regenerate in dev */
	readonly watch?: readonly string[]
}

export type ResolvedOpenApiOutput = Omit<HoneyOpenApiOutputConfig, "formats" | "path"> & {
	readonly formats: readonly OpenApiFormat[]
	readonly path: string
}

export type ResolvedMcpOutput = Omit<HoneyMcpOutputConfig, "path"> & {
	readonly path: string
	/** the companion directory's name, the path's stem */
	readonly dir: string
}

export type ResolvedHoneyConfig = {
	readonly app: string | undefined
	readonly codegen: {
		readonly assetsDir: string | undefined
		readonly invalidate: InvalidateCheckConfig | undefined
		readonly manifest: false | string
		readonly mcp: false | ResolvedMcpOutput
		readonly mergeTree: string | undefined
		readonly openApi: readonly ResolvedOpenApiOutput[]
		readonly securitySchemes: Readonly<Record<string, unknown>> | undefined
		readonly tree: false | string
		readonly types: false | { readonly baseCtxName: string | undefined; readonly path: string }
	}
	readonly watch: readonly string[]
}

/** Where the named documents' sources module is written (openapi-sources.ts writes it), from the project root. */
export const OPENAPI_SOURCES = "src/_gen/openapi-sources.gen.ts"

const TYPES = "src/_gen/types.gen.d.ts"
const MCP = "src/_gen/mcp.gen.ts"

/**
 * The files honey-clients's generateMcpHandler writes in the companion directory: its portable runtime and the API's
 * TS SDK (plugin.test holds a generation to exactly these).
 */
export const MCP_COMPANIONS = [
	"api.client.gen.ts",
	"api.index.gen.ts",
	"api.map.gen.ts",
	"api.runtime.gen.ts",
	"api.types.gen.ts",
	"runtime.gen.ts",
] as const

/** `value` as the MCP output: off, or its path (a `.ts` module) and companion directory with its options. */
type TypesOptions = Extract<HoneyCodegenConfig["types"], object>

/* every key each config object takes, exhaustive by its type: a JS config is not type-checked, and none passes unread */
const PLUGIN_KEYS = { app: true, codegen: true, watch: true } satisfies Record<keyof HoneyVitePluginConfig, true>
const CODEGEN_KEYS = {
	assetsDir: true,
	invalidate: true,
	manifest: true,
	mcp: true,
	mergeTree: true,
	openApi: true,
	securitySchemes: true,
	tree: true,
	types: true,
} satisfies Record<keyof HoneyCodegenConfig, true>
const OPENAPI_KEYS = {
	description: true,
	externalDocs: true,
	filterRoutes: true,
	formats: true,
	name: true,
	path: true,
	profile: true,
	sanitize: true,
	security: true,
	servers: true,
	tags: true,
	title: true,
	version: true,
} satisfies Record<keyof HoneyOpenApiOutputConfig, true>
const SANITIZE_KEYS = { stripXExtensions: true } satisfies Record<
	keyof NonNullable<HoneyOpenApiOutputConfig["sanitize"]>,
	true
>
const MCP_KEYS = { filterRoutes: true, name: true, path: true } satisfies Record<keyof HoneyMcpOutputConfig, true>
const TYPES_KEYS = { baseCtxName: true, path: true } satisfies Record<keyof TypesOptions, true>

const CLIENTS = "the SDKs, the CLI and MCP are honey-clients's: honey-clients generate --app"
const ONCE = "declare each scheme once in codegen.securitySchemes"
const SHOWN = "security lists the schemes the document shows"
/** The keys a release moved, by the object they were in, with where they went. */
const MOVED: Readonly<Record<string, string>> = {
	"codegen.cli": CLIENTS,
	"codegen.sdk": CLIENTS,
	"mcp.securitySchemes": ONCE,
	"openApi.securitySchemes": ONCE,
	"sanitize.stripSecurityRequirements": SHOWN,
	"sanitize.stripSecuritySchemes": SHOWN,
}

/** Refuse the first key of `value` that `known` lacks, named from `at`; a moved one says where it went. */
function onlyKnown(value: object, known: object, at: string, kind: string): void {
	const key = Object.keys(value).find((name) => !Object.hasOwn(known, name))
	if (key === undefined) return
	const path = at === "" ? key : `${at}.${key}`
	const moved = MOVED[`${kind}.${key}`]
	throw new Error(moved === undefined ? `${path} is no option` : `${path} moved: ${moved}`)
}

function mcpOf(value: HoneyCodegenConfig["mcp"]): false | ResolvedMcpOutput {
	if (value === undefined || value === false) return false
	if (typeof value === "object") onlyKnown(value, MCP_KEYS, "codegen.mcp", "mcp")
	const options = typeof value === "object" ? value : { path: typeof value === "string" ? value : undefined }
	const path = options.path ?? MCP
	const dir = /([^/\\]+?)(?:\.gen)?\.ts$/.exec(path)?.[1]
	if (dir === undefined) throw new Error(`codegen.mcp: ${JSON.stringify(path)} is no .ts module`)
	return { ...options, dir, path }
}

/** `value` as a path: `true` (or nothing, when on by default) is `fallback`, `false` is off. */
function pathOf(value: boolean | string | undefined, fallback: string, on: boolean): false | string {
	if (typeof value === "string") return value
	return value === true || (value === undefined && on) ? fallback : false
}

const YAML_PATH = /\.ya?ml$/

/** The OpenAPI outputs with their paths and formats; a repeated name, no format, or an undeclared scheme is an error. */
function openApiOf(
	outputs: readonly HoneyOpenApiOutputConfig[],
	schemes: Readonly<Record<string, unknown>> | undefined,
): ResolvedOpenApiOutput[] {
	const names = new Set<string>()
	return outputs.map((entry) => {
		const path = entry.path ?? "src/_gen/openapi.gen.json"
		const at = `codegen.openApi ${JSON.stringify(entry.name ?? path)}`
		onlyKnown(entry, OPENAPI_KEYS, at, "openApi")
		if (entry.sanitize !== undefined) onlyKnown(entry.sanitize, SANITIZE_KEYS, `${at}.sanitize`, "sanitize")
		if (entry.name !== undefined) {
			if (names.has(entry.name)) throw new Error(`codegen.openApi: two documents are named "${entry.name}"`)
			names.add(entry.name)
		}
		const formats = entry.formats ?? (YAML_PATH.test(path) ? ["yaml"] : ["json"])
		if (formats.length === 0) throw new Error(`${at}: formats is empty`)
		for (const name of entry.security ?? [])
			if (schemes === undefined || !Object.hasOwn(schemes, name))
				throw new Error(`${at}: security names "${name}", which codegen.securitySchemes does not declare`)
		return { ...entry, formats, path }
	})
}

/** `raw` with its defaults; a key no option names is an error, and one a release moved names where it went. */
export function resolveHoneyConfig(raw: HoneyVitePluginConfig): ResolvedHoneyConfig {
	onlyKnown(raw, PLUGIN_KEYS, "", "plugin")
	const c = raw.codegen ?? {}
	onlyKnown(c, CODEGEN_KEYS, "codegen", "codegen")
	if (typeof c.types === "object") onlyKnown(c.types, TYPES_KEYS, "codegen.types", "types")
	const types = typeof c.types === "object" ? c.types : { path: pathOf(c.types, TYPES, false) || undefined }
	const outputs = c.openApi === undefined ? [] : Array.isArray(c.openApi) ? c.openApi : [c.openApi]
	return {
		app: raw.app,
		codegen: {
			assetsDir: c.assetsDir,
			invalidate: c.invalidate,
			manifest: pathOf(c.manifest, "src/_gen/manifest.gen.json", false),
			mcp: mcpOf(c.mcp),
			mergeTree: c.mergeTree,
			openApi: openApiOf(outputs as readonly HoneyOpenApiOutputConfig[], c.securitySchemes),
			securitySchemes: c.securitySchemes,
			tree: pathOf(c.tree, "src/_gen/routes.gen.ts", true),
			types:
				c.types === undefined || c.types === false
					? false
					: { baseCtxName: "baseCtxName" in types ? types.baseCtxName : undefined, path: types.path ?? TYPES },
		},
		watch: raw.watch ?? [],
	}
}

/**
 * Where an OpenAPI output configured at `path` writes each of `formats`: the path itself in its own format (JSON
 * unless it ends `.yaml` or `.yml`), each other format beside it under the same stem; `null` for a format not asked.
 */
export function openApiOutputPaths(
	path: string,
	formats: readonly OpenApiFormat[],
): { json: string | null; yaml: string | null } {
	const yamlPath = YAML_PATH.test(path)
	const stem = yamlPath ? path.replace(YAML_PATH, "") : path.replace(/\.json$/, "")
	return {
		json: formats.includes("json") ? (yamlPath ? `${stem}.json` : path) : null,
		yaml: formats.includes("yaml") ? (yamlPath ? path : `${stem}.yaml`) : null,
	}
}

/** The MCP output's files, from the project root: its entry, then each companion. */
export const mcpPaths = (mcp: false | ResolvedMcpOutput): string[] =>
	mcp === false ? [] : [mcp.path, ...MCP_COMPANIONS.map((name) => join(dirname(mcp.path), mcp.dir, name))]

/** Every file a generation writes, absolute, and the directories it creates them in. */
export function generatedOutputs(config: ResolvedHoneyConfig, root: string): { dirs: string[]; files: string[] } {
	const { manifest, mcp, openApi, tree, types } = config.codegen
	const files = [tree, types === false ? false : types.path, manifest, ...mcpPaths(mcp)]
		.filter((path): path is string => path !== false)
		.map((path) => resolve(root, path))
	for (const entry of openApi) {
		const { json, yaml } = openApiOutputPaths(resolve(root, entry.path), entry.formats)
		for (const file of [json, yaml]) if (file !== null) files.push(file)
	}
	if (openApi.some((entry) => entry.name !== undefined)) files.push(resolve(root, OPENAPI_SOURCES))
	return { dirs: [...new Set(files.map((file) => dirname(file)))], files }
}

/** Whether `file` is one a generation writes (its atomic write's temp file is WATCH_IGNORE_RE's `.tmp`). */
export const isGeneratedOutput = (file: string, outputs: { files: readonly string[] }): boolean =>
	outputs.files.includes(resolve(file))
