/**
 * The build plugin (`@lovrozagar/honey/build`): bundles the app for node, bun or a Cloudflare Worker (H15)
 * from a virtual entry that imports it and starts it the way that target runs an app. Nothing is detected or
 * injected: v1 code-splits through plain dynamic import() (Q4, H23). Bit 21 h: a Worker's module also exports every
 * other named export of the app's entry (a Durable Object class, a WorkerEntrypoint, a Workflow), since a Worker's
 * bindings name classes its main module exports; its default stays honey's fetch.
 */
import { builtinModules } from "node:module"

export type BuildTarget = "bun" | "cloudflare" | "node"

export type HoneyBuildConfig = {
	/** modules left out of the bundle beside node's builtins */
	external?: string[]
	minify?: boolean
	outDir?: string
	/** a node or bun server's port when PORT is unset; default 3000 */
	port?: number
	target: BuildTarget
}

/** The app module the entry imports and its export's name, `default` for the default export. */
export type BuildApp = { entry: string; export: string }

type Target = {
	entry(app: BuildApp, port: number, named: readonly string[]): string
	/** bundle every dependency: a Worker has no node_modules at run time */
	noExternal: boolean
	ssrTarget: "node" | "webworker"
}

const VIRTUAL_ENTRY = "virtual:honey-build-entry"
const RESOLVED_ENTRY = `\0${VIRTUAL_ENTRY}`

function importApp(app: BuildApp): string {
	if (app.export === "default") return `import app from "./${app.entry}"`
	return `import { ${app.export} as app } from "./${app.entry}"`
}

/** A server on every interface, as `serve(app)` starts one: the process's env, PORT before the configured port. */
function serverEntry(app: BuildApp, port: number): string {
	return [
		'import { serve } from "@lovrozagar/honey/serve"',
		importApp(app),
		"",
		`await serve(app, { env: process.env, hostname: "0.0.0.0", port: Number(process.env.PORT ?? ${port}) })`,
	].join("\n")
}

/** A Worker: the app is its fetch, its entry's `named` exports its own, and there is nothing to listen on. */
function workerEntry(app: BuildApp, _port: number, named: readonly string[]): string {
	/* an export name need not be an identifier (`export { x as "a-b" }`) */
	const names = named.map((name) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)))
	return [
		importApp(app),
		...(names.length > 0 ? [`export { ${names.join(", ")} } from "./${app.entry}"`] : []),
		"",
		"export default {",
		"  fetch: (req, env, ctx) => app.fetch(req, env, ctx),",
		"}",
	].join("\n")
}

/** What the plugin asks of the build: the app entry resolved, and its module's export names. */
type EntryContext = {
	resolve(source: string): Promise<{ id: string } | null>
	load(module: { id: string }): Promise<{ exports?: readonly string[] | null }>
}

/** The app entry's exports a Worker passes on: all but the app's own and `default`, which honey's fetch handler is. */
async function passedOn(context: EntryContext, app: BuildApp): Promise<string[]> {
	const resolved = await context.resolve(`./${app.entry}`)
	if (resolved === null) throw new Error(`honey build: cannot resolve the app entry ./${app.entry}`)
	const exports = (await context.load({ id: resolved.id })).exports ?? []
	if (app.export !== "default" && exports.includes("default"))
		throw new Error(
			`honey build: ${app.entry} exports a default beside its app "${app.export}": a Worker's default export is ` +
				"honey's fetch handler, so the entry's own default would be lost; drop it, or export the app as the default",
		)
	return exports.filter((name) => name !== "default" && name !== app.export)
}

const TARGETS: Readonly<Record<BuildTarget, Target & { readonly named: boolean }>> = {
	bun: { entry: serverEntry, named: false, noExternal: false, ssrTarget: "node" },
	cloudflare: { entry: workerEntry, named: true, noExternal: true, ssrTarget: "webworker" },
	node: { entry: serverEntry, named: false, noExternal: false, ssrTarget: "node" },
}

/** The Vite plugin that builds `app` for `config.target`: `vite build` with it emits `<outDir>/index.js`. */
export function createBuildPlugin(config: HoneyBuildConfig, app: BuildApp) {
	if (!Object.hasOwn(TARGETS, config.target)) {
		throw new Error(`honey build: unknown target "${config.target}"; expected node, bun or cloudflare`)
	}
	const target = TARGETS[config.target]
	return {
		apply: "build" as const,
		config() {
			return {
				build: {
					emptyOutDir: false,
					minify: config.minify ?? true,
					outDir: config.outDir ?? "./dist",
					rolldownOptions: {
						external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`), ...(config.external ?? [])],
						input: VIRTUAL_ENTRY,
						output: { entryFileNames: "index.js" },
					},
					ssr: true,
				},
				/* node and bun install dependencies beside the bundle; inlining them would inline native addons too */
				ssr: { ...(target.noExternal ? { noExternal: true } : {}), target: target.ssrTarget },
			}
		},
		load(this: EntryContext, id: string) {
			if (id !== RESOLVED_ENTRY) return undefined
			const port = config.port ?? 3000
			const module = (named: readonly string[]) => ({ code: target.entry(app, port, named), moduleType: "js" as const })
			/* only a Worker passes exports on, which needs the build to read its entry */
			return target.named ? passedOn(this, app).then(module) : module([])
		},
		name: "honey:build",
		resolveId(id: string): string | undefined {
			return id === VIRTUAL_ENTRY ? RESOLVED_ENTRY : undefined
		},
	}
}
