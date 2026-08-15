import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const TEMP_ROOT = resolve(import.meta.dirname, "../../../.tmp-cli-init-test")
const CLI = resolve(import.meta.dirname, "../../../src/cli.ts")

function runCli(cwd: string, args: string[]): Promise<{
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

describe("honey init CLI", () => {
	beforeEach(() => {
		rmSync(TEMP_ROOT, { force: true, recursive: true })
		mkdirSync(TEMP_ROOT, { recursive: true })
	})

	afterEach(() => {
		rmSync(TEMP_ROOT, { force: true, recursive: true })
	})

	it("writes app, vite config, and package scripts", async () => {
		const { exitCode, stdout } = await runCli(TEMP_ROOT, ["init"])
		expect(exitCode).toBe(0)
		expect(stdout).toMatch(/honey: initialized/)

		const app = readFileSync(join(TEMP_ROOT, "src/app.ts"), "utf-8")
		expect(app).toContain('from "honey"')
		expect(app).toContain('get("/health")')
		expect(app).toContain("openapi({")
		expect(app).toContain('docs: "scalar"')
		expect(app).toContain("export const app")

		const server = readFileSync(join(TEMP_ROOT, "src/server.ts"), "utf-8")
		expect(server).toContain("app.serve(")

		const vite = readFileSync(join(TEMP_ROOT, "vite.config.ts"), "utf-8")
		expect(vite).toContain('from "honey/plugin"')
		expect(vite).toContain('app: "src/app.ts"')

		const pkg = JSON.parse(readFileSync(join(TEMP_ROOT, "package.json"), "utf-8")) as {
			scripts: Record<string, string>
		}
		expect(pkg.scripts.dev).toContain("src/server.ts")
		expect(pkg.scripts.generate).toContain("honey generate")
		expect(existsSync(join(TEMP_ROOT, "wrangler.jsonc"))).toBe(false)
		expect(existsSync(join(TEMP_ROOT, "src/worker.ts"))).toBe(false)
	})

	it("refuses to overwrite an existing app without --force", async () => {
		mkdirSync(join(TEMP_ROOT, "src"), { recursive: true })
		writeFileSync(join(TEMP_ROOT, "src/app.ts"), "export const app = null\n")
		const { exitCode, stderr } = await runCli(TEMP_ROOT, ["init"])
		expect(exitCode).toBe(1)
		expect(stderr).toMatch(/exists|overwrite|--force/i)
		expect(readFileSync(join(TEMP_ROOT, "src/app.ts"), "utf-8")).toContain("null")
	})

	it("overwrites an existing app with --force", async () => {
		mkdirSync(join(TEMP_ROOT, "src"), { recursive: true })
		writeFileSync(join(TEMP_ROOT, "src/app.ts"), "export const app = null\n")
		const { exitCode } = await runCli(TEMP_ROOT, ["init", "--force"])
		expect(exitCode).toBe(0)
		const app = readFileSync(join(TEMP_ROOT, "src/app.ts"), "utf-8")
		expect(app).toContain('from "honey"')
		expect(app).not.toContain("null")
	})

	it("--cf writes wrangler.jsonc and a worker that exports fetch", async () => {
		const { exitCode } = await runCli(TEMP_ROOT, ["init", "--cf"])
		expect(exitCode).toBe(0)
		const wrangler = readFileSync(join(TEMP_ROOT, "wrangler.jsonc"), "utf-8")
		expect(wrangler).toContain("src/worker.ts")
		const worker = readFileSync(join(TEMP_ROOT, "src/worker.ts"), "utf-8")
		expect(worker).toContain("cfWebSocket")
		expect(worker).toContain("export default")
		expect(worker).toContain("app.fetch")
	})

	it("scaffolded app can serve /health and /openapi.json", async () => {
		expect((await runCli(TEMP_ROOT, ["init"])).exitCode).toBe(0)
		const { app } = await import(join(TEMP_ROOT, "src/app.ts"))
		const handle = await app.serve({ hostname: "127.0.0.1", port: 0, runtime: "node" })
		try {
			const health = await fetch(`${handle.url}/health`)
			expect(health.status).toBe(200)
			expect(await health.text()).toBe("ok")
			const spec = (await (await fetch(`${handle.url}/openapi.json`)).json()) as {
				info: { title: string }
				openapi: string
			}
			expect(spec.openapi).toBe("3.1.0")
			expect(spec.info.title).toBeTruthy()
			const docs = await fetch(`${handle.url}/docs`)
			expect(docs.status).toBe(200)
			expect(await docs.text()).toContain("scalar")
		} finally {
			await handle.close()
		}
	})
})
