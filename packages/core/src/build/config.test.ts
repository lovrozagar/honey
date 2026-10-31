/**
 * honey()'s config (bit 19 h2): the route tree on by default and every other artifact off, `true` as each default
 * path, the OpenAPI outputs as a list, the `.yaml`/`.yml` output rule (Q7), the SDK and CLI keys refused as
 * honey-clients's (Q1), and the outputs a watcher ignores.
 */
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
	generatedOutputs,
	type HoneyVitePluginConfig,
	isGeneratedOutput,
	MCP_COMPANIONS,
	mcpPaths,
	openApiOutputPaths,
	resolveHoneyConfig,
} from "./config.ts"

describe("resolveHoneyConfig (bit 19 h2)", () => {
	// v0: a07a9c0bf4
	it("turns the route tree on by default and every other artifact off", () => {
		expect(resolveHoneyConfig({ app: "src/app.ts" })).toEqual({
			app: "src/app.ts",
			codegen: {
				invalidate: undefined,
				manifest: false,
				mcp: false,
				mergeTree: undefined,
				openApi: [],
				tree: "src/_gen/routes.gen.ts",
				types: false,
			},
			watch: [],
		})
	})

	// v0: 757d938e2a
	it("reads true as each default path, a string as the path, and false as off", () => {
		const on = resolveHoneyConfig({ codegen: { manifest: true, tree: true, types: true } }).codegen
		const paths = resolveHoneyConfig({
			codegen: { manifest: "gen/m.json", tree: "gen/r.ts", types: { baseCtxName: "Ctx", path: "gen/t.d.ts" } },
		}).codegen
		const off = resolveHoneyConfig({ codegen: { manifest: false, tree: false, types: false } }).codegen
		expect([on.manifest, on.tree, on.types]).toEqual([
			"src/_gen/manifest.gen.json",
			"src/_gen/routes.gen.ts",
			{ baseCtxName: undefined, path: "src/_gen/types.gen.d.ts" },
		])
		expect([paths.manifest, paths.tree, paths.types]).toEqual([
			"gen/m.json",
			"gen/r.ts",
			{ baseCtxName: "Ctx", path: "gen/t.d.ts" },
		])
		expect([off.manifest, off.tree, off.types]).toEqual([false, false, false])
		expect(resolveHoneyConfig({ codegen: { types: "gen/x.d.ts" } }).codegen.types).toEqual({
			baseCtxName: undefined,
			path: "gen/x.d.ts",
		})
		expect(resolveHoneyConfig({ codegen: { types: {} } }).codegen.types).toEqual({
			baseCtxName: undefined,
			path: "src/_gen/types.gen.d.ts",
		})
	})
})

describe("resolveHoneyConfig (bit 19 h2), continued (2)", () => {
	it("takes one OpenAPI output or several, each at its own path or the default, its options kept", () => {
		const filterRoutes = () => true
		const one = resolveHoneyConfig({ codegen: { openApi: { title: "A", version: "1" } } }).codegen.openApi
		const many = resolveHoneyConfig({
			codegen: {
				openApi: [
					{ title: "A", version: "1" },
					{ filterRoutes, path: "b.yaml", sanitize: { stripXExtensions: true }, title: "B", version: "2" },
				],
			},
		}).codegen.openApi
		expect(one).toEqual([{ path: "src/_gen/openapi.gen.json", title: "A", version: "1" }])
		expect(many).toEqual([
			{ path: "src/_gen/openapi.gen.json", title: "A", version: "1" },
			{ filterRoutes, path: "b.yaml", sanitize: { stripXExtensions: true }, title: "B", version: "2" },
		])
	})

	it("refuses the SDK and CLI keys, which are honey-clients's (Q1)", () => {
		for (const key of ["sdk", "cli"])
			expect(() => resolveHoneyConfig({ codegen: { [key]: true } } as HoneyVitePluginConfig)).toThrow(
				`codegen.${key}: the SDKs, the CLI and MCP are honey-clients's: honey-clients generate --app`,
			)
	})
})

describe("openApiOutputPaths: the .yaml/.yml rule (bit 19 h2, Q7)", () => {
	// v0: ae748154a5
	// v0: ad73c602a0
	// v0: b9beb5f0ab
	it("writes JSON with a .yaml sibling, unless the path is YAML itself", () => {
		expect(
			["src/_gen/openapi.gen.json", "docs/openapi", "openapi.yml", "openapi.yaml"].map(openApiOutputPaths),
		).toEqual([
			{ json: "src/_gen/openapi.gen.json", yaml: "src/_gen/openapi.gen.yaml" },
			{ json: "docs/openapi", yaml: "docs/openapi.yaml" },
			{ json: null, yaml: "openapi.yml" },
			{ json: null, yaml: "openapi.yaml" },
		])
	})
})

describe("generatedOutputs (bit 19 h2)", () => {
	it("lists every file a generation writes, absolute, and the directories they sit in", () => {
		const config = resolveHoneyConfig({
			codegen: {
				manifest: "out/m.json",
				mcp: "gen/server.ts",
				openApi: [
					{ title: "A", version: "1" },
					{ path: "docs/b.yml", title: "B", version: "1" },
				],
				types: true,
			},
		})
		const outputs = generatedOutputs(config, "/p")
		expect(outputs).toEqual({
			dirs: ["/p/src/_gen", "/p/out", "/p/gen", "/p/gen/server", "/p/docs"],
			files: [
				"/p/src/_gen/routes.gen.ts",
				"/p/src/_gen/types.gen.d.ts",
				"/p/out/m.json",
				"/p/gen/server.ts",
				...MCP_COMPANIONS.map((name) => `/p/gen/server/${name}`),
				"/p/src/_gen/openapi.gen.json",
				"/p/src/_gen/openapi.gen.yaml",
				"/p/docs/b.yml",
			],
		})
		expect(
			[join("/p", "out/m.json"), "/p/out/m.json.x", "/p/src/app.ts"].map((file) => isGeneratedOutput(file, outputs)),
		).toEqual([true, false, false])
	})
})

describe("resolveHoneyConfig's MCP handler (bit 21 e)", () => {
	it("reads true as src/_gen/mcp.gen.ts, a string as the path, an object with its options; its stem the directory", () => {
		const filterRoutes = () => true
		const outputs = [
			true,
			"gen/tools.ts",
			{ filterRoutes, name: "shop", path: "gen/x.gen.ts", securitySchemes: { k: {} } },
			{},
			false,
		].map((mcp) => resolveHoneyConfig({ codegen: { mcp } }).codegen.mcp)
		expect(outputs).toEqual([
			{ dir: "mcp", path: "src/_gen/mcp.gen.ts" },
			{ dir: "tools", path: "gen/tools.ts" },
			{ dir: "x", filterRoutes, name: "shop", path: "gen/x.gen.ts", securitySchemes: { k: {} } },
			{ dir: "mcp", path: "src/_gen/mcp.gen.ts" },
			false,
		])
	})

	it("refuses an MCP output path that is no .ts module, and lists no file when the output is off", () => {
		expect(() => resolveHoneyConfig({ codegen: { mcp: "gen/mcp.js" } })).toThrow(
			'codegen.mcp: "gen/mcp.js" is no .ts module',
		)
		expect(mcpPaths(false)).toEqual([])
	})
})
