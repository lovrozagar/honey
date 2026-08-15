import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import "honey/serve"
import { detectRuntime, honey } from "../../../src/index.ts"

const RUNNER = resolve(import.meta.dirname, "./soak-runner.ts")
const WORKER = resolve(import.meta.dirname, "../../../../../e2e/cf-workers/src/worker.ts")

function run(cmd: string, args: string[]): Promise<{ exitCode: number; stderr: string; stdout: string }> {
	return new Promise((resolveProc, reject) => {
		const proc = spawn(cmd, args, { cwd: resolve(import.meta.dirname, "../../..") })
		let stdout = ""
		let stderr = ""
		proc.stdout.on("data", (c: Buffer) => {
			stdout += c.toString()
		})
		proc.stderr.on("data", (c: Buffer) => {
			stderr += c.toString()
		})
		proc.on("error", reject)
		proc.on("close", (code) => {
			resolveProc({ exitCode: code ?? 1, stderr, stdout })
		})
	})
}

describe("Honey.serve() soak — node", () => {
	it("bind, abort mid-hang, still healthy, close, rebind", async () => {
		const app = honey()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "ok"))
			.get("/hang")
			.handler(async (ctx) => {
				await new Promise((r) => setTimeout(r, 2_000))
				return ctx.res.text("ok", "late")
			})

		const handle = await app.serve({ hostname: "127.0.0.1", port: 0, runtime: "node" })
		try {
			expect(handle.port).toBeGreaterThan(0)
			expect(await (await fetch(`${handle.url}/health`)).text()).toBe("ok")

			const ac = new AbortController()
			const timer = setTimeout(() => ac.abort(), 40)
			await expect(fetch(`${handle.url}/hang`, { signal: ac.signal })).rejects.toMatchObject({
				name: expect.stringMatching(/Abort|Timeout/),
			})
			clearTimeout(timer)

			expect(await (await fetch(`${handle.url}/health`)).text()).toBe("ok")
		} finally {
			await handle.close()
		}

		await expect(fetch(`${handle.url}/health`, { signal: AbortSignal.timeout(1500) })).rejects.toBeTruthy()

		const again = await app.serve({ hostname: "127.0.0.1", port: 0, runtime: "node" })
		try {
			expect(await (await fetch(`${again.url}/health`)).text()).toBe("ok")
		} finally {
			await again.close()
		}
	}, 15_000)

	it("cors: true still answers preflight after a soak cycle", async () => {
		const app = honey().get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		const handle = await app.serve({
			cors: true,
			hostname: "127.0.0.1",
			port: 0,
			runtime: "node",
		})
		try {
			const pre = await fetch(`${handle.url}/health`, {
				headers: {
					"access-control-request-method": "GET",
					origin: "http://app.example",
				},
				method: "OPTIONS",
			})
			expect(pre.status).toBe(204)
			expect(pre.headers.get("access-control-allow-origin")).toBeTruthy()
		} finally {
			await handle.close()
		}
	})
})

describe("Honey.serve() soak — bun / deno", () => {
	it("bun runner bind/abort/close/rebind", async () => {
		const { exitCode, stderr, stdout } = await run("bun", [RUNNER, "bun"])
		expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
		expect(stdout).toContain('"ok":true')
		expect(stdout).toContain('"runtime":"bun"')
	}, 15_000)

	it("deno runner bind/abort/close/rebind", async () => {
		const { exitCode, stderr, stdout } = await run("deno", [
			"run",
			"--allow-env",
			"--allow-net",
			"--allow-read",
			RUNNER,
			"deno",
		])
		expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
		expect(stdout).toContain('"ok":true')
		expect(stdout).toContain('"runtime":"deno"')
	}, 20_000)
})

describe("Honey.serve() cloudflare is not a listen", () => {
	it("detectRuntime reads workerd UA when Bun/Deno are absent", () => {
		expect(
			detectRuntime({
				navigator: { userAgent: "Cloudflare-Workers" },
			}),
		).toBe("cloudflare")
		expect(
			detectRuntime({
				navigator: { userAgent: "workerd" },
			}),
		).toBe("cloudflare")
	})

	it("runtime: cloudflare still throws the export-fetch recipe", async () => {
		await expect(honey().serve({ runtime: "cloudflare" })).rejects.toThrow(/app\.fetch/)
		await expect(honey().serve({ runtime: "cloudflare" })).rejects.toThrow(/export default/)
	})

	it("e2e cf worker still exports fetch, not serve()", () => {
		expect(existsSync(WORKER)).toBe(true)
		const src = readFileSync(WORKER, "utf-8")
		expect(src).toContain("export default")
		expect(src).toContain("app.fetch")
		expect(src).not.toMatch(/\.serve\s*\(/)
	})
})
