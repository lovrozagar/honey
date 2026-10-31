/**
 * The build plugin end to end (bit 19 h2, ported from v0's build-targets.test.ts): `vite build` of a v1 app for each
 * target, the bundle then served (node, bun) or run by wrangler/workerd (cloudflare), answering its health route and
 * its OpenAPI document. Until the cutover the package name resolves to v0, so `@lovrozagar/honey/serve` is aliased
 * onto v1's source.
 */
import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { resolve } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { type BuildTarget, createBuildPlugin } from "../../src/build/targets.ts"
import { SPAWN_TIMEOUT } from "../fixture/spawn-timeout.ts"

const CORE = resolve(import.meta.dirname, "../..")
const OUT_ROOT = resolve(CORE, ".tmp-targets")
const WRANGLER = resolve(CORE, "../../node_modules/.bin/wrangler")

/*
 * Each leg serves on a port below the OS's ephemeral range, checked free when the suite starts, the three distinct: a
 * port inside the range can be drawn as an outgoing connection's source port before the leg's server binds it.
 */
const PORTS: Record<BuildTarget, number> = { bun: 0, cloudflare: 0, node: 0 }

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
	/*
	 * A leftover out directory is state, not just files: `--persist-to <outDir>/state` keeps a Durable Object's
	 * storage, so a run whose afterAll never got to run (a killed verify) hands its counter to the next one. Clearing
	 * it here is the half of the fix that keeps the start clean; `counted` is the half that does not depend on it.
	 */
	rmSync(OUT_ROOT, { force: true, recursive: true })
	const floor = ephemeralFloor()
	const taken = new Set<number>()
	for (const target of Object.keys(PORTS) as BuildTarget[]) {
		let port = 0
		while (port === 0 || taken.has(port) || !(await bindable(port)))
			port = 10_000 + Math.floor(Math.random() * (floor - 10_000))
		taken.add(port)
		PORTS[target] = port
	}
})

const children: (ChildProcess & { logs: () => string })[] = []
/* each leg's server stops with its leg, so none outlives it into the next */
afterEach(() => {
	for (const child of children.splice(0)) child.kill("SIGTERM")
})
afterAll(() => rmSync(OUT_ROOT, { force: true, recursive: true }))

async function viteBuild(
	target: BuildTarget,
	entry = "tests/build/fixture/app.ts",
	dir: string = target,
): Promise<string> {
	const outDir = resolve(OUT_ROOT, dir)
	const { build } = await import("vite")
	await build({
		configFile: false,
		logLevel: "error",
		plugins: [createBuildPlugin({ minify: false, outDir, port: PORTS[target], target }, { entry, export: "app" })],
		resolve: { alias: { "@lovrozagar/honey/serve": resolve(CORE, "src/adapters/serve.ts") } },
		root: CORE,
	})
	expect(existsSync(resolve(outDir, "index.js"))).toBe(true)
	return outDir
}

function start(cmd: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
	const child = spawn(cmd, args, {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		stdio: ["ignore", "pipe", "pipe"],
	})
	const logs: string[] = []
	child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()))
	child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()))
	const started = Object.assign(child, { logs: () => logs.join("") })
	children.push(started)
	return started
}

/** Poll `/health` until it answers 200; a listener that never answers fails the probe, not the leg. */
async function healthy(base: string, child: { logs: () => string }, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	let last = ""
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1_000) })
			if (res.status === 200) return
			last = `status ${res.status}`
		} catch (err) {
			last = err instanceof Error ? err.message : String(err)
		}
		await new Promise((r) => setTimeout(r, 80))
	}
	throw new Error(`no healthy server at ${base}: ${last}\n${child.logs()}`)
}

/**
 * Poll `/count` until the Worker's object answers a count, and return the one it answered. Deliberately not `1`:
 * `/count` increments, so the first count a leg sees is only 1 when the storage started empty and no earlier poll
 * reached the server. Neither holds — persisted state can survive a killed run, and a poll this function aborts
 * client-side at 1 s can still have counted on the server. The leg asserts what follows is this count plus one and
 * plus two, which is what proves the object serves and persists, whatever came before.
 */
