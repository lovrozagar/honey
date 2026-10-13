import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { HoneyBuildConfig } from "../../../src/build/index.ts"
import { createBuildPlugin } from "../../../src/build/index.ts"

type BuildPlugin = ReturnType<typeof createBuildPlugin>

const TMP = resolve(import.meta.dirname, "../../../.tmp-build-plugin")

function makePlugin(target: HoneyBuildConfig["target"], overrides?: Partial<HoneyBuildConfig>) {
	return createBuildPlugin({ target, ...overrides }, { entry: "src/app.ts", export: "app" })
}

async function getEntry(plugin: BuildPlugin): Promise<string> {
	const result = await plugin.load.call(undefined, "\0virtual:honey-build-entry")
	expect(result).toBeDefined()
	return result?.code ?? ""
}

/** A project on disk plus a resolver that follows relative imports, like the bundler would. */
function project(files: Record<string, string>) {
	rmSync(TMP, { force: true, recursive: true })
	for (const [rel, code] of Object.entries(files)) {
		mkdirSync(dirname(join(TMP, rel)), { recursive: true })
		writeFileSync(join(TMP, rel), code)
	}
	return {
		resolve: async (source: string, importer?: string) => {
			if (!source.startsWith(".")) return { external: true, id: source }
			const base = resolve(dirname(importer ?? TMP), source)
			return { id: /\.[jt]s$/.test(base) ? base : `${base}.ts` }
		},
	}
}

async function entryFor(
	target: HoneyBuildConfig["target"],
	files: Record<string, string>,
	overrides?: Partial<HoneyBuildConfig>,
): Promise<string> {
	const ctx = project(files)
	const plugin = makePlugin(target, overrides)
	plugin.configResolved({ root: TMP })
	const { parseAst } = await import("vite")
	const result = await plugin.load.call(
		{ parse: (code: string, opts?: { lang?: "js" | "jsx" | "ts" | "tsx" }) => parseAst(code, opts), ...ctx },
		"\0virtual:honey-build-entry",
	)
	return result?.code ?? ""
}

afterEach(() => {
	rmSync(TMP, { force: true, recursive: true })
})

