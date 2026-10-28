/**
 * The `honey` bin on Bun (bit 20 k-fix): never through jiti, whose Babel, once loaded on a cold fs cache, hooks
 * Error.prepareStackTrace so that Bun throws "First argument must be an Error object" at a captureStackTrace on a
 * non-Error. A first run generates though a config's import makes such an error; a config that throws at load is
 * evaluated once; `--watch` sees an edit to a module the app imports.
 */
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { MARK_KEY, markOf, reap } from "../../../gen/src/gen/__fixtures__/survivors.ts"
import { appSource, type Project, project } from "./__fixtures__/project.ts"

const SLOW = 60_000
const BIN = resolve(import.meta.dirname, "../../bin/honey.js")
const projects: Project[] = []
afterEach(() => {
	for (const made of projects.splice(0)) made.done()
})

/** A fresh project of `files`, removed after the leg. */
function fresh(files: Record<string, string> = {}): Project {
	const made = project(files)
	projects.push(made)
	return made
}

const CONFIG = (options: string) =>
	`import { honey } from "@lovrozagar/honey/plugin"\nexport default { plugins: [honey(${options})] }\n`
const read = (dir: string, path: string) => (existsSync(join(dir, path)) ? readFileSync(join(dir, path), "utf8") : "")

/** `honey generate <args>` on Bun with `env` over the test's own, its TMPDIR an empty one: a cold jiti cache. */
function onBun(made: Project, args: readonly string[], env: NodeJS.ProcessEnv = {}) {
	const cold = join(made.dir, ".tmp")
	mkdirSync(cold)
	return spawnSync("bun", [BIN, "generate", ...args], {
		cwd: made.dir,
		encoding: "utf8",
		env: { ...process.env, HONEY_NO_BUN_HANDOFF: "1", TMPDIR: cold, ...env },
		timeout: SLOW,
	})
}

/** Whether `check()` came to hold within `ms`, polled each 50 ms (a leg asserts it, so a miss reds as an assertion). */
async function until(check: () => boolean, ms = 20_000): Promise<boolean> {
	for (const start = Date.now(); !check(); await new Promise((done) => setTimeout(done, 50)))
		if (Date.now() - start > ms) return false
	return true
}

describe("honey generate on Bun, from a cold cache (bit 20 k-fix)", () => {
	it(
		"generates on a first run, though a config's import makes an error without Error",
		() => {
			/* follow-redirects' errors, in Vite's own Node chunk: kitchen's and compose's first cloudflare builds */
			const made = fresh({
				"errors.mjs": [
					"function CustomError(message) { Error.captureStackTrace(this, this.constructor); this.message = message }",
					"CustomError.prototype = new Error()",
					'export const made = new CustomError("at load")',
					"",
				].join("\n"),
				"src/app.ts": appSource(),
				"vite.config.ts": `import "./errors.mjs"\n${CONFIG('{ app: "src/app.ts" }')}`,
			})
			/* the condition the plugin's child inherits in a checkout's build */
			const done = onBun(made, [], { BUN_OPTIONS: "--conditions=honey-source" })
			expect([done.status, done.stdout, done.stderr.split("\n")[0]]).toEqual([0, "honey: generated\n", ""])
		},
		SLOW,
	)

	it(
		"evaluates a config that throws at load once, reporting its own error",
		() => {
			/* jiti on Bun imports natively, and on a throw evaluates the module again through its Babel */
			const made = fresh()
			const log = join(made.dir, "evaluations.log")
			made.write(
				"vite.config.ts",
				`import { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(log)}, "x")\nthrow new Error("boom at load")\n`,
			)
			const done = onBun(made, [])
			expect([done.status, done.stderr.split("\n")[0], read(made.dir, "evaluations.log")]).toEqual([
				1,
				"honey: generation failed: boom at load",
				"x",
			])
		},
		SLOW,
	)
})

