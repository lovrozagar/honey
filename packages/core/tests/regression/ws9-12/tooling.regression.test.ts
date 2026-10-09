/* Regression tests for workstream 12 (tooling): generated-file writes, watch globs, stale outputs,
 * the CLI watch loop and the Node config hand-off. Each test names its finding and fails on 3ab88ce.
 * The temp apps import honey by path, so in an extracted old tree they load that tree's source. */

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { generateAndWrite, honey as honeyVitePlugin, resolveHoneyConfig } from "../../../src/plugin.ts"

const SRC = resolve(import.meta.dirname, "../../../src")
const ROOT = resolve(import.meta.dirname, "../../../.tmp-regress-ws12")

type HotUpdate = (ctx: { file: string; modules: unknown[]; server: unknown }) => Promise<unknown>

function writeApp(dir: string, routes: Array<[path: string, operationId: string]>): void {
	mkdirSync(join(dir, "src"), { recursive: true })
	const lines = routes.map(
		([path, operationId]) =>
			`app.get(${JSON.stringify(path)}).meta({ operationId: ${JSON.stringify(operationId)} }).handler((ctx) => ctx.res.text("ok", "ok"))`,
	)
	writeFileSync(
		join(dir, "src/app.ts"),
		[`import { honey } from ${JSON.stringify(join(SRC, "index.ts"))}`, "export const app = honey()", ...lines, ""].join(
			"\n",
		),
		"utf-8",
	)
}

/** Runs `bun src/cli.ts <args>` for `ms`, then stops it; resolves with its combined output. */
function runCli(
	cwd: string,
	args: string[],
	ms: number,
	runtime = "bun",
): Promise<{ code: number | null; out: string }> {
	return new Promise((done) => {
		const child = spawn(runtime, [join(SRC, "cli.ts"), ...args], { cwd, env: { ...process.env, NO_COLOR: "1" } })
		let out = ""
		child.stdout.on("data", (d: Buffer) => (out += d.toString()))
		child.stderr.on("data", (d: Buffer) => (out += d.toString()))
		const timer = setTimeout(() => child.kill("SIGTERM"), ms)
		child.on("close", (code) => {
			clearTimeout(timer)
			done({ code, out })
		})
	})
}

