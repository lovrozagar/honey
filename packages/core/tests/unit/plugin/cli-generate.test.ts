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
			'import { honey } from "honey"',
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
			'import { honey } from "honey/plugin"',
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

function runGenerate(cwd: string, args: string[] = ["generate"]): Promise<{
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
		const spec = JSON.parse(
			readFileSync(join(TEMP_ROOT, "src/_gen/openapi.gen.json"), "utf-8"),
		) as { info: { title: string } }
		expect(spec.info.title).toBe("CLI Gen")
		expect(readFileSync(join(TEMP_ROOT, "src/_gen/openapi.gen.yaml"), "utf-8")).toContain(
			"CLI Gen",
		)
		const manifest = JSON.parse(
			readFileSync(join(TEMP_ROOT, "src/_gen/manifest.gen.json"), "utf-8"),
		) as { routes: unknown[] }
		expect(manifest.routes.length).toBeGreaterThan(0)
	})

	it("accepts --app without a vite config", async () => {
		rmSync(join(TEMP_ROOT, "vite.config.ts"))
		const { exitCode, stdout } = await runGenerate(TEMP_ROOT, [
			"generate",
			"--app",
			"src/app.ts",
			"--tree",
		])
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
		writeFileSync(
			join(TEMP_ROOT, "src/app.ts"),
			[
				'import { honey } from "honey"',
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
})
