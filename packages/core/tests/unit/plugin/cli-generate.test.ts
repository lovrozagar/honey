import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const TEMP_ROOT = resolve(import.meta.dirname, "../../../.tmp-cli-generate-test")
const CLI = resolve(import.meta.dirname, "../../../src/cli.ts")

function writeProject(dir: string, health = "ok"): void {
	mkdirSync(join(dir, "src"), { recursive: true })
	writeFileSync(
		join(dir, "src/app.ts"),
		[
			'import { honey } from "@lovrozagar/honey"',
			"",
			"export const app = honey()",
			`  .get("/health").handler((ctx) => ctx.res.text("ok", ${JSON.stringify(health)}))`,
			"",
		].join("\n"),
		"utf-8",
	)
	writeFileSync(
		join(dir, "vite.config.ts"),
		[
			'import { honey } from "@lovrozagar/honey/plugin"',
			"",
			"export default {",
			"  plugins: [",
			"    honey({",
			'      app: "src/app.ts",',
			"      codegen: {",
			"        manifest: true,",
			'        openApi: { title: "CLI Gen", version: "1.0.0" },',
			"        tree: true,",
			"      },",
			"    }),",
			"  ],",
			"}",
			"",
		].join("\n"),
		"utf-8",
	)
}

function runGenerate(
	cwd: string,
	args: string[] = ["generate"],
): Promise<{
	exitCode: number
	stderr: string
	stdout: string
}> {
	return new Promise((resolveProc, reject) => {
		const proc = spawn("bun", [CLI, ...args], { cwd })
		let stdout = ""
		let stderr = ""
		proc.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString()
		})
		proc.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString()
		})
		proc.on("error", reject)
		proc.on("close", (code) => {
			resolveProc({ exitCode: code ?? 1, stderr, stdout })
		})
	})
}

