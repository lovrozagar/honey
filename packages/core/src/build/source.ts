/**
 * What a generation reads (bit 19 h2): the tree it writes, and the app its documents, manifest and types come from,
 * resolved only once that tree is current. An app is its module's `app` export, else its default. A gateway
 * (`codegen.mergeTree`, ruled at h2, v0's shape) writes gatewayTree(the merge entry's `app` export, else config.app,
 * merged): its services' routes plus its own. Its documents come from config.app, imported over the current tree
 * and given its services' schemas, so its settings and errors are its own; with no config.app, from an app booted on
 * that tree. A first run, whose config.app imports a tree not yet written, is given the merged tree first. Runs inside
 * the app's module graph, as artifacts.ts does.
 */
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { type Honey, honey } from "../routing/app.ts"
import { gatewayTree, overlaySchemas } from "../routing/gateway-tree.ts"
import type { RouteTree } from "../routing/tree.ts"
import type { ResolvedHoneyConfig } from "./config.ts"

export type App = Honey<unknown>

/** The app a generation documents, and the module and export its types are read from (none, no types). */
export type Documented = { app: App; entry: string; exportName: string | undefined }

/** The tree a generation writes; whether the documented app loads it (so it is written first); that app, on demand. */
export type Source = { documented: () => Promise<Documented>; loadsTree: boolean; tree: RouteTree }

const isApp = (value: unknown): value is App => typeof (value as { fetch?: unknown } | null)?.fetch === "function"
const isTree = (value: unknown): value is RouteTree =>
	typeof (value as RouteTree | null)?.root === "object" && typeof (value as RouteTree | null)?.routes === "object"

/** `run()`, an app's stale-tree failure named for what it is: the app loads the tree this generation writes. */
async function unlessStale<T>(run: () => T | Promise<T>, config: ResolvedHoneyConfig): Promise<T> {
	try {
		return await run()
	} catch (error) {
		if (!/Run `honey generate`/.test(String(error))) throw error
		const { mergeTree, tree } = config.codegen
		const fix =
			mergeTree === undefined
				? "generate from an entry that builds the app without it, or set codegen.mergeTree for a gateway"
				: `export the gateway's app, built without its tree, from ${mergeTree} as app`
		throw new Error(
			`${config.app} loads the route tree generation writes (${tree || "its routes.gen.ts"}), and that tree is stale: ${fix}`,
			{ cause: error },
		)
	}
}

/** The app `config.app` names. */
async function appOf(config: ResolvedHoneyConfig, root: string): Promise<Documented> {
	const entry = resolve(root, config.app as string)
	const mod = (await unlessStale(() => import(entry), config)) as Record<string, unknown>
	const exportName = ["app", "default"].find((name) => isApp(mod[name]))
	if (exportName === undefined) throw new Error(`Expected a honey app as the app or default export of ${entry}`)
	return { app: mod[exportName] as App, entry, exportName }
}

/** A gateway's source, as the header says. */
async function gatewayOf(config: ResolvedHoneyConfig, root: string, first: boolean): Promise<Source> {
	const entry = resolve(root, config.codegen.mergeTree as string)
	const mod = (await import(entry)) as Record<string, unknown>
	const merged = [mod.tree, mod.routeTree, mod.default].find(isTree)
	if (merged === undefined) throw new Error(`Expected a route tree as the tree or default export of ${entry}`)
	const own = isApp(mod.app) ? { app: mod.app, entry, exportName: "app" } : undefined
	if (config.app === undefined) {
		const tree = own === undefined ? merged : await unlessStale(() => gatewayTree(own.app, merged), config)
		const app = honey().routeTree(tree) as unknown as App
		overlaySchemas(app, merged)
		return { documented: async () => ({ app, entry, exportName: own?.exportName }), loadsTree: false, tree }
	}
	let served: Documented | undefined
	if (own === undefined) {
		const path = config.codegen.tree === false ? undefined : resolve(root, config.codegen.tree)
		const bootstrap = first && path !== undefined && !existsSync(path)
		served = await appOf(config, root).catch((error: unknown) => {
			if (bootstrap) return undefined
			throw error
		})
		if (served === undefined) return { documented: () => appOf(config, root), loadsTree: true, tree: merged }
	}
	const builder = (own ?? served) as Documented
	const tree = await unlessStale(() => gatewayTree(builder.app, merged), config)
	const documented = async () => {
		const app = served ?? (await appOf(config, root))
		overlaySchemas(app.app, merged)
		return app
	}
	return { documented, loadsTree: true, tree }
}

/** The app `config` names, or a gateway's (`first` lets a gateway's first run bootstrap); each module imported once. */
export async function sourceOf(config: ResolvedHoneyConfig, root: string, first = false): Promise<Source> {
	if (config.codegen.mergeTree !== undefined) return gatewayOf(config, root, first)
	if (config.app === undefined) throw new Error("No app configured: set app, or codegen.mergeTree for a gateway")
	const documented = await appOf(config, root)
	const tree = await unlessStale(() => documented.app.toRouteTree(), config)
	return { documented: async () => documented, loadsTree: false, tree }
}