describe("honey generate --watch on Bun (bit 20 k-fix)", () => {
	it(
		"regenerates when a module the app imports changes",
		async () => {
			const mark = markOf()
			const made = fresh({
				"src/app.ts":
					'import { honey } from "@lovrozagar/honey"\nimport { path } from "./routes.ts"\nexport const app = honey().get(path).handler((c) => c.res.text("ok", "ok"))\n',
				"src/routes.ts": 'export const path = "/first"\n',
			})
			const watch = spawn("bun", [BIN, "generate", "--watch", "--app", "src/app.ts"], {
				cwd: made.dir,
				env: { ...process.env, [MARK_KEY]: mark, HONEY_NO_BUN_HANDOFF: "1" },
			})
			const ended = new Promise((settle) => watch.on("exit", settle))
			const tree = () => read(made.dir, "src/_gen/routes.gen.ts")
			const first = await until(() => tree().includes('"GET /first"'))
			made.write("src/routes.ts", 'export const path = "/second"\n')
			const second = await until(() => tree().includes('"GET /second"'))
			watch.kill("SIGTERM")
			await ended
			reap(mark)
			expect([first, second]).toEqual([true, true])
		},
		SLOW,
	)
})

/**
 * `honey generate --app src/app.ts` on Bun in a checkout, BUN_OPTIONS `options` after a preload that logs each Bun
 * process the run starts: its exit code, stdout, that count and stderr's first line. Stopped once more than two have
 * started, so a hand-off that never sees the condition reds on its count instead of re-running itself without end.
 * `strip`: the preload also takes --conditions=honey-source out of execArgv, as a Bun that stopped reporting it would.
 */
async function starts(options: string, strip = false): Promise<[number | null, string, number, string]> {
	const mark = markOf()
	const made = fresh({ "src/app.ts": appSource() })
	const log = join(made.dir, "starts.log")
	const unseen =
		'const at = process.execArgv.indexOf("--conditions=honey-source")\nif (at >= 0) process.execArgv.splice(at, 1)\n'
	made.write("count.cjs", `require("node:fs").appendFileSync(${JSON.stringify(log)}, "x")\n${strip ? unseen : ""}`)
	const child = spawn("bun", [BIN, "generate", "--app", "src/app.ts"], {
		cwd: made.dir,
		env: {
			...process.env,
			[MARK_KEY]: mark,
			BUN_OPTIONS: `--preload ${join(made.dir, "count.cjs")} ${options}`.trim(),
			HONEY_NO_BUN_HANDOFF: "1",
		},
	})
	let [out, err, code] = ["", "", null as number | null]
	child.stdout.on("data", (chunk: Buffer) => void (out += chunk.toString()))
	child.stderr.on("data", (chunk: Buffer) => void (err += chunk.toString()))
	const ended = new Promise<void>((settle) => child.on("exit", (exited) => settle(void (code = exited))))
	let exited = false
	void ended.then(() => (exited = true))
	await until(() => exited || read(made.dir, "starts.log").length > 2, SLOW / 2)
	if (!exited) child.kill("SIGTERM")
	await ended
	reap(mark)
	return [code, out, read(made.dir, "starts.log").length, err.split("\n")[0] ?? ""]
}

describe("the bin on Bun without the honey-source condition (bit 20 k-fix)", () => {
	it(
		"hands off to itself exactly once with the condition set, and generates",
		async () => {
			expect(await starts("")).toEqual([0, "honey: generated\n", 2, ""])
		},
		SLOW,
	)

	it(
		"runs at once when BUN_OPTIONS sets it: Bun reports it in execArgv, which the hand-off's child relies on",
		async () => {
			expect(await starts("--conditions=honey-source")).toEqual([0, "honey: generated\n", 1, ""])
		},
		SLOW,
	)

	it(
		"refuses a second hand-off when its child does not see the condition, after exactly two starts",
		async () => {
			expect(await starts("", true)).toEqual([
				1,
				"",
				2,
				"honey: Bun hand-off loop: --conditions=honey-source not visible after re-exec",
			])
		},
		SLOW,
	)
})