describe("honey generate CLI", () => {
	beforeEach(() => {
		mkdirSync(TEMP_ROOT, { recursive: true })
		writeProject(TEMP_ROOT)
	})

	afterEach(() => {
		rmSync(TEMP_ROOT, { force: true, recursive: true })
	})

	it("prints usage and exits 1 without the generate command", async () => {
		const { exitCode, stderr } = await runGenerate(TEMP_ROOT, [])
		expect(exitCode).toBe(1)
		expect(stderr).toContain("Usage: honey generate")
		expect(stderr).toContain("honey init")
	})

	it("exits 1 when there is no vite config and no --app", async () => {
		rmSync(join(TEMP_ROOT, "vite.config.ts"))
		const { exitCode, stderr } = await runGenerate(TEMP_ROOT)
		expect(exitCode).toBe(1)
		expect(stderr).toMatch(/No config found/)
	})

	it("reads vite.config.ts and writes _gen files", async () => {
		const { exitCode, stdout } = await runGenerate(TEMP_ROOT)
		expect(exitCode).toBe(0)
		expect(stdout).toContain("honey: generated")

		const tree = readFileSync(join(TEMP_ROOT, "src/_gen/routes.gen.ts"), "utf-8")
		expect(tree).toContain("health")
		const spec = JSON.parse(readFileSync(join(TEMP_ROOT, "src/_gen/openapi.gen.json"), "utf-8")) as {
			info: { title: string }
		}
		expect(spec.info.title).toBe("CLI Gen")
		expect(readFileSync(join(TEMP_ROOT, "src/_gen/openapi.gen.yaml"), "utf-8")).toContain("CLI Gen")
		const manifest = JSON.parse(readFileSync(join(TEMP_ROOT, "src/_gen/manifest.gen.json"), "utf-8")) as {
			routes: unknown[]
		}
		expect(manifest.routes.length).toBeGreaterThan(0)
	})

	it("accepts --app without a vite config", async () => {
		rmSync(join(TEMP_ROOT, "vite.config.ts"))
		const { exitCode, stdout } = await runGenerate(TEMP_ROOT, ["generate", "--app", "src/app.ts", "--tree"])
		expect(exitCode).toBe(0)
		expect(stdout).toContain("honey: generated")
		expect(readFileSync(join(TEMP_ROOT, "src/_gen/routes.gen.ts"), "utf-8")).toContain("health")
	})

	it("--watch regenerates after the app file changes", async () => {
		const proc = spawn("bun", [CLI, "generate", "--watch"], { cwd: TEMP_ROOT })
		let started = false
		const waiters: Array<() => void> = []
		proc.stdout.on("data", (chunk: Buffer) => {
			if (chunk.toString().includes("watching")) started = true
			for (const w of waiters) w()
		})

		const waitUntil = (pred: () => boolean, ms: number, label: string) =>
			new Promise<void>((res, rej) => {
				if (pred()) {
					res()
					return
				}
				const timer = setTimeout(() => rej(new Error(label)), ms)
				const tick = () => {
					if (!pred()) return
					clearTimeout(timer)
					res()
				}
				waiters.push(tick)
			})

		await waitUntil(() => started, 15_000, "watch start timeout")
		await new Promise((r) => setTimeout(r, 200))
		writeFileSync(
			join(TEMP_ROOT, "src/app.ts"),
			[
				'import { honey } from "@lovrozagar/honey"',
				"",
				"export const app = honey()",
				'  .get("/health").handler((ctx) => ctx.res.text("ok", "ok"))',
				'  .get("/watched").handler((ctx) => ctx.res.text("ok", "w"))',
				"",
			].join("\n"),
			"utf-8",
		)

		const treePath = join(TEMP_ROOT, "src/_gen/routes.gen.ts")
		const deadline = Date.now() + 15_000
		while (Date.now() < deadline) {
			if (existsSync(treePath) && readFileSync(treePath, "utf-8").includes("watched")) break
			await new Promise((r) => setTimeout(r, 100))
		}
		proc.kill("SIGTERM")
		await new Promise<void>((res) => proc.on("close", () => res()))
		expect(readFileSync(treePath, "utf-8")).toContain("watched")
	}, 35_000)

	// regression: H70
	it("rejects unknown flags and a missing explicit config, even with --app", async () => {
		const typo = await runGenerate(TEMP_ROOT, ["generate", "--manifset"])
		expect(typo.exitCode).toBe(1)
		expect(typo.stderr).toContain("unknown option: --manifset")

		const missing = await runGenerate(TEMP_ROOT, ["generate", "--config", "nope.ts", "--app", "src/app.ts"])
		expect(missing.exitCode).toBe(1)
		expect(missing.stderr).toContain("config file not found: nope.ts")
	})

	// regression: H70
	it("--app=<path> overrides the config's app", async () => {
		writeFileSync(
			join(TEMP_ROOT, "src/other.ts"),
			'import { honey } from "@lovrozagar/honey"\nexport const app = honey().get("/other").handler((c) => c.res.text("ok", "o"))\n',
		)
		const { exitCode } = await runGenerate(TEMP_ROOT, ["generate", "--app=src/other.ts"])
		expect(exitCode).toBe(0)
		expect(readFileSync(join(TEMP_ROOT, "src/_gen/routes.gen.ts"), "utf-8")).toContain("other")
	})

	// regression: H70
	it("calls a function-form Vite config", async () => {
		writeFileSync(
			join(TEMP_ROOT, "vite.config.ts"),
			[
				'import { honey } from "@lovrozagar/honey/plugin"',
				"export default ({ command }: { command: string }) => ({",
				'  plugins: [command === "build" && [honey({ app: "src/app.ts", codegen: { manifest: true } })]],',
				"})",
			].join("\n"),
		)
		const { exitCode, stderr } = await runGenerate(TEMP_ROOT)
		expect(exitCode, stderr).toBe(0)
		expect(existsSync(join(TEMP_ROOT, "src/_gen/manifest.gen.json"))).toBe(true)
	})

	it("asks which plugin when the config has several, and --plugin picks one", async () => {
		writeFileSync(
			join(TEMP_ROOT, "src/other.ts"),
			'import { honey } from "@lovrozagar/honey"\nexport const app = honey().get("/other").handler((c) => c.res.text("ok", "o"))\n',
		)
		writeFileSync(
			join(TEMP_ROOT, "vite.config.ts"),
			[
				'import { honey } from "@lovrozagar/honey/plugin"',
				"export default {",
				'  plugins: [honey({ app: "src/app.ts" }), honey({ app: "src/other.ts", codegen: { tree: "src/_gen/other.gen.ts" } })],',
				"}",
			].join("\n"),
		)
		const ambiguous = await runGenerate(TEMP_ROOT)
		expect(ambiguous.exitCode).toBe(1)
		expect(ambiguous.stderr).toContain("--plugin")

		expect((await runGenerate(TEMP_ROOT, ["generate", "--plugin", "1"])).exitCode).toBe(0)
		expect(readFileSync(join(TEMP_ROOT, "src/_gen/other.gen.ts"), "utf-8")).toContain("other")
		expect(existsSync(join(TEMP_ROOT, "src/_gen/routes.gen.ts"))).toBe(false)
	})

	// regression: H (plugin.ts:360-363 side effects)
	it("an app that serves at top level and leaves a timer still generates and exits, without binding the port", async () => {
		const port = 45_987
		writeFileSync(
			join(TEMP_ROOT, "src/app.ts"),
			[
				'import { honey } from "@lovrozagar/honey"',
				'import "@lovrozagar/honey/serve"',
				'export const app = honey().get("/health").handler((ctx) => ctx.res.text("ok", "ok"))',
				`await app.serve({ port: ${port} })`,
				"setInterval(() => {}, 1000)",
			].join("\n"),
		)
		const started = Date.now()
		const { exitCode, stderr } = await runGenerate(TEMP_ROOT)
		expect(exitCode, stderr).toBe(0)
		expect(Date.now() - started).toBeLessThan(15_000)
		await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow()
	}, 30_000)

	it("runs on Node too: the config is read off the plugin object, not a module-global stash", async () => {
		const { cliInvocation } = await import("../../../src/gen-process.ts")
		const [cmd, ...pre] = cliInvocation() as [string, ...string[]]
		expect(cmd).toBe(process.execPath)
		const result = await new Promise<{ code: number; stderr: string }>((res, rej) => {
			const proc = spawn(cmd, [...pre, "generate"], { cwd: TEMP_ROOT })
			let stderr = ""
			proc.stderr.on("data", (c: Buffer) => {
				stderr += c.toString()
			})
			proc.on("error", rej)
			proc.on("close", (code) => res({ code: code ?? 1, stderr }))
		})
		expect(result.code, result.stderr).toBe(0)
		expect(readFileSync(join(TEMP_ROOT, "src/_gen/routes.gen.ts"), "utf-8")).toContain("health")
	}, 30_000)

	// regression: H68
	it("--watch sees edits to modules the app imports", async () => {
		writeFileSync(join(TEMP_ROOT, "src/routes.ts"), 'export const extra = "first"\n')
		writeFileSync(
			join(TEMP_ROOT, "src/app.ts"),
			[
				'import { honey } from "@lovrozagar/honey"',
				'import { extra } from "./routes.ts"',
				'export const app = honey().get(`/${extra}`).handler((ctx) => ctx.res.text("ok", "ok"))',
			].join("\n"),
		)
		const proc = spawn("bun", [CLI, "generate", "--watch"], { cwd: TEMP_ROOT })
		const treePath = join(TEMP_ROOT, "src/_gen/routes.gen.ts")
		const waitFor = async (text: string): Promise<boolean> => {
			const deadline = Date.now() + 15_000
			while (Date.now() < deadline) {
				if (existsSync(treePath) && readFileSync(treePath, "utf-8").includes(text)) return true
				await new Promise((r) => setTimeout(r, 100))
			}
			return false
		}
		try {
			expect(await waitFor("first")).toBe(true)
			writeFileSync(join(TEMP_ROOT, "src/routes.ts"), 'export const extra = "second"\n')
			expect(await waitFor("second")).toBe(true)
		} finally {
			proc.kill("SIGTERM")
			await new Promise<void>((res) => proc.on("close", () => res()))
		}
	}, 40_000)

	it("--watch does not loop on SDK ports written next to the app", async () => {
		writeFileSync(
			join(TEMP_ROOT, "vite.config.ts"),
			[
				'import { honey } from "@lovrozagar/honey/plugin"',
				"export default {",
				"  plugins: [honey({",
				'    app: "src/app.ts",',
				'    codegen: { sdk: { ports: { python: { outDir: "src/py" } } } },',
				"  })],",
				"}",
			].join("\n"),
		)
		const proc = spawn("bun", [CLI, "generate", "--watch"], { cwd: TEMP_ROOT })
		let generations = 0
		proc.stdout.on("data", (chunk: Buffer) => {
			generations += chunk.toString().split("honey: generated").length - 1
		})
		try {
			const deadline = Date.now() + 15_000
			const generated = () => generations > 0
			while (!generated() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
			expect(generations).toBe(1)
			await new Promise((r) => setTimeout(r, 2_000))
			expect(generations).toBe(1)
		} finally {
			proc.kill("SIGTERM")
			await new Promise<void>((res) => proc.on("close", () => res()))
		}
	}, 30_000)
})
