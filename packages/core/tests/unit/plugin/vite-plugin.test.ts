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
		'import { honey } from "honey"',
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
	const code = [
		`import app from "./${appRelPath.replace(/\.ts$/, "")}"`,
		"",
		"export default app.toRouteTree()",
	].join("\n")
	const filePath = join(srcDir, "routes.ts")
	writeFileSync(filePath, code, "utf-8")
	return filePath
}

type PluginObj = Record<string, unknown> & {
	buildStart(): Promise<void>
	configResolved(cfg: { root: string }): void
	hotUpdate(ctx: {
		file: string
		modules: unknown[]
		server: {
			moduleGraph: { getModuleById(id: string): unknown }
			reloadModule(mod: unknown): void
		}
	}): Promise<unknown[] | undefined>
	load(id: string): Promise<{ code: string; moduleType: string } | undefined>
	name: string
	resolveId(id: string): string | undefined
}

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

		const spec = JSON.parse(
			readFileSync(join(outDir, "src/_gen/openapi.gen.json"), "utf-8"),
		) as Record<string, Record<string, unknown>>
		expect(spec.openapi).toBe("3.1.0")
		expect((spec.info as Record<string, unknown>).title).toBe("Test")
		expect(
			(spec.paths as Record<string, Record<string, Record<string, unknown>>>)["/items"].post
				.requestBody,
		).toBeDefined()
	})

	it("buildStart writes manifest", async () => {
		writeTempApp(outDir)
		const plugin = getCodegenPlugin({ app: "src/app.ts", codegen: { manifest: true } })
		plugin.configResolved({ root: outDir })
		await plugin.buildStart()

		const manifest = JSON.parse(
			readFileSync(join(outDir, "src/_gen/manifest.gen.json"), "utf-8"),
		) as {
			routes: unknown[]
		}
		expect(manifest.routes).toHaveLength(2)
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

		const result = await plugin.hotUpdate({
			file: "/project/src/utils/helper.ts",
			modules: [] as { id: string | null }[],
			server,
		})
		expect(result).toBeUndefined()
		expect(server.reloadModule).not.toHaveBeenCalled()
	})

	it("load returns route tree for virtual module with moduleType", async () => {
		writeTempApp(outDir)
		const plugin = getCodegenPlugin({ app: "src/app.ts" })
		plugin.configResolved({ root: outDir })

		const result = await plugin.load("\0virtual:honey/routes")
		expect(result).toBeDefined()
		expect(result?.code).toContain("TreeNode")
		expect(result?.code).toContain("health")
		expect(result?.moduleType).toBe("js")
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
			expect(resolved.codegen.sdk.path).toBe("src/_gen/sdk.gen.ts")
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
})