describe("workstream 12 regressions", () => {
	let dir: string

	beforeEach(() => {
		dir = join(ROOT, String(Math.random()).slice(2))
		mkdirSync(dir, { recursive: true })
	})

	afterEach(() => {
		rmSync(dir, { force: true, recursive: true })
	})

	// regression: M (plugin.ts:294-353)
	it("M (plugin.ts:294-353): a truncated generated file with a matching checksum header is rewritten", async () => {
		writeApp(dir, [["/health", "health"]])
		const config = resolveHoneyConfig({ app: "src/app.ts", codegen: { tree: true } })
		await generateAndWrite(config, dir)
		const file = join(dir, "src/_gen/routes.gen.ts")
		const full = readFileSync(file, "utf-8")
		/* keep only the header line: its checksum still matches what generation would write */
		writeFileSync(file, `${full.split("\n")[0]}\n`, "utf-8")
		await generateAndWrite(config, dir)
		expect(readFileSync(file, "utf-8")).toBe(full)
	}, 60_000)

	// regression: L (plugin.ts:332,342)
	it("L (plugin.ts:332,342): generated OpenAPI and manifest carry no non-x- top-level `_generated` key", async () => {
		writeApp(dir, [["/health", "health"]])
		const config = resolveHoneyConfig({
			app: "src/app.ts",
			codegen: { manifest: true, openApi: { title: "T", version: "1" } },
		})
		await generateAndWrite(config, dir)
		const openapi = JSON.parse(readFileSync(join(dir, "src/_gen/openapi.gen.json"), "utf-8")) as object
		const manifest = JSON.parse(readFileSync(join(dir, "src/_gen/manifest.gen.json"), "utf-8")) as object
		expect(openapi).not.toHaveProperty("_generated")
		expect(manifest).not.toHaveProperty("_generated")
	}, 60_000)

	// regression: M (plugin.ts:614-623)
	it.each([
		["src/**", "src/routes/users/list.ts"],
		["src/routes/**", "src/routes/users/list.ts"],
		["src/**/*.{ts,tsx}", "src/routes/page.tsx"],
		["./src/**/*.ts", "src/routes/users/list.ts"],
	])(
		"M (plugin.ts:614-623): watch pattern %s regenerates on %s",
		async (pattern, file) => {
			writeApp(dir, [["/health", "health"]])
			const plugin = honeyVitePlugin({ app: "src/app.ts", codegen: { tree: true }, watch: [pattern] })[0] as {
				configResolved(c: { root: string }): void
				hotUpdate: HotUpdate
			}
			plugin.configResolved({ root: dir })
			const server = { moduleGraph: { getModuleById: () => undefined } }
			await plugin.hotUpdate({ file: join(dir, file), modules: [], server })
			expect(existsSync(join(dir, "src/_gen/routes.gen.ts"))).toBe(true)
		},
		60_000,
	)

	// regression: M (plugin.ts:614-623)
	it("M (plugin.ts:614-623): src/**/*.ts does not match a file under node_modules", async () => {
		writeApp(dir, [["/health", "health"]])
		const plugin = honeyVitePlugin({ app: "src/app.ts", codegen: { tree: true }, watch: ["src/**/*.ts"] })[0] as {
			configResolved(c: { root: string }): void
			hotUpdate: HotUpdate
		}
		plugin.configResolved({ root: dir })
		const server = { moduleGraph: { getModuleById: () => undefined } }
		await plugin.hotUpdate({ file: join(dir, "node_modules/x/src/a.ts"), modules: [], server })
		expect(existsSync(join(dir, "src/_gen/routes.gen.ts"))).toBe(false)
	}, 60_000)

	// regression: M (plugin.ts:544-601; codegen-go-cli.ts:1171)
	it("M (plugin.ts:544-601): a Go CLI resource that no longer exists leaves no ghost command file", async () => {
		const config = resolveHoneyConfig({
			app: "src/app.ts",
			codegen: {
				cli: { binaryName: "demo", modulePath: "example.com/demo", out: "cli" },
				openApi: { title: "T", version: "1" },
			},
		})
		writeApp(dir, [
			["/pets", "pets.list"],
			["/owners", "owners.list"],
		])
		await generateAndWrite(config, dir)
		const cmd = join(dir, "cli/cmd")
		const before = readdirSync(cmd).filter((f) => f.includes("owners"))
		expect(before.length).toBeGreaterThan(0)
		writeApp(dir, [["/pets", "pets.list"]])
		await generateAndWrite(config, dir)
		expect(readdirSync(cmd).filter((f) => f.includes("owners"))).toEqual([])
	}, 120_000)

	// regression: M (plugin.ts:544-575; cli.ts:123,185-188)
	it("M (plugin.ts:544-575): CLI watch does not loop when an SDK out dir sits under the app's directory", async () => {
		writeApp(dir, [["/pets", "pets.list"]])
		writeFileSync(
			join(dir, "vite.config.ts"),
			[
				`import { honey } from ${JSON.stringify(join(SRC, "plugin.ts"))}`,
				"export default { plugins: [honey({ app: 'src/app.ts', codegen: { openApi: { title: 'T', version: '1' },",
				"  sdk: { ports: { python: { outDir: 'src/py-sdk' } } } } })] }",
				"",
			].join("\n"),
			"utf-8",
		)
		const { out } = await runCli(dir, ["generate", "--watch"], 8_000)
		const generations = out.split("\n").filter((l) => /honey: generated/.test(l)).length
		/* the Python port really wrote under src/, so its files were there to trigger the watcher */
		expect(existsSync(join(dir, "src/py-sdk/client.py")), out).toBe(true)
		expect(generations, out).toBeGreaterThanOrEqual(1)
		expect(generations, out).toBeLessThanOrEqual(2)
	}, 60_000)

	// regression: H70b
	it("H70b: `honey generate` on plain Node finds the Vite config", async () => {
		writeApp(dir, [["/pets", "pets.list"]])
		writeFileSync(
			join(dir, "vite.config.ts"),
			[
				`import { honey } from ${JSON.stringify(join(SRC, "plugin.ts"))}`,
				"export default { plugins: [honey({ app: 'src/app.ts', codegen: { tree: true } })] }",
				"",
			].join("\n"),
			"utf-8",
		)
		const { code, out } = await runCli(dir, ["generate"], 60_000, "node")
		expect(out).not.toMatch(/No config found/)
		expect(code, out).toBe(0)
		expect(existsSync(join(dir, "src/_gen/routes.gen.ts")), out).toBe(true)
	}, 90_000)
})

// regression: GEN-STALE-DIST
describe("bin/honey.js picks the CLI it runs", () => {
	const BIN = resolve(import.meta.dirname, "../../../bin/honey.js")
	const JITI = dirname(createRequire(import.meta.url).resolve("jiti/package.json"))
	const dir = join(ROOT, "bin-pick")

	beforeEach(() => {
		rmSync(dir, { force: true, recursive: true })
		mkdirSync(join(dir, "bin"), { recursive: true })
		mkdirSync(join(dir, "src"), { recursive: true })
		mkdirSync(join(dir, "dist"), { recursive: true })
		mkdirSync(join(dir, "node_modules"), { recursive: true })
		writeFileSync(join(dir, "bin/honey.js"), readFileSync(BIN, "utf-8"))
		writeFileSync(join(dir, "package.json"), '{ "type": "module" }')
		writeFileSync(join(dir, "src/cli.ts"), 'const from: string = "source"\nconsole.log(from)\n')
		writeFileSync(join(dir, "dist/cli.js"), 'console.log("dist")\n')
		symlinkSync(JITI, join(dir, "node_modules/jiti"), "dir")
	})
	afterEach(() => rmSync(dir, { force: true, recursive: true }))

	function runNode(): Promise<string> {
		return new Promise((res, rej) => {
			const child = spawn("node", [join(dir, "bin/honey.js")], { cwd: dir })
			let out = ""
			child.stdout.on("data", (c: Buffer) => (out += c.toString()))
			child.on("error", rej)
			child.on("close", () => res(out.trim()))
		})
	}

	it("Node in a repository checkout runs the source, never a possibly stale dist/", async () => {
		writeFileSync(join(dir, "tsconfig.json"), "{}")
		expect(await runNode()).toBe("source")
	}, 30_000)

	it("Node in an installed package (no tsconfig.json) runs the compiled dist/", async () => {
		expect(await runNode()).toBe("dist")
	}, 30_000)
})