describe("createBuildPlugin", () => {
	describe("plugin metadata", () => {
		it("has name honey:build", () => {
			const plugin = makePlugin("node")
			expect(plugin.name).toBe("honey:build")
		})

		it("has apply build", () => {
			const plugin = makePlugin("node")
			expect(plugin.apply).toBe("build")
		})
	})

	describe("resolveId", () => {
		it("resolves virtual:honey-build-entry", () => {
			const plugin = makePlugin("node")
			expect(plugin.resolveId("virtual:honey-build-entry")).toBe("\0virtual:honey-build-entry")
		})

		it("returns undefined for other ids", () => {
			const plugin = makePlugin("node")
			expect(plugin.resolveId("./other.ts")).toBeUndefined()
		})
	})

	describe("load", () => {
		it("returns entry code with moduleType js", async () => {
			const plugin = makePlugin("node")
			const result = await plugin.load.call(undefined, "\0virtual:honey-build-entry")
			expect(result).toBeDefined()
			expect(result?.moduleType).toBe("js")
			expect(result?.code).toBeTruthy()
		})

		it("returns undefined for other ids", async () => {
			const plugin = makePlugin("node")
			expect(await plugin.load.call(undefined, "./other.ts")).toBeUndefined()
		})
	})

	describe("config", () => {
		it("returns SSR build settings", () => {
			const plugin = makePlugin("node")
			const cfg = plugin.config() as Record<string, Record<string, unknown>>

			expect(cfg.ssr).toEqual({ target: "node" })
			expect(cfg.build).toMatchObject({
				emptyOutDir: false,
				minify: true,
				outDir: "./dist",
				ssr: true,
			})
		})

		it("externals include all node builtins in both forms", () => {
			const plugin = makePlugin("node")
			const cfg = plugin.config() as {
				build: { rolldownOptions: { external: string[] } }
			}
			const externals = cfg.build.rolldownOptions.external

			expect(externals).toContain("fs")
			expect(externals).toContain("node:fs")
			expect(externals).toContain("path")
			expect(externals).toContain("node:path")
		})

		it("includes user-provided externals", () => {
			const plugin = makePlugin("node", { external: ["pg-native"] })
			const cfg = plugin.config() as {
				build: { rolldownOptions: { external: string[] } }
			}
			expect(cfg.build.rolldownOptions.external).toContain("pg-native")
		})

		it("respects custom outDir", () => {
			const plugin = makePlugin("node", { outDir: "./build" })
			const cfg = plugin.config() as { build: { outDir: string } }
			expect(cfg.build.outDir).toBe("./build")
		})

		it("respects minify false", () => {
			const plugin = makePlugin("node", { minify: false })
			const cfg = plugin.config() as { build: { minify: boolean } }
			expect(cfg.build.minify).toBe(false)
		})

		// regression: L (build/index.ts:137-140)
		it("keeps dependencies external on node and bun, bundles them for workers", () => {
			const ssr = (target: HoneyBuildConfig["target"]) =>
				(makePlugin(target).config() as { ssr: { noExternal?: boolean } }).ssr.noExternal
			expect(ssr("node")).toBeUndefined()
			expect(ssr("bun")).toBeUndefined()
			expect(ssr("cloudflare")).toBe(true)
			expect(ssr("deno")).toBe(true)
		})

		it("uses webworker target for cloudflare", () => {
			const plugin = makePlugin("cloudflare")
			const cfg = plugin.config() as { ssr: { target: string } }
			expect(cfg.ssr.target).toBe("webworker")
		})

		it("uses webworker target for deno", () => {
			const plugin = makePlugin("deno")
			const cfg = plugin.config() as { ssr: { target: string } }
			expect(cfg.ssr.target).toBe("webworker")
		})

		it("uses node target for bun", () => {
			const plugin = makePlugin("bun")
			const cfg = plugin.config() as { ssr: { target: string } }
			expect(cfg.ssr.target).toBe("node")
		})

		it("sets rolldown input to virtual entry", () => {
			const plugin = makePlugin("node")
			const cfg = plugin.config() as {
				build: { rolldownOptions: { input: string } }
			}
			expect(cfg.build.rolldownOptions.input).toBe("virtual:honey-build-entry")
		})

		it("sets output entryFileNames to index.js", () => {
			const plugin = makePlugin("node")
			const cfg = plugin.config() as {
				build: { rolldownOptions: { output: { entryFileNames: string } } }
			}
			expect(cfg.build.rolldownOptions.output.entryFileNames).toBe("index.js")
		})
	})

	describe("import generation", () => {
		it("uses named import for non-default export", async () => {
			const plugin = createBuildPlugin({ target: "node" }, { entry: "src/app.ts", export: "myApp" })
			expect(await getEntry(plugin)).toContain('import { myApp as app } from "./src/app.ts"')
		})

		it("uses default import for default export", async () => {
			const plugin = createBuildPlugin({ target: "node" }, { entry: "src/app.ts", export: "default" })
			expect(await getEntry(plugin)).toContain('import app from "./src/app.ts"')
		})
	})

	describe("server entries start like app.serve()", () => {
		for (const target of ["node", "bun", "deno"] as const) {
			// regression: M (build/index.ts:52-65), for the bun target
			it(`${target}: startHoneyServer with the runtime, env and 0.0.0.0`, async () => {
				const entry = await getEntry(makePlugin(target))
				expect(entry).toContain('import { startHoneyServer } from "@lovrozagar/honey/serve"')
				expect(entry).toContain(`runtime: "${target}"`)
				expect(entry).toContain('hostname: "0.0.0.0"')
			})
		}

		it("node and bun pass process.env and default to port 3000", async () => {
			for (const target of ["node", "bun"] as const) {
				const entry = await getEntry(makePlugin(target))
				expect(entry).toContain("env: process.env")
				expect(entry).toContain("process.env.PORT ?? 3000")
			}
		})

		it("uses a custom port", async () => {
			expect(await getEntry(makePlugin("node", { port: 8080 }))).toContain("process.env.PORT ?? 8080")
			expect(await getEntry(makePlugin("bun", { port: 4000 }))).toContain("process.env.PORT ?? 4000")
			expect(await getEntry(makePlugin("deno", { port: 5000 }))).toContain('"5000"')
		})

		it("deno reads PORT and env from Deno.env", async () => {
			const entry = await getEntry(makePlugin("deno"))
			expect(entry).toContain('Deno.env.get("PORT")')
			expect(entry).toContain("env: Deno.env.toObject()")
		})
	})

	describe("cloudflare adapter", () => {
		it("exports default with fetch", async () => {
			const entry = await getEntry(makePlugin("cloudflare"))
			expect(entry).toContain("export default {")
			expect(entry).toContain("app.fetch(req, env, ctx)")
		})

		it("has no port variable or PORT env reference", async () => {
			const entry = await getEntry(makePlugin("cloudflare"))
			expect(entry).not.toContain("const port")
			expect(entry).not.toContain("PORT")
		})

		it("ignores port config silently", async () => {
			const entry = await getEntry(makePlugin("cloudflare", { port: 9999 }))
			expect(entry).not.toContain("9999")
			expect(entry).not.toContain("const port")
		})
	})

	describe("feature detection over the import graph", () => {
		const routes = [
			'import { honey } from "@lovrozagar/honey"',
			'export const app = honey().get("/h").handler((c) => c.res.text("ok", "ok"))',
			'app.openapi({ title: "T", version: "1" })',
		].join("\n")

		// regression: M (build/index.ts:30-42)
		it("finds openapi() behind a re-export entry", async () => {
			const entry = await entryFor("cloudflare", {
				"src/app.ts": 'export { app } from "./routes"\n',
				"src/routes.ts": routes,
			})
			expect(entry).toContain('from "@lovrozagar/honey/openapi"')
			expect(entry).toContain("enableOpenApi()")
		})

		// regression: M (build/index.ts:30-42)
		it("ignores feature calls in comments and strings", async () => {
			const entry = await entryFor("cloudflare", {
				"src/app.ts": [
					'import { honey } from "@lovrozagar/honey"',
					"// await app.serve({ port: 3000 })",
					"/* app.openapi({}) */",
					'const note = "call app.errorI18n() later"',
					"export const app = honey()",
				].join("\n"),
			})
			expect(entry).not.toContain("enableOpenApi")
			expect(entry).not.toContain("enableI18n")
			expect(entry).not.toContain("enableServe")
		})

		it("never injects serve into a Worker, and ignores Bun.serve / Deno.serve", async () => {
			const files = {
				"src/app.ts": [
					'import { honey } from "@lovrozagar/honey"',
					"export const app = honey()",
					"await app.serve({ port: 3000 })",
				].join("\n"),
			}
			expect(await entryFor("cloudflare", files)).not.toContain("enableServe")
			expect(await entryFor("node", files)).toContain("enableServe()")
			const runtimeServe = { "src/app.ts": "Bun.serve({ fetch() {} })\nDeno.serve(() => new Response())\n" }
			expect(await entryFor("node", runtimeServe)).not.toContain("enableServe")
		})

		it("does not follow imports into node_modules or externals", async () => {
			const entry = await entryFor("cloudflare", {
				"node_modules/x/index.ts": "app.openapi({})",
				"src/app.ts": 'import "x"\nimport "../node_modules/x/index.ts"\n',
			})
			expect(entry).not.toContain("enableOpenApi")
		})

		it("explicit features override detection", async () => {
			const entry = await entryFor("cloudflare", { "src/app.ts": routes }, { features: { i18n: true, openapi: false } })
			expect(entry).not.toContain("enableOpenApi")
			expect(entry).toContain("enableI18n()")
		})
	})
})
