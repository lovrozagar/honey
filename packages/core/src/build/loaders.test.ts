/**
 * The build tooling's loaders (bit 19 h2): a TypeScript Vite config found and read on plain Node through jiti (v0
 * H70b), each module evaluated once per loader, the `honey()` configs read off the plugin objects, the package's
 * source aliases, and Effect's converter when effect is installed.
 */
import { execFile } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import {
	createModuleLoader,
	effectConverter,
	findViteConfig,
	loadPluginConfigs,
	type ModuleLoader,
	sourceAliases,
} from "./loaders.ts"

const LOADERS = new URL("./loaders.ts", import.meta.url).pathname
const ENV = { command: "build", mode: "production" } as const
const dirs: string[] = []

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

/** A temp directory holding `files`. */
function project(files: Record<string, string>): string {
	const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "core-loaders-"))
	dirs.push(dir)
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(join(dir, name, ".."), { recursive: true })
		writeFileSync(join(dir, name), text)
	}
	return dir
}

/** A `honey()` plugin object as the plugin presents one, carrying `config`. */
const honeyPlugin = (config: string) => `{ name: "honey", api: { honeyConfig: ${config} } }`

describe("a Vite config read on plain Node (bit 19 h2)", () => {
	// v0: bd0ee20213
	it("H70b: `honey generate` on plain Node finds the Vite config", async () => {
		const dir = project({
			/* an enum: syntax Node's type stripping refuses, so only jiti can load this config */
			"plugin.ts": `enum Kind { Tree = "tree" }\nexport const honey = (app: string) => (${honeyPlugin("{ app, codegen: Kind.Tree }")})\n`,
			"vite.config.ts": 'import { honey } from "./plugin"\nexport default { plugins: [honey("src/app.ts")] }\n',
		})
		const script = [
			`import { createModuleLoader, findViteConfig, loadPluginConfigs } from ${JSON.stringify(LOADERS)}`,
			`const config = findViteConfig(${JSON.stringify(dir)})`,
			`const load = await createModuleLoader({ fresh: false, from: config })`,
			`console.log(JSON.stringify(await loadPluginConfigs(config, load, { command: "build", mode: "production" })))`,
		].join("\n")
		/* plain Node, as a user starts it: never Bun, which loads TypeScript on its own */
		const read = await promisify(execFile)("node", ["--input-type=module", "-e", script], { cwd: dir }).then(
			({ stdout }) => JSON.parse(stdout) as unknown,
			(error: { stderr?: string }) => error.stderr,
		)
		expect(read).toEqual([{ app: "src/app.ts", codegen: "tree" }])
	}, 60_000)

	it("finds the config by Vite's own order, and none in a directory without one", () => {
		const both = project({ "vite.config.js": "", "vite.config.mts": "" })
		expect([findViteConfig(both), findViteConfig(project({}))]).toEqual([join(both, "vite.config.mts"), undefined])
	})
})

describe("each honey() config in a Vite config, in plugin order (bit 19 h2)", () => {
	const configsOf = async (config: string) => {
		const dir = project({ "vite.config.ts": config })
		return loadPluginConfigs(join(dir, "vite.config.ts"), await createModuleLoader({ fresh: true, from: dir }), ENV)
	}

	it("reads nested and promised plugin arrays, a function-form config called with the env", async () => {
		const config = [
			`const a = ${honeyPlugin('{ app: "a" }')}`,
			`const b = ${honeyPlugin('{ app: "b" }')}`,
			"export default (env) => ({",
			`  plugins: [{ name: "other" }, null, [a, Promise.resolve([${honeyPlugin("{ app: env.mode, ssr: env.isSsrBuild }")}])], Promise.resolve(b)],`,
			"})",
		].join("\n")
		expect(await configsOf(config)).toEqual([{ app: "a" }, { app: "production", ssr: false }, { app: "b" }])
	})

	it("reads a module-form config, and passes over a honey-named plugin without a config", async () => {
		const config = `export const plugins = [{ name: "honey" }, { name: "honey", api: {} }, ${honeyPlugin("{ app: 1 }")}]`
		expect([await configsOf(config), await configsOf("export default {}")]).toEqual([[{ app: 1 }], []])
	})
})

describe("a module loader for one generation (bit 19 h2)", () => {
	/* each evaluation counts on globalThis, so a re-evaluated module shows */
	const counted = (load: ModuleLoader, path: string) => load(path).then((mod) => mod.n)

	it("evaluates each path once per loader; a fresh loader evaluates an edited module anew", async () => {
		const dir = project({ "count.ts": "globalThis.__loads = (globalThis.__loads ?? 0) + 1\nexport const n = 1\n" })
		const path = join(dir, "count.ts")
		const load = await createModuleLoader({ fresh: true, from: dir })
		const first = [await counted(load, path), await counted(load, path)]
		writeFileSync(path, "globalThis.__loads = (globalThis.__loads ?? 0) + 1\nexport const n = 2\n")
		const fresh = await counted(await createModuleLoader({ fresh: true, from: dir }), path)
		expect([first, fresh, (globalThis as { __loads?: number }).__loads]).toEqual([[1, 1], 2, 2])
	})

	it("maps an aliased specifier to its file", async () => {
		const dir = project({ "app.ts": 'export { v } from "@scope/lib"\n', "lib.ts": "export const v = 7\n" })
		const load = await createModuleLoader({ alias: { "@scope/lib": join(dir, "lib.ts") }, fresh: false, from: dir })
		expect((await load(join(dir, "app.ts"))).v).toBe(7)
	})
})

describe("the package's source aliases (bit 19 h2)", () => {
	it("maps each export naming a honey-source file, and none without one", () => {
		const exports = {
			".": { "honey-source": "./src/index.ts" },
			"./plain": "./dist/plain.js",
			"./serve": { "honey-source": "./src/serve.ts" },
		}
		const pkg = project({ "package.json": JSON.stringify({ exports, name: "@x/honey" }) })
		const bare = project({ "package.json": JSON.stringify({ exports: { ".": "./dist/index.js" }, name: "@x/honey" }) })
		const unnamed = project({ "package.json": JSON.stringify({ exports }) })
		const none = project({ "package.json": JSON.stringify({ name: "@x/honey" }) })
		expect([
			sourceAliases(pkg),
			sourceAliases(bare),
			sourceAliases(unnamed),
			sourceAliases(none),
			sourceAliases(project({})),
		]).toEqual([
			{ "@x/honey": join(pkg, "src/index.ts"), "@x/honey/serve": join(pkg, "src/serve.ts") },
			undefined,
			undefined,
			undefined,
			undefined,
		])
	})
})

describe("Effect's JSON Schema converter (bit 19 h2)", () => {
	it("is effect's JSONSchema.make when effect is installed, else undefined", async () => {
		const make = await effectConverter()
		expect([
			(make?.(Schema.String as never) as { type?: string } | undefined)?.type,
			await effectConverter("node:path"),
			await effectConverter("no-such-module-honey"),
		]).toEqual(["string", undefined, undefined])
	})
})
