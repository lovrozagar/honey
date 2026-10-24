import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { resolve } from "node:path"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { createBuildPlugin } from "../../../src/build/index.ts"

const CORE_ROOT = resolve(import.meta.dirname, "../../..")
const FIXTURE_ENTRY = "tests/unit/build/fixture/src/app.ts"
const OUT_ROOT = resolve(CORE_ROOT, ".tmp-build-targets")

type Target = "bun" | "cloudflare" | "node"

/*
 * Each leg serves on a port below the OS's ephemeral range, checked free when the suite starts, the three distinct.
 * A port inside the range, even one the OS just handed out and released, can be drawn as any outgoing connection's
 * source port on a shared machine before the leg's server binds it (EADDRINUSE); a port below it never is.
 * wrangler/workerd binds sockets beside its own --port.
 */
const PORTS: Record<Target, number> = { bun: 0, cloudflare: 0, node: 0 }

/* the first ephemeral port (Linux's ip_local_port_range; macOS's range starts higher still) */
function ephemeralFloor(): number {
	try {
		return Number(readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/)[0])
	} catch {
		return 32_768
	}
}

function bindable(port: number): Promise<boolean> {
	return new Promise((done) => {
		const server = createServer()
		server.once("error", () => done(false))
		server.listen(port, "0.0.0.0", () => server.close(() => done(true)))
	})
}

beforeAll(async () => {
	const floor = ephemeralFloor()
	const taken = new Set<number>()
	for (const target of Object.keys(PORTS) as Target[]) {
		let port = 0
		while (port === 0 || taken.has(port) || !(await bindable(port))) {
			port = 10_000 + Math.floor(Math.random() * (floor - 10_000))
		}
		taken.add(port)
		PORTS[target] = port
	}
})

const children: ChildProcess[] = []

/* each leg's server stops with its leg, so none outlives it into the next */
afterEach(() => {
	for (const child of children.splice(0)) {
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

async function viteBuild(target: Target, outDir: string): Promise<void> {
	const { build, defaultServerConditions } = await import("vite")
	await build({
		configFile: false,
		logLevel: "error",
		/* bundle honey from source; a consumer bundles dist/ */
		ssr: { resolve: { conditions: ["honey-source", ...defaultServerConditions] } },
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
			/* a listener that takes the connection and never answers fails the probe, not the leg's timeout */
			const res = await fetch(url, { signal: AbortSignal.timeout(1_000) })
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

function start(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): ChildProcess {
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
	it("cloudflare: vite build then wrangler/workerd serves health + openapi", async (ctx) => {
		/* report as skipped, never as passed — a missing toolchain must not read as a green run */
		if (!(await which("wrangler")) && !(await which("bunx"))) ctx.skip("wrangler not installed")
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
		const child = start("node", ["--unhandled-rejections=strict", entry], { PORT: String(PORTS.node) })
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
		const child = start("bun", [entry], { PORT: String(PORTS.bun) })
		try {
			await waitHealthy(`http://127.0.0.1:${PORTS.bun}/health`, 20_000)
		} catch (err) {
			const extra = (child as ChildProcess & { logs: () => string }).logs()
			throw new Error(`${err instanceof Error ? err.message : String(err)}${extra ? `\n${extra}` : ""}`)
		}
		await smokeHttp(`http://127.0.0.1:${PORTS.bun}`)
	}, 60_000)
})
