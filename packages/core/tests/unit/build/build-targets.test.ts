import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { createBuildPlugin } from "../../../src/build/index.ts"

const CORE_ROOT = resolve(import.meta.dirname, "../../..")
const FIXTURE_ENTRY = "tests/unit/build/fixture/src/app.ts"
const OUT_ROOT = resolve(CORE_ROOT, ".tmp-build-targets")

const PORTS = {
	bun: 45911,
	cloudflare: 45910,
	deno: 45913,
	node: 45912,
} as const

const children: ChildProcess[] = []

afterAll(() => {
	for (const child of children) {
		child.kill("SIGTERM")
	}
})

async function which(bin: string): Promise<boolean> {
	return new Promise((res) => {
		const proc = spawn("which", [bin], { stdio: "ignore" })
		proc.on("close", (code) => res(code === 0))
		proc.on("error", () => res(false))
	})
}

async function viteBuild(target: "bun" | "cloudflare" | "deno" | "node", outDir: string): Promise<void> {
	const { build } = await import("vite")
	await build({
		configFile: false,
		logLevel: "error",
		plugins: [
			createBuildPlugin(
				{ minify: false, outDir, port: PORTS[target], target },
				{ entry: FIXTURE_ENTRY, export: "app" },
			),
		],
		root: CORE_ROOT,
	})
}

async function waitHealthy(url: string, timeoutMs = 12_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	let last = ""
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url)
			if (res.status === 200) return
			last = `status ${res.status}`
		} catch (err) {
			last = err instanceof Error ? err.message : String(err)
		}
		await new Promise((r) => setTimeout(r, 80))
	}
	throw new Error(`server did not become healthy at ${url}: ${last}`)
}

async function smokeHttp(base: string): Promise<void> {
	const health = await fetch(`${base}/health`)
	expect(health.status).toBe(200)
	expect(await health.text()).toBe("ok")
	const spec = (await (await fetch(`${base}/openapi.json`)).json()) as {
		info: { title: string }
		openapi: string
		paths: Record<string, unknown>
	}
	expect(spec.openapi).toBe("3.1.0")
	expect(spec.info.title).toBe("Build Fixture")
	expect(spec.paths["/health"]).toBeDefined()
}

function start(
	cmd: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	cwd?: string,
): ChildProcess {
	const child = spawn(cmd, args, {
		cwd,
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
	})
	const logs: string[] = []
	child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()))
	child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()))
	child.on("exit", (code, signal) => {
		if (code !== 0 && code !== null) logs.push(`exit ${code}${signal ? ` ${signal}` : ""}`)
	})
	;(child as ChildProcess & { logs: () => string }).logs = () => logs.join("")
	children.push(child)
	return child
}

describe.sequential("honey/build target artifacts", () => {
	it("cloudflare: vite build then wrangler/workerd serves health + openapi", async () => {
		if (!(await which("wrangler")) && !(await which("bunx"))) return
		const outDir = resolve(OUT_ROOT, "cloudflare")
		await viteBuild("cloudflare", outDir)
		const entry = resolve(outDir, "index.js")
		expect(existsSync(entry)).toBe(true)
		writeFileSync(
			resolve(outDir, "wrangler.jsonc"),
			`${JSON.stringify(
				{
					compatibility_date: "2026-01-20",
					compatibility_flags: ["nodejs_compat"],
					main: "index.js",
					name: "honey-build-fixture",
				},
				null,
				2,
			)}\n`,
		)
		start(
			"bunx",
			[
				"wrangler",
				"dev",
				"--ip",
				"127.0.0.1",
				"--port",
				String(PORTS.cloudflare),
				"--inspector-port",
				"0",
				"--log-level",
				"error",
			],
			{},
			outDir,
		)
		await waitHealthy(`http://127.0.0.1:${PORTS.cloudflare}/health`, 25_000)
		await smokeHttp(`http://127.0.0.1:${PORTS.cloudflare}`)
	}, 90_000)

	it("node: vite build then node dist serves health + openapi", async () => {
		const outDir = resolve(OUT_ROOT, "node")
		await viteBuild("node", outDir)
		const entry = resolve(outDir, "index.js")
		expect(existsSync(entry)).toBe(true)
		const child = start("node", [entry], { PORT: String(PORTS.node) })
		try {
			await waitHealthy(`http://127.0.0.1:${PORTS.node}/health`, 20_000)
		} catch (err) {
			const extra = (child as ChildProcess & { logs: () => string }).logs()
			throw new Error(`${err instanceof Error ? err.message : String(err)}${extra ? `\n${extra}` : ""}`)
		}
		await smokeHttp(`http://127.0.0.1:${PORTS.node}`)
	}, 60_000)

	it("bun: vite build then bun dist serves health + openapi", async () => {
		const outDir = resolve(OUT_ROOT, "bun")
		await viteBuild("bun", outDir)
		const entry = resolve(outDir, "index.js")
		expect(existsSync(entry)).toBe(true)
		start("bun", [entry], { PORT: String(PORTS.bun) })
		await waitHealthy(`http://127.0.0.1:${PORTS.bun}/health`)
		await smokeHttp(`http://127.0.0.1:${PORTS.bun}`)
	}, 60_000)

	it("deno: vite build then deno dist serves health + openapi", async () => {
		if (!(await which("deno"))) return
		const outDir = resolve(OUT_ROOT, "deno")
		await viteBuild("deno", outDir)
		const entry = resolve(outDir, "index.js")
		expect(existsSync(entry)).toBe(true)
		start("deno", ["run", "--allow-all", entry], { PORT: String(PORTS.deno) })
		await waitHealthy(`http://127.0.0.1:${PORTS.deno}/health`)
		await smokeHttp(`http://127.0.0.1:${PORTS.deno}`)
	}, 60_000)
})
