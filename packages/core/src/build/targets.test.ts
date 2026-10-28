/**
 * The build plugin's shape per target (bit 19 h2, ported from v0's build-plugin.test.ts): a virtual entry that serves
 * the app on node and bun as `serve(app)` does and exports its fetch on a Worker; node's builtins external everywhere,
 * dependencies bundled for a Worker alone, and no other target (H15). v0's five feature-detection cases retire (Q4, H23).
 */
import { describe, expect, it } from "vitest"
import { type BuildTarget, createBuildPlugin, type HoneyBuildConfig } from "./targets.ts"

const APP = { entry: "src/app.ts", export: "app" }

const plugin = (target: BuildTarget, overrides?: Partial<HoneyBuildConfig>) =>
	createBuildPlugin({ target, ...overrides }, APP)

/** The entry module the plugin answers for its virtual id on node or bun. */
const entryOf = (built: ReturnType<typeof createBuildPlugin>) =>
	(built.load.call(context([]), "\0virtual:honey-build-entry") as { code: string } | undefined)?.code ?? ""

/** A build's context whose app entry exports `exports`, or that resolves no entry at all. */
function context(exports: readonly string[], resolved = true) {
	return {
		load: async ({ id }: { id: string }) => ({ exports: id === "/app/src/app.ts" ? exports : null }),
		resolve: async (source: string) => (resolved && source === "./src/app.ts" ? { id: "/app/src/app.ts" } : null),
	}
}

/** The Worker entry the plugin answers on cloudflare, its app entry exporting `exports`. */
const workerOf = async (exports: readonly string[], app = APP) =>
	(
		(await createBuildPlugin({ target: "cloudflare" }, app).load.call(
			context(exports),
			"\0virtual:honey-build-entry",
		)) as {
			code: string
		}
	).code

type Built = {
	build: {
		emptyOutDir: boolean
		minify: boolean
		outDir: string
		rolldownOptions: { external: string[]; input: string; output: { entryFileNames: string } }
		ssr: boolean
	}
	ssr: { noExternal?: boolean; target: string }
}
const configOf = (built: ReturnType<typeof createBuildPlugin>) => built.config() as Built

describe("the build plugin's identity and virtual entry (bit 19 h2)", () => {
	// v0: fc4b7f62c0
	it("has name honey:build", () => {
		expect(plugin("node").name).toBe("honey:build")
	})

	// v0: db1b9397b6
	it("has apply build", () => {
		expect(plugin("node").apply).toBe("build")
	})

	// v0: 74e64e5f9a
	it("resolves virtual:honey-build-entry", () => {
		expect(plugin("node").resolveId("virtual:honey-build-entry")).toBe("\0virtual:honey-build-entry")
	})

	// v0: b28cd2009c
	it("returns undefined for other ids from resolveId", () => {
		expect(plugin("node").resolveId("./other.ts")).toBeUndefined()
	})

	// v0: b0b0937126
	it("loads entry code with moduleType js", () => {
		const loaded = plugin("node").load.call(context([]), "\0virtual:honey-build-entry") as
			| { code: string; moduleType: string }
			| undefined
		expect([loaded?.moduleType, Boolean(loaded?.code)]).toEqual(["js", true])
	})

	// v0: 8896ddb8da
	it("returns undefined for other ids from load", () => {
		expect(plugin("node").load.call(context([]), "./other.ts")).toBeUndefined()
	})

	it("refuses a target it does not build (H15)", () => {
		const refused = (target: string) => () => createBuildPlugin({ target: target as BuildTarget }, APP)
		expect(refused("lambda")).toThrow('honey build: unknown target "lambda"; expected node, bun or cloudflare')
		expect(refused("toString")).toThrow('unknown target "toString"')
	})
})

describe("the build plugin's Vite config (bit 19 h2)", () => {
	// v0: 720f473777
	it("returns SSR build settings", () => {
		const built = configOf(plugin("node"))
		expect([built.ssr, built.build]).toMatchObject([
			{ target: "node" },
			{ emptyOutDir: false, minify: true, outDir: "./dist", ssr: true },
		])
	})

	// v0: b11404b0af
	it("externals include all node builtins in both forms", () => {
		const { external } = configOf(plugin("node")).build.rolldownOptions
		expect(["fs", "node:fs", "path", "node:path"].every((name) => external.includes(name))).toBe(true)
	})

	// v0: 46e06340fb
	it("includes user-provided externals", () => {
		expect(configOf(plugin("node", { external: ["pg-native"] })).build.rolldownOptions.external).toContain("pg-native")
	})

	// v0: fe2dfed53e
	it("respects custom outDir", () => {
		expect(configOf(plugin("node", { outDir: "./out" })).build.outDir).toBe("./out")
	})

	// v0: 98af09fd33
	it("respects minify false", () => {
		expect(configOf(plugin("node", { minify: false })).build.minify).toBe(false)
	})

	// v0: 85bfe318e6
	it("keeps dependencies external on node and bun, bundles them for workers", () => {
		const noExternal = (target: BuildTarget) => configOf(plugin(target)).ssr.noExternal
		expect([noExternal("node"), noExternal("bun"), noExternal("cloudflare")]).toEqual([undefined, undefined, true])
	})

	// v0: 4e76fd1ac8
	it("uses webworker target for cloudflare", () => {
		expect(configOf(plugin("cloudflare")).ssr.target).toBe("webworker")
	})

	// v0: 691881c0a0
	it("uses node target for bun", () => {
		expect(configOf(plugin("bun")).ssr.target).toBe("node")
	})

	// v0: a8e8fac3ee
	it("sets rolldown input to virtual entry", () => {
		expect(configOf(plugin("node")).build.rolldownOptions.input).toBe("virtual:honey-build-entry")
	})

	// v0: 4be4036e68
	it("sets output entryFileNames to index.js", () => {
		expect(configOf(plugin("node")).build.rolldownOptions.output.entryFileNames).toBe("index.js")
	})
})

