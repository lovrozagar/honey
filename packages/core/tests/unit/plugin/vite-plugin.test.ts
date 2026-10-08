import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { HoneyVitePluginConfig } from "../../../src/plugin.ts"
import { honey as honeyVitePlugin, resolveHoneyConfig } from "../../../src/plugin.ts"

/* temp dir inside core so honey resolves via workspace */
const TEMP_ROOT = resolve(import.meta.dirname, "../../../.tmp-vite-test")

function writeTempApp(dir: string, opts?: { named?: boolean }): string {
	const srcDir = join(dir, "src")
	mkdirSync(srcDir, { recursive: true })
	const exportStyle = opts?.named ? "export const app = honey()" : "export default honey()"
	const code = [
		'import { honey } from "@lovrozagar/honey"',
		'import * as z from "zod"',
		"",
		exportStyle,
		'  .get("/health").handler((ctx) => ctx.res.text("ok", "ok"))',
		'  .post("/items")',
		"  .input({ json: z.object({ name: z.string() }) })",
		'  .handler((ctx) => ctx.res.text("ok", "ok"))',
	].join("\n")
	const filePath = join(srcDir, "app.ts")
	writeFileSync(filePath, code, "utf-8")
	return filePath
}

function writeMergeTreeFile(dir: string, appRelPath: string): string {
	const srcDir = join(dir, "src")
	mkdirSync(srcDir, { recursive: true })
	const code = [`import app from "./${appRelPath.replace(/\.ts$/, "")}"`, "", "export default app.toRouteTree()"].join(
		"\n",
	)
	const filePath = join(srcDir, "routes.ts")
	writeFileSync(filePath, code, "utf-8")
	return filePath
}

type PluginObj = ReturnType<typeof honeyVitePlugin>[number]

function getCodegenPlugin(config: HoneyVitePluginConfig): PluginObj {
	const plugins = honeyVitePlugin(config)
	return plugins[0] as PluginObj
}

