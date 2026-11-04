/**
 * An app's artifacts as text (bit 19 h2): the route tree, the manifest, each OpenAPI document (JSON and YAML, Q7) and
 * the types; bit 21 e: the MCP handler the app mounts, from its own unsanitized document of the routes `filterRoutes`
 * keeps, honey-clients's generateMcpHandler writing its entry and the companion directory's runtime and SDK. This module runs inside the app's module graph: generate.ts loads it through the loader that loads the
 * app, and it imports the app itself, so the app and the core reading it are one instance (core's symbols are
 * per module). source.ts says which tree is written and which app is documented.
 */
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { generateOpenApi } from "../openapi/generate.ts"
import { generateManifest } from "../openapi/manifest.ts"
import { toYaml } from "../openapi/yaml.ts"
import type { InvalidateCheckConfig } from "../routing/invalidate-check.ts"
import { routeId } from "../routing/pattern.ts"
import type { RouteTree } from "../routing/tree.ts"
import { sanitizeOpenApiSpec, securityNamed } from "../schema/sanitize-spec.ts"
import type { EffectConverter } from "../schema/to-json-schema.ts"
import {
	mcpPaths,
	openApiOutputPaths,
	type ResolvedHoneyConfig,
	type ResolvedMcpOutput,
	type ResolvedOpenApiOutput,
} from "./config.ts"
import { effectConverter } from "./loaders.ts"
import { type Documented, type Source, sourceOf } from "./source.ts"

/** This module's path, which generate.ts loads into the app's graph. */
export const ARTIFACTS = /* @__PURE__ */ fileURLToPath(import.meta.url)

export type Clients = typeof import("@lovrozagar/honey-clients")

/** Where a generation's diagnostics go, one line each. */
export type Report = (message: string) => void

/** Where a document's warnings go: the generation's report, each line once; the app's logger without one. */
type Warnings = { readonly warn: Report } | undefined

/** `report`, saying each line once: one generation builds several documents over the same routes. */
function onceEach(report: Report): { readonly warn: Report } {
	const said = new Set<string>()
	return {
		warn: (message) => {
			if (said.has(message)) return
			said.add(message)
			report(message)
		},
	}
}

/** Every security scheme the codegen declares, keyed by name; `undefined` when it declares none. */
type Schemes = Readonly<Record<string, unknown>> | undefined

/** How a document is built: its invalidate check, the effect converter, the declared schemes and its warnings. */
type DocumentRun = {
	readonly effect: EffectConverter | undefined
	readonly invalidate: InvalidateCheckConfig | undefined
	readonly securitySchemes: Schemes
	readonly warnings?: Warnings
}

/**
 * The document `entry` describes: the schemes it lists, else the ones its routes name, with every other scheme's
 * requirements and definition left out, and sanitized as it asks.
 */