describe("the build entry per target (bit 19 h2)", () => {
	// v0: 18a35528c9
	it("uses named import for non-default export", () => {
		const built = createBuildPlugin({ target: "node" }, { entry: "src/app.ts", export: "myApp" })
		expect(entryOf(built)).toContain('import { myApp as app } from "./src/app.ts"')
	})

	// v0: 45cd1541d9
	it("uses default import for default export", () => {
		const built = createBuildPlugin({ target: "node" }, { entry: "src/app.ts", export: "default" })
		expect(entryOf(built)).toContain('import app from "./src/app.ts"')
	})

	// v0: 12d6f6b97b
	it.each(["node", "bun"] as const)("%s: serves as serve(app) does, the process's env, on 0.0.0.0", (target) => {
		const entry = entryOf(plugin(target))
		/* v1's serve() reads the runtime itself, so the entry names none */
		expect([
			entry.includes('import { serve } from "@lovrozagar/honey/serve"'),
			entry.includes('await serve(app, { env: process.env, hostname: "0.0.0.0"'),
			entry.includes("runtime"),
		]).toEqual([true, true, false])
	})

	// v0: 2d87632512
	it("node and bun pass process.env and default to port 3000", () => {
		for (const target of ["node", "bun"] as const) {
			expect(entryOf(plugin(target))).toContain("env: process.env")
			expect(entryOf(plugin(target))).toContain("process.env.PORT ?? 3000")
		}
	})

	// v0: 5be21ce88e
	it("uses a custom port", () => {
		expect(entryOf(plugin("node", { port: 8080 }))).toContain("process.env.PORT ?? 8080")
		expect(entryOf(plugin("bun", { port: 4000 }))).toContain("process.env.PORT ?? 4000")
	})
})

describe("the build entry on cloudflare (bit 19 h2)", () => {
	// v0: d3d2b0e62d
	it("exports default with fetch on cloudflare", async () => {
		const entry = await workerOf(["app"])
		expect([entry.includes("export default {"), entry.includes("app.fetch(req, env, ctx)")]).toEqual([true, true])
	})

	// v0: 859e502913
	it("has no port variable or PORT env reference on cloudflare", async () => {
		const entry = await workerOf(["app"])
		expect([entry.includes("const port"), entry.includes("PORT"), entry.includes("serve")]).toEqual([
			false,
			false,
			false,
		])
	})

	// v0: 5057aca745
	it("ignores port config silently on cloudflare", async () => {
		const built = plugin("cloudflare", { port: 9999 })
		const entry = (await built.load.call(context(["app"]), "\0virtual:honey-build-entry")) as { code: string }
		expect(entry.code).not.toContain("9999")
	})
})

describe("a Worker's named exports (bit 21 h)", () => {
	it("passes every named export of the app's entry through, beside honey's default fetch, the app itself not", async () => {
		const entry = await workerOf(["app", "McpUploads", "Jobs", "with-dash"])
		expect([
			entry.includes('export { McpUploads, Jobs, "with-dash" } from "./src/app.ts"'),
			entry.includes("export default {"),
			/\bexport \{[^}]*\bapp\b/.test(entry),
		]).toEqual([true, true, false])
	})

	it("passes them on beside an app that is the entry's default export", async () => {
		const entry = await workerOf(["default", "McpUploads"], { entry: "src/app.ts", export: "default" })
		expect([
			entry.includes('import app from "./src/app.ts"'),
			entry.includes('export { McpUploads } from "./src/app.ts"'),
		]).toEqual([true, true])
	})

	it("adds no export line when the entry has none beside the app", async () => {
		expect((await workerOf(["app"])).includes("export {")).toBe(false)
	})

	it("refuses an entry exporting a default beside its named app: a Worker's default is honey's fetch", async () => {
		await expect(workerOf(["app", "default", "McpUploads"])).rejects.toThrow(
			"honey build: src/app.ts exports a default beside its app \"app\": a Worker's default export is honey's fetch handler, so the entry's own default would be lost; drop it, or export the app as the default",
		)
	})

	it("refuses an app entry the build cannot resolve", async () => {
		const built = createBuildPlugin({ target: "cloudflare" }, APP)
		await expect(built.load.call(context([], false), "\0virtual:honey-build-entry")).rejects.toThrow(
			"honey build: cannot resolve the app entry ./src/app.ts",
		)
	})

	it.each(["node", "bun"] as const)("%s: no export is passed on: a server's module exports nothing", (target) => {
		expect(entryOf(plugin(target)).includes("export")).toBe(false)
	})
})
