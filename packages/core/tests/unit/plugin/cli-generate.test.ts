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

type WatchProcess = {
	/** resolves once stdout has contained `text` at least `count` times */
	waitForOutput(text: string, count?: number): Promise<void>
	/** how many times stdout contained `text` so far */
	count(text: string): number
	stop(): Promise<void>
}

/* Signals, not sleeps: every wait is on a line the CLI prints, with a deadline generous enough for
 * a loaded machine (each generation is a fresh child process). */
const WATCH_DEADLINE_MS = 45_000

function startWatch(cwd: string): WatchProcess {
	const proc = spawn("bun", [CLI, "generate", "--watch"], { cwd })
	let stdout = ""
	let stderr = ""
	const listeners = new Set<() => void>()
	proc.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString()
		for (const l of listeners) l()
	})
	proc.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString()
	})
	const closed = new Promise<void>((res) => proc.on("close", () => res()))
	const count = (text: string): number => stdout.split(text).length - 1
	return {
		count,
		stop: async () => {
			proc.kill("SIGTERM")
			await closed
		},
		waitForOutput: (text, n = 1) =>
			new Promise<void>((res, rej) => {
				const check = (): boolean => {
					if (count(text) < n) return false
					clearTimeout(timer)
					listeners.delete(onData)
					res()
					return true
				}
				const onData = (): void => void check()
				const timer = setTimeout(() => {
					listeners.delete(onData)
					rej(new Error(`timed out waiting for ${n}× "${text}"\nstdout:\n${stdout}\nstderr:\n${stderr}`))
				}, WATCH_DEADLINE_MS)
				if (check()) return
				listeners.add(onData)
			}),
	}
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
		const watcher = startWatch(TEMP_ROOT)
		try {
			await watcher.waitForOutput("honey: watching")
			await watcher.waitForOutput("honey: generated")
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
			await watcher.waitForOutput("honey: generated", 2)
		} finally {
			await watcher.stop()
		}
		expect(readFileSync(join(TEMP_ROOT, "src/_gen/routes.gen.ts"), "utf-8")).toContain("watched")
	}, 120_000)

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
		const treePath = join(TEMP_ROOT, "src/_gen/routes.gen.ts")
		const watcher = startWatch(TEMP_ROOT)
		try {
			await watcher.waitForOutput("honey: watching")
			await watcher.waitForOutput("honey: generated")
			expect(readFileSync(treePath, "utf-8")).toContain("first")
			writeFileSync(join(TEMP_ROOT, "src/routes.ts"), 'export const extra = "second"\n')
			await watcher.waitForOutput("honey: generated", 2)
		} finally {
			await watcher.stop()
		}
		expect(readFileSync(treePath, "utf-8")).toContain("second")
	}, 120_000)

	/* The watcher used to be armed only after the first generation finished, so an edit made while
	 * it ran was lost for good (only the app entry had an mtime poll). The app below holds the first
	 * generation open until the test has edited the module it imports. */
	it("--watch keeps an edit made while the first generation runs", async () => {
		const started = join(TEMP_ROOT, "generation-started")
		writeFileSync(join(TEMP_ROOT, "src/routes.ts"), 'export const extra = "first"\n')
		writeFileSync(
			join(TEMP_ROOT, "src/app.ts"),
			[
				'import { existsSync, writeFileSync } from "node:fs"',
				'import { honey } from "@lovrozagar/honey"',
				'import { extra } from "./routes.ts"',
				`const started = ${JSON.stringify(started)}`,
				"/* only the first generation waits: it marks itself, then holds until the edit lands */",
				"if (!existsSync(started)) {",
				'	writeFileSync(started, "")',
				"	await new Promise((r) => setTimeout(r, 2_000))",
				"}",
				'export const app = honey().get(`/${extra}`).handler((ctx) => ctx.res.text("ok", "ok"))',
			].join("\n"),
		)
		const treePath = join(TEMP_ROOT, "src/_gen/routes.gen.ts")
		const watcher = startWatch(TEMP_ROOT)
		try {
			const deadline = Date.now() + WATCH_DEADLINE_MS
			while (!existsSync(started)) {
				if (Date.now() > deadline) throw new Error("first generation never started")
				await new Promise((r) => setTimeout(r, 20))
			}
			writeFileSync(join(TEMP_ROOT, "src/routes.ts"), 'export const extra = "second"\n')
			await watcher.waitForOutput("honey: generated", 2)
		} finally {
			await watcher.stop()
		}
		expect(readFileSync(treePath, "utf-8")).toContain("second")
	}, 120_000)

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
		const watcher = startWatch(TEMP_ROOT)
		try {
			await watcher.waitForOutput("honey: watching")
			await watcher.waitForOutput("honey: generated")
			/* a loop would show within a few debounce cycles; waiting longer only proves less */
			await new Promise((r) => setTimeout(r, 2_000))
			expect(watcher.count("honey: generated")).toBe(1)
		} finally {
			await watcher.stop()
		}
	}, 120_000)
})
