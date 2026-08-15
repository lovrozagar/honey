import { describe, expect, it } from "vitest"
import type { HoneyBuildConfig } from "../../../src/build/index.ts"
import { createBuildPlugin } from "../../../src/build/index.ts"

type BuildPlugin = ReturnType<typeof createBuildPlugin>

function makePlugin(target: HoneyBuildConfig["target"], overrides?: Partial<HoneyBuildConfig>) {
	return createBuildPlugin({ target, ...overrides }, { entry: "src/app.ts", export: "app" })
}

function getEntry(plugin: BuildPlugin): string {
	const result = plugin.load("\0virtual:honey-build-entry")
	expect(result).toBeDefined()
	return result?.code ?? ""
}

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
		it("returns entry code with moduleType js", () => {
			const plugin = makePlugin("node")
			const result = plugin.load("\0virtual:honey-build-entry")
			expect(result).toBeDefined()
			expect(result?.moduleType).toBe("js")
			expect(result?.code).toBeTruthy()
		})

		it("returns undefined for other ids", () => {
			const plugin = makePlugin("node")
			expect(plugin.load("./other.ts")).toBeUndefined()
		})
	})

	describe("config", () => {
		it("returns SSR build settings", () => {
			const plugin = makePlugin("node")
			const cfg = plugin.config() as Record<string, Record<string, unknown>>

			expect(cfg.ssr).toEqual({ noExternal: true, target: "node" })
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
		it("uses named import for non-default export", () => {
			const plugin = createBuildPlugin({ target: "node" }, { entry: "src/app.ts", export: "myApp" })
			const entry = getEntry(plugin)
			expect(entry).toContain('import { myApp as app } from "./src/app.ts"')
		})

		it("uses default import for default export", () => {
			const plugin = createBuildPlugin({ target: "node" }, { entry: "src/app.ts", export: "default" })
			const entry = getEntry(plugin)
			expect(entry).toContain('import app from "./src/app.ts"')
		})
	})

	describe("node adapter", () => {
		it("imports serve from honey/node", () => {
			const entry = getEntry(makePlugin("node"))
			expect(entry).toContain('import { serve } from "@lovrozagar/honey/node"')
		})

		it("calls serve with app, env, hostname, port", () => {
			const entry = getEntry(makePlugin("node"))
			expect(entry).toContain("serve(app, { env: process.env,")
			expect(entry).toContain('"0.0.0.0"')
		})

		it("uses default port 3000", () => {
			const entry = getEntry(makePlugin("node"))
			expect(entry).toContain("process.env.PORT ?? 3000")
		})

		it("uses custom port", () => {
			const entry = getEntry(makePlugin("node", { port: 8080 }))
			expect(entry).toContain("process.env.PORT ?? 8080")
		})
	})

	describe("bun adapter", () => {
		it("uses Bun.serve", () => {
			const entry = getEntry(makePlugin("bun"))
			expect(entry).toContain("Bun.serve({")
		})

		it("passes server ref in env for WS support", () => {
			const entry = getEntry(makePlugin("bun"))
			expect(entry).toContain("app.fetch(req, { server })")
		})

		it("uses custom port", () => {
			const entry = getEntry(makePlugin("bun", { port: 4000 }))
			expect(entry).toContain("process.env.PORT ?? 4000")
		})
	})

	describe("deno adapter", () => {
		it("uses Deno.serve", () => {
			const entry = getEntry(makePlugin("deno"))
			expect(entry).toContain("Deno.serve(")
		})

		it("reads port from Deno.env", () => {
			const entry = getEntry(makePlugin("deno"))
			expect(entry).toContain('Deno.env.get("PORT")')
		})

		it("passes empty env to app.fetch", () => {
			const entry = getEntry(makePlugin("deno"))
			expect(entry).toContain("app.fetch(req, {})")
		})

		it("uses custom port", () => {
			const entry = getEntry(makePlugin("deno", { port: 5000 }))
			expect(entry).toContain('"5000"')
		})
	})

	describe("cloudflare adapter", () => {
		it("exports default with fetch", () => {
			const entry = getEntry(makePlugin("cloudflare"))
			expect(entry).toContain("export default {")
			expect(entry).toContain("app.fetch(req, env, ctx)")
		})

		it("has no port variable or PORT env reference", () => {
			const entry = getEntry(makePlugin("cloudflare"))
			expect(entry).not.toContain("const port")
			expect(entry).not.toContain("PORT")
		})

		it("ignores port config silently", () => {
			const entry = getEntry(makePlugin("cloudflare", { port: 9999 }))
			expect(entry).not.toContain("9999")
			expect(entry).not.toContain("const port")
		})
	})
})