async function counted(base: string, child: { logs: () => string }, timeoutMs: number): Promise<number> {
	const deadline = Date.now() + timeoutMs
	let last = ""
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${base}/count`, { signal: AbortSignal.timeout(1_000) })
			const text = await res.text()
			last = `${res.status} ${text}`
			if (res.status === 200 && /^\d+$/.test(text)) return Number(text)
		} catch (err) {
			last = err instanceof Error ? err.message : String(err)
		}
		await new Promise((r) => setTimeout(r, 80))
	}
	throw new Error(`no counter at ${base}: ${last}\n${child.logs()}`)
}

/** What `path` of the Worker at `base` answers, polled until it answers 200 or `timeoutMs` passes: its status and text, or why not. */
async function answered(base: string, path: string, timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs
	let last = "no answer"
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(1_000) })
			last = `${res.status} ${await res.text()}`
			if (res.status === 200) return last
		} catch (err) {
			last = err instanceof Error ? err.message : String(err)
		}
		await new Promise((r) => setTimeout(r, 80))
	}
	return last
}

/** What the served bundle answers: its health route and its document's version, title and health path. */
async function served(base: string) {
	const health = await fetch(`${base}/health`)
	const spec = (await (await fetch(`${base}/openapi.json`)).json()) as {
		info: { title: string }
		openapi: string
		paths: Record<string, unknown>
	}
	return [health.status, await health.text(), spec.openapi, spec.info.title, "/health" in spec.paths]
}

const SERVED = [200, "ok", "3.1.0", "Build Fixture", true]

describe.sequential("the build plugin's bundles, served (bit 19 h2)", () => {
	// v0: e6b3d639a5
	it("cloudflare: vite build then wrangler/workerd serves health + openapi", async (ctx) => {
		/* reported as skipped, never as passed: a missing toolchain must not read as a green run */
		if (!existsSync(WRANGLER)) ctx.skip("wrangler is not installed")
		const outDir = await viteBuild("cloudflare")
		const wrangler = {
			compatibility_date: "2026-01-20",
			compatibility_flags: ["nodejs_compat"],
			main: "index.js",
			name: "honey-build-fixture",
		}
		writeFileSync(resolve(outDir, "wrangler.jsonc"), `${JSON.stringify(wrangler, null, 2)}\n`)
		const port = String(PORTS.cloudflare)
		const args = ["dev", "--ip", "127.0.0.1", "--port", port, "--inspector-port", "0", "--log-level", "error"]
		const child = start(WRANGLER, args, { cwd: outDir })
		await healthy(`http://127.0.0.1:${port}`, child, 25_000)
		expect(await served(`http://127.0.0.1:${port}`)).toEqual(SERVED)
	}, 90_000)

	it(
		"cloudflare: the Worker exports the entry's Durable Object class, which workerd then serves (bit 21 h)",
		async (ctx) => {
			if (!existsSync(WRANGLER)) ctx.skip("wrangler is not installed")
			const outDir = await viteBuild("cloudflare", "tests/build/fixture/worker-object.ts", "cloudflare-object")
			const exported = /export\s*\{[^}]*\bCounter\b[^}]*\}/.test(readFileSync(resolve(outDir, "index.js"), "utf8"))
			expect(exported).toBe(true)
			const wrangler = {
				compatibility_date: "2026-01-20",
				durable_objects: { bindings: [{ class_name: "Counter", name: "COUNTER" }] },
				main: "index.js",
				migrations: [{ new_sqlite_classes: ["Counter"], tag: "v1" }],
				name: "honey-build-object-fixture",
			}
			writeFileSync(resolve(outDir, "wrangler.jsonc"), `${JSON.stringify(wrangler, null, 2)}\n`)
			const port = String(PORTS.cloudflare)
			const args = ["dev", "--ip", "127.0.0.1", "--port", port, "--inspector-port", "0", "--log-level", "error"]
			const persist = ["--persist-to", resolve(outDir, "state")]
			const child = start(WRANGLER, [...args, ...persist], { cwd: outDir })
			const base = `http://127.0.0.1:${port}`
			const first = await counted(base, child, 25_000)
			expect([await (await fetch(`${base}/count`)).text(), await (await fetch(`${base}/count`)).text()]).toEqual([
				String(first + 1),
				String(first + 2),
			])
		},
		SPAWN_TIMEOUT,
	)

	it(
		"cloudflare: an entry's plain values (an object, a string, a function) leave the Worker serving (bit 21 h)",
		async (ctx) => {
			if (!existsSync(WRANGLER)) ctx.skip("wrangler is not installed")
			/* workerd refuses a module whose named export is no function or object: one string export stopped the Worker */
			const outDir = await viteBuild("cloudflare", "tests/build/fixture/worker-values.ts", "cloudflare-values")
			const wrangler = {
				compatibility_date: "2026-01-20",
				durable_objects: { bindings: [{ class_name: "Counter", name: "COUNTER" }] },
				main: "index.js",
				migrations: [{ new_sqlite_classes: ["Counter"], tag: "v1" }],
				name: "honey-build-values-fixture",
			}
			writeFileSync(resolve(outDir, "wrangler.jsonc"), `${JSON.stringify(wrangler, null, 2)}\n`)
			const port = String(PORTS.cloudflare)
			const args = ["dev", "--ip", "127.0.0.1", "--port", port, "--inspector-port", "0", "--log-level", "error"]
			start(WRANGLER, [...args, "--persist-to", resolve(outDir, "state")], { cwd: outDir })
			const base = `http://127.0.0.1:${port}`
			expect([await answered(base, "/config", 25_000), await answered(base, "/count", 5_000)]).toEqual([
				"200 honey-build-values in eu",
				"200 1",
			])
		},
		SPAWN_TIMEOUT,
	)

	// v0: eb3666936c
	it("node: vite build then node dist serves health + openapi", async () => {
		const outDir = await viteBuild("node")
		const child = start("node", ["--unhandled-rejections=strict", resolve(outDir, "index.js")], {
			env: { PORT: String(PORTS.node) },
		})
		await healthy(`http://127.0.0.1:${PORTS.node}`, child, 20_000)
		expect(await served(`http://127.0.0.1:${PORTS.node}`)).toEqual(SERVED)
	}, 60_000)

	// v0: 13fe7f3f01
	it("bun: vite build then bun dist serves health + openapi", async () => {
		const outDir = await viteBuild("bun")
		const child = start("bun", [resolve(outDir, "index.js")], { env: { PORT: String(PORTS.bun) } })
		await healthy(`http://127.0.0.1:${PORTS.bun}`, child, 20_000)
		expect(await served(`http://127.0.0.1:${PORTS.bun}`)).toEqual(SERVED)
	}, 60_000)
})
