/**
 * One generation (bit 19 h2): the app's artifacts made inside its module graph (artifacts.ts, loaded through the
 * loader that imports the app, from the app's own @lovrozagar/honey) and each written only when it changed, through
 * honey-codegen's write.ts (Q1).
 * honey-codegen is an optional peer, imported on demand (Q2), so a missing one is a named error only when a
 * generation runs.
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import type * as Artifacts from "./artifacts.ts"
import { ARTIFACTS, type Codegen, type Report } from "./artifacts.ts"
import type { ResolvedHoneyConfig } from "./config.ts"
import { createModuleLoader, type ModuleLoader } from "./loaders.ts"

export type { Report } from "./artifacts.ts"

const CODEGEN = "@lovrozagar/honey-codegen"
const CORE = "@lovrozagar/honey"

/** honey-codegen, or a named error when it is not installed. */
export async function loadCodegen(load = () => import("@lovrozagar/honey-codegen")): Promise<Codegen> {
	try {
		return await load()
	} catch (error) {
		if ((error as { code?: string }).code !== "ERR_MODULE_NOT_FOUND" || !String(error).includes(CODEGEN)) throw error
		throw new Error(`honey: generating the app's artifacts needs ${CODEGEN}: add it to your devDependencies`, {
			cause: error,
		})
	}
}

/** The root of the @lovrozagar/honey package holding `file`, found up its directories. */
function packageOf(file: string): string | undefined {
	for (let dir = dirname(file); dirname(dir) !== dir; dir = dirname(dir)) {
		const manifest = join(dir, "package.json")
		if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name === CORE)
			return dir
	}
	return undefined
}

/**
 * artifacts.ts as the app at `root` resolves @lovrozagar/honey (node_modules up from it), at the path it has in this
 * package, so it shares the app's core even when the plugin was loaded from another copy; else this package's own.
 */
export function artifactsFor(root: string, own = ARTIFACTS): string {
	const pkg = packageOf(own)
	if (pkg === undefined) return own
	for (let dir = resolve(root); ; dir = dirname(dir)) {
		const candidate = join(dir, "node_modules", CORE, relative(pkg, own))
		if (existsSync(candidate)) return candidate
		if (dirname(dir) === dir) return own
	}
}

/** artifacts.ts as `load` evaluates it, so the app it imports shares its core; a fresh loader from `root` by default. */
export async function inAppGraph(root: string, load?: ModuleLoader): Promise<typeof Artifacts> {
	const loader = load ?? (await createModuleLoader({ fresh: true, from: resolve(root, "index.ts") }))
	return (await loader(artifactsFor(root))) as unknown as typeof Artifacts
}

/** Every artifact `config` asks for, written under `root`; the files it rewrote. */
export async function generateAndWrite(
	config: ResolvedHoneyConfig,
	root: string,
	options: { load?: ModuleLoader; report?: Report } = {},
): Promise<string[]> {
	const { manifest, openApi, tree, types } = config.codegen
	if (tree === false && manifest === false && openApi.length === 0 && types === false) return []
	const codegen = await loadCodegen()
	const report = options.report ?? ((message) => void process.stderr.write(`honey: ${message}\n`))
	const run = { codegen, report, root }
	let graph = await inAppGraph(root, options.load)
	let { rewrite, source } = await graph.prepare(config, { ...run, first: true })
	const written: string[] = []
	if (rewrite !== undefined) {
		/* a gateway app imports the tree this writes: written first, then the pass redone over it on a fresh graph */
		codegen.writeFileIfChanged(resolve(root, rewrite[0]), rewrite[1])
		written.push(resolve(root, rewrite[0]))
		graph = await inAppGraph(
			root,
			await createModuleLoader({ fresh: true, from: resolve(root, "index.ts"), reload: true }),
		)
		;({ source } = await graph.prepare(config, { ...run, first: false }))
	}
	/* the tree just written is the same text again, so it is not rewritten nor listed twice */
	for (const [path, text] of await graph.artifactsOf(config, run, source))
		if (codegen.writeFileIfChanged(resolve(root, path), text)) written.push(resolve(root, path))
	return written
}