export function documentOf(
	app: Parameters<typeof generateOpenApi>[0],
	entry: ResolvedOpenApiOutput,
	{ effect, invalidate, securitySchemes, warnings }: DocumentRun,
): object {
	const document = generateOpenApi(app, {
		converters: { effect },
		externalDocs: entry.externalDocs,
		filterRoutes: entry.filterRoutes,
		info: { description: entry.description, title: entry.title, version: entry.version },
		invalidate,
		logger: warnings,
		profile: entry.profile,
		securitySchemes,
		servers: entry.servers,
		tags: entry.tags,
	})
	const shown = new Set(entry.security ?? securityNamed(document))
	const hidden = Object.keys(securitySchemes ?? {}).filter((name) => !shown.has(name))
	return sanitizeOpenApiSpec(document, {
		stripSecurityRequirements: hidden,
		stripSecuritySchemes: hidden,
		stripXExtensions: entry.sanitize?.stripXExtensions,
	})
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

type Run = { codegen: Clients; report: Report; root: string }

/** A generation's run, its documents' warnings said once each through its report. */
type Generation = Run & { readonly warnings: { readonly warn: Report } }

/** The types file: the unfiltered document (built once, its check already reported) joined with the extracted ctx. */
async function typesOf(
	config: ResolvedHoneyConfig,
	source: Documented & { tree: RouteTree },
	run: Generation,
	path: string,
): Promise<string> {
	if (source.exportName === undefined)
		throw new Error(
			"codegen.types with codegen.mergeTree needs a gateway app: config.app, or the merge entry's app export",
		)
	const outputs = config.codegen.openApi
	const document = generateOpenApi(source.app, {
		converters: { effect: await effectConverter() },
		info: { title: outputs[0]?.title ?? "API", version: outputs[0]?.version ?? "0.0.0" },
		invalidate: outputs.length > 0 ? "off" : config.codegen.invalidate,
		logger: run.warnings,
		securitySchemes: config.codegen.securitySchemes,
	})
	const extracted = run.codegen.extractTypes({
		entryPath: source.entry,
		exportName: source.exportName,
		outputDir: dirname(resolve(run.root, path)),
		report: run.report,
		routeId,
		tsMorph: await run.codegen.loadTsMorph(),
	})
	const { baseCtxName } = config.codegen.types as { baseCtxName: string | undefined }
	return run.codegen.generateTypes({ baseCtxName, document, extracted, report: run.report, tree: source.tree })
}

/**
 * What a generation reads, and, on a `first` pass whose documented app loads the tree it writes, that tree when it
 * changed: to be written first and the pass redone over it on a fresh graph.
 */
export async function prepare(
	config: ResolvedHoneyConfig,
	run: Pick<Run, "codegen" | "root"> & { first: boolean },
): Promise<{ rewrite: [string, string] | undefined; source: Source }> {
	const source = await sourceOf(config, run.root, run.first)
	const { tree } = config.codegen
	if (!run.first || !source.loadsTree || tree === false) return { rewrite: undefined, source }
	const text = run.codegen.generateRouteTree(source.tree)
	const path = resolve(run.root, tree)
	const current = existsSync(path) && readFileSync(path, "utf8") === text
	return { rewrite: current ? undefined : [tree, text], source }
}

/** The MCP handler's files for `app` as `mcp` asks, each by its path from the project root. */
function mcpFiles(
	app: Parameters<typeof generateOpenApi>[0],
	mcp: ResolvedMcpOutput,
	outputs: readonly ResolvedOpenApiOutput[],
	{
		codegen,
		effect,
		securitySchemes,
		warnings,
	}: Pick<Generation, "codegen" | "warnings"> & { effect: EffectConverter | undefined; securitySchemes: Schemes },
): [string, string][] {
	const document = generateOpenApi(app, {
		converters: { effect },
		filterRoutes: mcp.filterRoutes,
		info: { title: outputs[0]?.title ?? "API", version: outputs[0]?.version ?? "0.0.0" },
		invalidate: "off",
		logger: warnings,
		securitySchemes,
	})
	const { entry, files } = codegen.generateMcpHandler(document as unknown as Record<string, unknown>, {
		dir: mcp.dir,
		...(mcp.name === undefined ? {} : { name: mcp.name }),
	})
	const [path, ...companions] = mcpPaths(mcp)
	return [[path as string, entry], ...companions.map((at): [string, string] => [at, files[basename(at)] as string])]
}

/** Every artifact `config` asks for from `source`, by its path from the project root. */
export async function artifactsOf(config: ResolvedHoneyConfig, run: Run, source: Source): Promise<[string, string][]> {
	const generation: Generation = { ...run, warnings: onceEach(run.report) }
	const { manifest, mcp, openApi, securitySchemes, tree, types } = config.codegen
	const files: [string, string][] = []
	if (tree !== false) files.push([tree, run.codegen.generateRouteTree(source.tree)])
	const documented = await source.documented()
	if (manifest !== false) files.push([manifest, json(generateManifest(documented.app))])
	const effect = openApi.length > 0 || mcp !== false ? await effectConverter() : undefined
	for (const [index, entry] of openApi.entries()) {
		/* one invalidate check per generation, not one per document */
		const invalidate = index === 0 ? config.codegen.invalidate : "off"
		const run = { effect, invalidate, securitySchemes, warnings: generation.warnings }
		const published = documentOf(documented.app, entry, run)
		const { json: jsonPath, yaml } = openApiOutputPaths(entry.path, entry.formats)
		if (jsonPath !== null) files.push([jsonPath, json(published)])
		if (yaml !== null) files.push([yaml, toYaml(published)])
	}
	if (mcp !== false) files.push(...mcpFiles(documented.app, mcp, openApi, { ...generation, effect, securitySchemes }))
	if (types !== false)
		files.push([types.path, await typesOf(config, { ...documented, tree: source.tree }, generation, types.path)])
	return files
}

const SILENT: { readonly warn: Report } = { warn: () => {} }

/** A virtual module's code: the route tree, the manifest, or the first OpenAPI document. */
export async function virtualCode(
	kind: "manifest" | "openApi" | "routes",
	config: ResolvedHoneyConfig,
	run: Pick<Run, "root"> & { codegen: () => Promise<Clients> },
): Promise<string> {
	const source = await sourceOf(config, run.root)
	if (kind === "routes") return (await run.codegen()).generateRouteTree(source.tree)
	const { app } = await source.documented()
	/* the generation reported the document's warnings; a module load must not again */
	const value =
		kind === "manifest"
			? generateManifest(app)
			: documentOf(app, config.codegen.openApi[0] as ResolvedOpenApiOutput, {
					effect: await effectConverter(),
					invalidate: "off",
					securitySchemes: config.codegen.securitySchemes,
					warnings: SILENT,
				})
	return `export default ${JSON.stringify(value)}`
}