describe("honeyVitePlugin", () => {
	let outDir: string

	beforeEach(() => {
		outDir = TEMP_ROOT
		mkdirSync(outDir, { recursive: true })
	})

	afterEach(() => {
		rmSync(outDir, { force: true, recursive: true })
	})

	it("always returns an array of plugins", () => {
		const plugins = honeyVitePlugin({ app: "src/app.ts" })
		expect(Array.isArray(plugins)).toBe(true)
		expect(plugins).toHaveLength(1)
	})

	it("codegen plugin named honey", () => {
		const plugin = getCodegenPlugin({ app: "src/app.ts" })
		expect(plugin.name).toBe("honey")
	})

	it("transform injects feature entries when the app uses them", () => {
		const plugin = getCodegenPlugin({ app: "src/app.ts" })
		const src = [
			'import { honey } from "@lovrozagar/honey"',
			'const app = honey().get("/h").handler((ctx) => ctx.res.text("ok", "ok"))',
			'app.openapi({ title: "T", version: "1" })',
			"await app.serve({ port: 3000 })",
		].join("\n")
		const out = plugin.transform(src, "/app/src/app.ts")
		expect(out?.code).toContain('from "@lovrozagar/honey/openapi"')
		expect(out?.code).toContain("enableOpenApi()")
		expect(out?.code).toContain('from "@lovrozagar/honey/serve"')
		expect(out?.code).toContain("enableServe()")
		expect(plugin.transform("Bun.serve({ fetch() {} })", "/app/src/server.ts")).toBeUndefined()
	})

	it("transform keeps line numbers and skips comments, strings and client code", () => {
		const plugin = getCodegenPlugin({ app: "src/app.ts" })
		const src = 'const app = honey()\napp.openapi({ title: "T", version: "1" })\n'
		const out = plugin.transform(src, "/app/src/app.ts")
		expect(out?.code.split("\n")).toHaveLength(src.split("\n").length)
		expect(out?.code.endsWith(src)).toBe(true)

		expect(plugin.transform("// await app.serve({ port: 3000 })\nconst x = 1\n", "/app/src/a.ts")).toBeUndefined()
		expect(plugin.transform('const s = "app.openapi("\n', "/app/src/a.ts")).toBeUndefined()

		const client = { environment: { config: { consumer: "client" } } }
		expect(plugin.transform.call(client, src, "/app/src/app.ts")).toBeUndefined()
		const server = { environment: { config: { consumer: "server" } } }
		expect(plugin.transform.call(server, src, "/app/src/app.ts")?.code).toContain("enableOpenApi()")
	})

	it("exposes its config on the plugin object for honey generate", () => {
		const config = { app: "src/app.ts" }
		expect(getCodegenPlugin(config).api.honeyConfig).toBe(config)
	})

	it("resolveId handles virtual modules", () => {
		const plugin = getCodegenPlugin({
			app: "src/app.ts",
			codegen: {
				manifest: true,
				openApi: { title: "T", version: "1" },
			},
		})

		expect(plugin.resolveId("virtual:honey/routes")).toBe("\0virtual:honey/routes")
		expect(plugin.resolveId("virtual:honey/manifest")).toBe("\0virtual:honey/manifest")
		expect(plugin.resolveId("virtual:honey/openapi")).toBe("\0virtual:honey/openapi")
		expect(plugin.resolveId("./other")).toBeUndefined()
	})

	it("manifest/openapi virtual modules unavailable when not configured", () => {
		const plugin = getCodegenPlugin({ app: "src/app.ts" })
		expect(plugin.resolveId("virtual:honey/manifest")).toBeUndefined()
		expect(plugin.resolveId("virtual:honey/openapi")).toBeUndefined()
	})

	it("buildStart writes route tree", async () => {
		writeTempApp(outDir)
		const plugin = getCodegenPlugin({ app: "src/app.ts" })
		plugin.configResolved({ root: outDir })
		await plugin.buildStart()

		const content = readFileSync(join(outDir, "src/_gen/routes.gen.ts"), "utf-8")
		expect(content).toContain("TreeNode")
		expect(content).toContain("health")
		expect(content).toContain("items")
	})

	it("buildStart writes OpenAPI with JSON Schema", async () => {
		writeTempApp(outDir)
		const plugin = getCodegenPlugin({
			app: "src/app.ts",
			codegen: {
				openApi: { title: "Test", version: "2.0" },
			},
		})
		plugin.configResolved({ root: outDir })
		await plugin.buildStart()

		const spec = JSON.parse(readFileSync(join(outDir, "src/_gen/openapi.gen.json"), "utf-8")) as Record<
			string,
			Record<string, unknown>
		>
		expect(spec.openapi).toBe("3.1.0")
		expect((spec.info as Record<string, unknown>).title).toBe("Test")
		expect(
			(spec.paths as Record<string, Record<string, Record<string, unknown>>>)["/items"].post.requestBody,
		).toBeDefined()

		const yaml = readFileSync(join(outDir, "src/_gen/openapi.gen.yaml"), "utf-8")
		expect(yaml).toContain('openapi: "3.1.0"')
		expect(yaml).toContain("title: Test")
		expect(yaml).toContain("/items:")
	})

	it("buildStart writes manifest", async () => {
		writeTempApp(outDir)
		const plugin = getCodegenPlugin({ app: "src/app.ts", codegen: { manifest: true } })
		plugin.configResolved({ root: outDir })
		await plugin.buildStart()

		const manifest = JSON.parse(readFileSync(join(outDir, "src/_gen/manifest.gen.json"), "utf-8")) as {
			routes: unknown[]
		}
		expect(manifest.routes).toHaveLength(2)
	})

	it("hotUpdate regenerates and keeps HMR, adding the virtual route tree", async () => {
		writeTempApp(outDir)
		const plugin = getCodegenPlugin({
			app: "src/app.ts",
			watch: ["src/**/*.ts"],
		})
		plugin.configResolved({ root: outDir })
		const routes = { id: "\0virtual:honey/routes" }
		const edited = { id: join(outDir, "src/app.ts") }
		const server = { moduleGraph: { getModuleById: vi.fn(() => routes) } }

		const result = await plugin.hotUpdate({
			file: join(outDir, "src/app.ts"),
			modules: [edited],
			server,
		})
		/* the edited module still hot-updates; the route tree joins it */
		expect(result).toEqual([edited, routes])
		expect(existsSync(join(outDir, "src/_gen/routes.gen.ts"))).toBe(true)
	})

	it("hotUpdate leaves HMR alone when there is no virtual route tree", async () => {
		writeTempApp(outDir)
		const plugin = getCodegenPlugin({ app: "src/app.ts", watch: ["src/**/*.ts"] })
		plugin.configResolved({ root: outDir })
		const server = { moduleGraph: { getModuleById: vi.fn(() => undefined) } }
		const result = await plugin.hotUpdate({ file: join(outDir, "src/app.ts"), modules: [], server })
		expect(result).toBeUndefined()
	})

	it("hotUpdate generates once per save across environments", async () => {
		writeTempApp(outDir)
		const plugin = getCodegenPlugin({ app: "src/app.ts", watch: ["src/**/*.ts"] })
		plugin.configResolved({ root: outDir })
		const server = { moduleGraph: { getModuleById: () => undefined } }
		const ctx = { file: join(outDir, "src/app.ts"), modules: [], server, timestamp: 42 }
		const tree = join(outDir, "src/_gen/routes.gen.ts")

		await plugin.hotUpdate.call({ environment: { moduleGraph: server.moduleGraph } }, ctx)
		rmSync(tree)
		await plugin.hotUpdate.call({ environment: { moduleGraph: server.moduleGraph } }, ctx)
		/* the second environment reused the first run instead of generating again */
		expect(existsSync(tree)).toBe(false)
	})

	it("hotUpdate ignores generated outputs, even when they match watch", async () => {
		writeTempApp(outDir)
		const plugin = getCodegenPlugin({
			app: "src/app.ts",
			codegen: { manifest: "out/manifest.json" },
			watch: ["**/*"],
		})
		plugin.configResolved({ root: outDir })
		const server = { moduleGraph: { getModuleById: () => undefined } }
		for (const file of ["src/_gen/routes.gen.ts", "out/manifest.json"]) {
			await plugin.hotUpdate({ file: join(outDir, file), modules: [], server })
		}
		expect(existsSync(join(outDir, "src/_gen/routes.gen.ts"))).toBe(false)
	})

	it("hotUpdate ignores non-matching files", async () => {
		const plugin = getCodegenPlugin({
			app: "src/app.ts",
			watch: ["src/routes/**/*.ts"],
		})
		const server = {
			moduleGraph: { getModuleById: vi.fn(() => null) },
			reloadModule: vi.fn(),
		}

		plugin.configResolved({ root: "/project" })
		const result = await plugin.hotUpdate({
			file: "/project/src/utils/helper.ts",
			modules: [] as { id: string | null }[],
			server,
		})
		expect(result).toBeUndefined()
		expect(server.moduleGraph.getModuleById).not.toHaveBeenCalled()
	})

	it("load returns route tree for virtual module with moduleType", async () => {
		writeTempApp(outDir)
		const plugin = getCodegenPlugin({ app: "src/app.ts" })
		plugin.configResolved({ root: outDir })

		const result = await plugin.load("\0virtual:honey/routes")
		expect(result).toBeDefined()
		expect(result?.code).toContain("health")
		expect(result?.moduleType).toBe("js")
		/* JavaScript, not the TypeScript the tree codegen writes to disk */
		expect(result?.code).not.toMatch(/import type|: TreeNode|as unknown as/)
	})

	it("virtual route tree loads in a real Vite dev server", async () => {
		writeTempApp(outDir)
		const { createServer, defaultServerConditions } = await import("vite")
		const server = await createServer({
			configFile: false,
			logLevel: "silent",
			plugins: honeyVitePlugin({ app: "src/app.ts", codegen: { tree: false } }),
			root: outDir,
			server: { middlewareMode: true, ws: false },
			ssr: { resolve: { conditions: ["honey-source", ...defaultServerConditions] } },
		})
		try {
			const mod = (await server.ssrLoadModule("virtual:honey/routes")) as Record<string, unknown>
			expect(Object.keys(mod).length).toBeGreaterThan(0)
		} finally {
			await server.close()
		}
	})

	it("virtual openapi module applies the configured profile", async () => {
		writeTempApp(outDir)
		const plugin = getCodegenPlugin({
			app: "src/app.ts",
			codegen: { openApi: { profile: "nope", title: "T", version: "1" } },
		})
		plugin.configResolved({ root: outDir })
		/* an unknown profile is rejected, which proves the profile reached generateOpenApi */
		await expect(plugin.load("\0virtual:honey/openapi")).rejects.toThrow(/profile/i)
	})

	it("load returns undefined for non-virtual ids", async () => {
		const plugin = getCodegenPlugin({ app: "src/app.ts" })
		const result = await plugin.load("./other.ts")
		expect(result).toBeUndefined()
	})

	it("named export (export const app) is auto-detected", async () => {
		writeTempApp(outDir, { named: true })
		const plugin = getCodegenPlugin({ app: "src/app.ts" })
		plugin.configResolved({ root: outDir })
		await plugin.buildStart()

		const content = readFileSync(join(outDir, "src/_gen/routes.gen.ts"), "utf-8")
		expect(content).toContain("health")
	})

	it("mergeTree generates tree from separate file", async () => {
		writeTempApp(outDir)
		writeMergeTreeFile(outDir, "app")
		const plugin = getCodegenPlugin({
			app: "src/app.ts",
			codegen: { mergeTree: "src/routes.ts", tree: "src/_gen/routes.gen.ts" },
		})
		plugin.configResolved({ root: outDir })
		await plugin.buildStart()

		const content = readFileSync(join(outDir, "src/_gen/routes.gen.ts"), "utf-8")
		expect(content).toContain("TreeNode")
		expect(content).toContain("health")
	})

	it("custom codegen output paths are respected", async () => {
		writeTempApp(outDir)
		const plugin = getCodegenPlugin({
			app: "src/app.ts",
			codegen: {
				manifest: "gen/manifest.json",
				tree: "gen/routes.gen.ts",
			},
		})
		mkdirSync(join(outDir, "gen"), { recursive: true })
		plugin.configResolved({ root: outDir })
		await plugin.buildStart()

		expect(existsSync(join(outDir, "gen/routes.gen.ts"))).toBe(true)
		expect(existsSync(join(outDir, "gen/manifest.json"))).toBe(true)
		expect(readFileSync(join(outDir, "gen/routes.gen.ts"), "utf-8")).toContain("health")
	})

	it("tree defaults to true, other codegen defaults to false", () => {
		const resolved = resolveHoneyConfig({ app: "src/app.ts" })
		expect(resolved.codegen.tree).toBe("src/_gen/routes.gen.ts")
		expect(resolved.codegen.types).toBe(false)
		expect(resolved.codegen.manifest).toBe(false)
		expect(resolved.codegen.openApi).toBe(false)
		expect(resolved.codegen.sdk).toBe(false)
		expect(resolved.codegen.mergeTree).toBeUndefined()
	})

	it("codegen boolean true resolves to default paths", () => {
		const resolved = resolveHoneyConfig({
			app: "src/app.ts",
			codegen: { manifest: true, sdk: true, tree: true, types: true },
		})
		expect(resolved.codegen.tree).toBe("src/_gen/routes.gen.ts")
		expect(resolved.codegen.manifest).toBe("src/_gen/manifest.gen.json")
		expect(typeof resolved.codegen.types).toBe("object")
		if (resolved.codegen.types) {
			expect(resolved.codegen.types.path).toBe("src/_gen/types.gen.d.ts")
		}
		if (resolved.codegen.sdk) {
			expect(resolved.codegen.sdk.ports.typescript?.outDir).toBe("src/_gen")
		}
	})

	it("codegen false disables tree generation", async () => {
		writeTempApp(outDir)
		const plugin = getCodegenPlugin({
			app: "src/app.ts",
			codegen: { tree: false },
		})
		plugin.configResolved({ root: outDir })
		await plugin.buildStart()

		expect(existsSync(join(outDir, "src/_gen/routes.gen.ts"))).toBe(false)
	})

	it("with a config file, generation runs in a child process that sees edits to imported modules", async () => {
		mkdirSync(join(outDir, "src"), { recursive: true })
		writeFileSync(join(outDir, "src/routes.ts"), 'export const path = "/first"\n')
		writeFileSync(
			join(outDir, "src/app.ts"),
			[
				'import { honey } from "@lovrozagar/honey"',
				'import { path } from "./routes.ts"',
				'export const app = honey().get(path).handler((ctx) => ctx.res.text("ok", "ok"))',
			].join("\n"),
		)
		const configFile = join(outDir, "vite.config.ts")
		writeFileSync(
			configFile,
			[
				'import { honey } from "@lovrozagar/honey/plugin"',
				'export default { plugins: [honey({ app: "src/app.ts", codegen: { tree: "src/_gen/routes.gen.ts" } })] }',
			].join("\n"),
		)
		const plugin = getCodegenPlugin({ app: "src/app.ts" })
		plugin.configResolved({ command: "build", configFile, plugins: [{ name: "other" }, plugin], root: outDir })
		const tree = join(outDir, "src/_gen/routes.gen.ts")

		await plugin.buildStart()
		expect(readFileSync(tree, "utf-8")).toContain("first")

		writeFileSync(join(outDir, "src/routes.ts"), 'export const path = "/second"\n')
		await plugin.buildStart()
		expect(readFileSync(tree, "utf-8")).toContain("second")
	}, 30_000)
})
