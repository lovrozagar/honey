import { existsSync, readFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { resolve } from "node:path"

/* ---- Public types ---- */

export type HoneyBuildConfig = {
	external?: string[]
	minify?: boolean
	outDir?: string
	port?: number
	target: "bun" | "cloudflare" | "deno" | "node"
}

/* ---- Internal types ---- */

type ResolvedBuildConfig = {
	entry: string
	export: string
	port: number
}

type BuildAdapterDef = {
	entry(config: ResolvedBuildConfig): string
	ssrTarget: "node" | "webworker"
}

/* ---- Entry helpers ---- */

function featurePrelude(appSource: string): string {
	const lines: string[] = []
	if (/\.openapi\s*\(|\.manifest\s*\(/.test(appSource)) {
		lines.push('import { enableOpenApi } from "honey/openapi"', "enableOpenApi()")
	}
	if (/\.errorI18n\s*\(/.test(appSource)) {
		lines.push('import { enableI18n } from "honey/i18n"', "enableI18n()")
	}
	if (/(?<!Bun)(?<!Deno)\.serve\s*\(/.test(appSource)) {
		lines.push('import { enableServe } from "honey/serve"', "enableServe()")
	}
	return lines.length > 0 ? `${lines.join("\n")}\n` : ""
}

function importApp(entry: string, exportName: string): string {
	if (exportName === "default") return `import app from "./${entry}"`
	return `import { ${exportName} as app } from "./${entry}"`
}

/* ---- Adapter definitions ---- */

const adapters: Record<HoneyBuildConfig["target"], BuildAdapterDef> = {
	bun: {
		entry(config) {
			return [
				importApp(config.entry, config.export),
				"",
				`const port = Number(process.env.PORT ?? ${config.port})`,
				"Bun.serve({",
				"  fetch: (req, server) => app.fetch(req, { server }),",
				'  hostname: "0.0.0.0",',
				"  port,",
				"})",
			].join("\n")
		},
		ssrTarget: "node",
	},
	cloudflare: {
		entry(config) {
			return [
				importApp(config.entry, config.export),
				"",
				"export default {",
				"  fetch: (req, env, ctx) => app.fetch(req, env, ctx),",
				"}",
			].join("\n")
		},
		ssrTarget: "webworker",
	},
	deno: {
		entry(config) {
			return [
				importApp(config.entry, config.export),
				"",
				`const port = Number(Deno.env.get("PORT") ?? "${config.port}")`,
				'Deno.serve({ hostname: "0.0.0.0", port }, (req) => app.fetch(req, {}))',
			].join("\n")
		},
		ssrTarget: "webworker",
	},
	node: {
		entry(config) {
			return [
				'import { serve } from "honey/node"',
				importApp(config.entry, config.export),
				"",
				`const port = Number(process.env.PORT ?? ${config.port})`,
				'serve(app, { env: process.env, hostname: "0.0.0.0", port })',
			].join("\n")
		},
		ssrTarget: "node",
	},
}

/* ---- Virtual module constants ---- */

const VIRTUAL_BUILD_ENTRY = "virtual:honey-build-entry"
const RESOLVED_BUILD_ENTRY = `\0${VIRTUAL_BUILD_ENTRY}`

/* ---- Build plugin factory ---- */

export function createBuildPlugin(
	buildConfig: HoneyBuildConfig,
	shared: { entry: string; export: string },
) {
	const adapter = adapters[buildConfig.target]
	const resolvedConfig: ResolvedBuildConfig = {
		entry: shared.entry,
		export: shared.export,
		port: buildConfig.port ?? 3000,
	}

	let root = ""

	return {
		apply: "build" as const,

		config() {
			return {
				build: {
					emptyOutDir: false,
					minify: buildConfig.minify ?? true,
					outDir: buildConfig.outDir ?? "./dist",
					rolldownOptions: {
						external: [
							...builtinModules,
							...builtinModules.map((m) => `node:${m}`),
							...(buildConfig.external ?? []),
						],
						input: VIRTUAL_BUILD_ENTRY,
						output: { entryFileNames: "index.js" },
					},
					ssr: true,
				},
				ssr: {
					noExternal: true,
					target: adapter.ssrTarget,
				},
			}
		},

		configResolved(cfg: { root: string }) {
			root = cfg.root
		},

		load(id: string): { code: string; moduleType: string } | undefined {
			if (id === RESOLVED_BUILD_ENTRY) {
				const appPath = resolve(root || ".", shared.entry)
				const appSource = existsSync(appPath) ? readFileSync(appPath, "utf-8") : ""
				return {
					code: `${featurePrelude(appSource)}${adapter.entry(resolvedConfig)}`,
					moduleType: "js",
				}
			}
			return undefined
		},

		name: "honey:build",

		resolveId(id: string): string | undefined {
			if (id === VIRTUAL_BUILD_ENTRY) return RESOLVED_BUILD_ENTRY
			return undefined
		},
	}
}
