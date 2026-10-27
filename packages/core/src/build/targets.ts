/**
 * The build plugin (`@lovrozagar/honey/build`): bundles the app for node, bun or a Cloudflare Worker (H15)
 * from a virtual entry that imports it and starts it the way that target runs an app. Nothing is detected or
 * injected: v1 code-splits through plain dynamic import() (Q4, H23).
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
	entry(app: BuildApp, port: number): string
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

/** A Worker: the app is its fetch, and there is nothing to listen on. */
function workerEntry(app: BuildApp): string {
	return [importApp(app), "", "export default {", "  fetch: (req, env, ctx) => app.fetch(req, env, ctx),", "}"].join(
		"\n",
	)
}

const TARGETS: Readonly<Record<BuildTarget, Target>> = {
	bun: { entry: serverEntry, noExternal: false, ssrTarget: "node" },
	cloudflare: { entry: workerEntry, noExternal: true, ssrTarget: "webworker" },
	node: { entry: serverEntry, noExternal: false, ssrTarget: "node" },
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
		load(id: string): { code: string; moduleType: "js" } | undefined {
			if (id !== RESOLVED_ENTRY) return undefined
			return { code: target.entry(app, config.port ?? 3000), moduleType: "js" }
		},
		name: "honey:build",
		resolveId(id: string): string | undefined {
			return id === VIRTUAL_ENTRY ? RESOLVED_ENTRY : undefined
		},
	}
}
