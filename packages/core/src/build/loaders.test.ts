/**
 * The build tooling's loaders (bit 19 h2): a TypeScript Vite config found and read on plain Node through jiti (v0
 * H70b), each module evaluated once per loader, through Bun's own import on Bun, the `honey()` configs read off the
 * plugin objects, and Effect's converter when effect is installed.
 */
import { execFile } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createModuleLoader, effectConverter, findViteConfig, loadPluginConfigs, type ModuleLoader } from "./loaders.ts"

const LOADERS = new URL("./loaders.ts", import.meta.url).pathname
const ENV = { command: "build", mode: "production" } as const
const dirs: string[] = []

afterEach(() => {
	vi.unstubAllGlobals()
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

	it("on Bun, imports each path once per loader; a fresh loader evicts what Bun holds outside node_modules", async () => {
		const dir = project({ "native.ts": "globalThis.__native = (globalThis.__native ?? 0) + 1\nexport const n = 3\n" })
		const path = join(dir, "native.ts")
		/* Bun's registry as the loader sees it: an installed module, and a module of the project's */
		const registry = () => ({ "/p/node_modules/dep/index.js": 1, "/p/src/app.ts": 1 })
		const [kept, evicted] = [registry(), registry()]
		const load = await createModuleLoader({ fresh: false, from: dir }, kept)
		const first = [await counted(load, path), await counted(load, path)]
		await createModuleLoader({ fresh: true, from: dir }, evicted)
		expect([first, (globalThis as { __native?: number }).__native, Object.keys(kept), Object.keys(evicted)]).toEqual([
			[3, 3],
			1,
			["/p/node_modules/dep/index.js", "/p/src/app.ts"],
			["/p/node_modules/dep/index.js"],
		])
	})
})

describe("a module loader on Bun's global (bit 20 k-fix)", () => {
	it("takes Bun's module registry, and imports a module as Bun's own import does", async () => {
		const dir = project({ "plain.ts": "export const v = 9\n" })
		vi.stubGlobal("Bun", {})
		/* not fresh: a fresh loader would evict from the registry this test runner's process holds */
		const load = await createModuleLoader({ fresh: false, from: dir })
		expect((await load(join(dir, "plain.ts"))).v).toBe(9)
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
