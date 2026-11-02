/**
 * The build plugin (`@lovrozagar/honey/build`): bundles the app for node, bun or a Cloudflare Worker (H15)
 * from a virtual entry that imports it and starts it the way that target runs an app. Nothing is detected or
 * injected: v1 code-splits through plain dynamic import() (Q4, H23). Bit 21 h: a Worker's module also exports every
 * other named export of the app's entry (a Durable Object class, a WorkerEntrypoint, a Workflow), since a Worker's
 * bindings name classes its main module exports. A value workerd takes as no entrypoint (a string, a number) is
 * exported as an inert empty object, so it never stops the Worker. Its default holds honey's fetch, plus a `scheduled`
 * or `queue` function from the entry: workerd calls those only on the default export.
 */
import { builtinModules } from "node:module"

/** The runtime a bundle is built for: `node` and `bun` bundles start a server, a `workers` bundle is a Worker. */
export type BuildTarget = "bun" | "node" | "workers"

/** Options for `createBuildPlugin`: the runtime to build for and how the bundle is written. */
export type HoneyBuildConfig = {
	/** modules left out of the bundle beside node's builtins */
	external?: string[]
	/** Whether to minify the bundle; default `true`. */
	minify?: boolean
	/** Where the bundle is written, relative to Vite's project root; default `./dist`. */
	outDir?: string
	/** a node or bun server's port when PORT is unset; default 3000 */
	port?: number
	/** The runtime the bundle is built for; `createBuildPlugin` throws on any other value. */
	target: BuildTarget
}

/** The app module the entry imports and its export's name, `default` for the default export. */
export type BuildApp = {
	/** The app module's path, relative to Vite's project root. */
	entry: string
	/** The name the module exports the app under, or `"default"`. */
	export: string
}

/** How one target starts the app and how its bundle is resolved. */
type Target = {
	/** The source of the virtual entry module for `app`, given the default port and the entry's extra export names. */
	entry(app: BuildApp, port: number, named: readonly string[]): string
	/** bundle every dependency: a Worker has no node_modules at run time */
	noExternal: boolean
	/** The runtime Vite resolves server-side imports for: `webworker` for a Worker, `node` for node and bun. */
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

/* workerd calls these on the default export, and a named one would be an entrypoint nothing reaches */
const DEFAULT_HANDLERS = ["queue", "scheduled"]

/** A Worker: the app is its fetch, its entry's `named` exports its own, and there is nothing to listen on. */
function workerEntry(app: BuildApp, _port: number, named: readonly string[]): string {
	/* an export name need not be an identifier (`export { x as "a-b" }`) */
	const names = named.map((name) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)))
	/*
	 * workerd loads a module only when its every named export is a function (a class among them) or an object: one
	 * string, number, boolean, null or undefined stops the Worker (`not of type 'function or ExportedHandler'`). Only
	 * the names are known here, so each value passes through as it is, or, being none of those, as an inert empty
	 * object: an entrypoint with no handler, which keeps an entry's `export const VERSION = "1"` from stopping it.
	 */
	const passed =
		named.length === 0
			? []
			: [
					`import * as entry from "./${app.entry}"`,
					'const entrypoint = (value) => (typeof value === "function" || (typeof value === "object" && value !== null) ? value : {})',
					/* an export list is static, so a handler moved onto the default leaves its name behind, inert */
					...named.map((name, at) => {
						const value = `entry[${JSON.stringify(name)}]`
						const moved = DEFAULT_HANDLERS.includes(name) ? `typeof ${value} === "function" ? {} : ` : ""
						return `const named${at} = ${moved}entrypoint(${value})`
					}),
					`export { ${names.map((name, at) => `named${at} as ${name}`).join(", ")} }`,
				]
	return [
		importApp(app),
		...passed,
		"",
		"export default {",
		"  fetch: (req, env, ctx) => app.fetch(req, env, ctx),",
		...DEFAULT_HANDLERS.filter((name) => named.includes(name)).map(
			(name) => `  ...(typeof entry.${name} === "function" ? { ${name}: entry.${name} } : {}),`,
		),
		"}",
	].join("\n")
}

/** What the plugin asks of the build: the app entry resolved, and its module's export names. */
type EntryContext = {
	/** Resolves `source` to a module, or `null` when it does not resolve. */
	resolve(source: string): Promise<{
		/** The resolved module id. */
		id: string
	} | null>
	/** Loads `module` and reports the names it exports. */
	load(module: {
		/** The resolved module id. */
		id: string
	}): Promise<{
		/** The names the module exports; absent or `null` counts as none. */
		exports?: readonly string[] | null
	}>
}

/** The generated entry module that starts the app. */
type VirtualEntry = {
	/** The entry's JavaScript source. */
	code: string
	/** Always `"js"`. */
	moduleType: "js"
}

/** The Vite plugin `createBuildPlugin` returns. */
export type HoneyBuildPlugin = {
	/** Runs under `vite build` only. */
	apply: "build"
	/** The Vite config the plugin contributes: a server-side bundle of the virtual entry. */
	config(): {
		/** Vite's build options for the bundle. */
		build: {
			/** Always `false`: the output directory is not emptied. */
			emptyOutDir: boolean
			/** The configured `minify`, or `true`. */
			minify: boolean
			/** The configured `outDir`, or `./dist`. */
			outDir: string
			/** The bundler's input, externals and output file name. */
			rolldownOptions: {
				/** Modules left out of the bundle: node's builtins, with and without `node:`, plus the configured externals. */
				external: string[]
				/** The virtual entry module. */
				input: string
				/** How the bundle's one entry file is named. */
				output: {
					/** Always `index.js`. */
					entryFileNames: string
				}
			}
			/** Always `true`: the bundle is built for a server runtime. */
			ssr: boolean
		}
		/** How Vite resolves server-side imports. */
		ssr: {
			/** `true` for a Worker, which bundles every dependency; left out for node and bun. */
			noExternal?: boolean
			/** `webworker` for a Worker, `node` for node and bun. */
			target: Target["ssrTarget"]
		}
	}
	/**
	 * Returns the virtual entry's source for its own id, and nothing for any other. For a Worker it rejects when the app
	 * entry does not resolve, or when the entry has a default export beside a named app.
	 */
	load(this: EntryContext, id: string): Promise<VirtualEntry> | VirtualEntry | undefined
	/** Always `"honey:build"`. */
	name: string
	/** Resolves the virtual entry's id, and nothing for any other. */
	resolveId(id: string): string | undefined
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
	workers: { entry: workerEntry, named: true, noExternal: true, ssrTarget: "webworker" },
	node: { entry: serverEntry, named: false, noExternal: false, ssrTarget: "node" },
}

/** The Vite plugin that builds `app` for `config.target`: `vite build` with it emits `<outDir>/index.js`. */
export function createBuildPlugin(config: HoneyBuildConfig, app: BuildApp): HoneyBuildPlugin {
	if (!Object.hasOwn(TARGETS, config.target)) {
		throw new Error(`honey build: unknown target "${config.target}"; expected node, bun or workers`)
	}
	const target = TARGETS[config.target]
	return {
		apply: "build",
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
			const module = (named: readonly string[]): VirtualEntry => ({
				code: target.entry(app, port, named),
				moduleType: "js",
			})
			/* only a Worker passes exports on, which needs the build to read its entry */
			return target.named ? passedOn(this, app).then(module) : module([])
		},
		name: "honey:build",
		resolveId(id: string): string | undefined {
			return id === VIRTUAL_ENTRY ? RESOLVED_ENTRY : undefined
		},
	}
}
