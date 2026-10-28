/**
 * The `honey` CLI (bit 19 h2): `generate` from the honey() config of a Vite config (a function-form one too, the
 * plugin asked for when there are several), from `--app` alone or over the config's app, strict about its flags;
 * through the bin on Node and Bun, ending once it has written whatever the app left running, and handing its Bun child
 * a signal that lands as it spawns it; `--watch`, each
 * generation a fresh child that sees edits to imported modules, an edit during a run queued, never looping on its own
 * outputs; and `init`, whose scaffold generates.
 */
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { MARK_KEY, marked, markOf, reap } from "../../../gen/src/gen/__fixtures__/survivors.ts"
import { appSource, type Project, project } from "./__fixtures__/project.ts"
import { USAGE } from "./cli-args.ts"
import { main } from "./cli.ts"
import { SPAWN_TIMEOUT } from "../../tests/fixture/spawn-timeout.ts"

const SLOW = 60_000
/* an internal route whose own middleware adds to ctx: extracted, never documented, so the types report it */
const HIDDEN_ADDITION = [
	'\t.get("/hidden")',
	"\t.meta({ internal: true } as never)",
	"\t.use(createMiddleware((_c, next) => next({ hidden: 1 })))",
	'\t.handler((c) => c.res.text("ok", "h"))',
]
const BIN = resolve(import.meta.dirname, "../../bin/honey.js")
/* the preload that signals the process as spawn returns: the window between the bin's spawn and its next statement */
const SIGNAL_ON_SPAWN = resolve(import.meta.dirname, "../../../gen/tests/integration/signal-on-spawn.ts")
const projects: Project[] = []
const watches: { controller: AbortController; ended: Promise<unknown> }[] = []
/* a watch ends once its last child is done: only then is its project removed */
afterEach(async () => {
	for (const { controller } of watches) controller.abort()
	await Promise.all(watches.splice(0).map(({ ended }) => ended))
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

/** `honey <argv>` in process from `dir`: its exit code and what it wrote. */
async function run(argv: readonly string[], dir: string, signal?: AbortSignal) {
	let [out, err] = ["", ""]
	const io = { err: (text: string) => void (err += text), out: (text: string) => void (out += text) }
	const status = await main(argv, io, { cwd: dir, env: {}, signal })
	return { err, out, status }
}

const read = (dir: string, path: string) => (existsSync(join(dir, path)) ? readFileSync(join(dir, path), "utf8") : "")

/** Whether `check()` came to hold within `ms`, polled each 50 ms (a leg asserts it, so a miss reds as an assertion). */
async function until(check: () => boolean, ms = 20_000): Promise<boolean> {
	for (const start = Date.now(); !check(); await new Promise((done) => setTimeout(done, 50)))
		if (Date.now() - start > ms) return false
	return true
}

describe("honey generate (bit 19 h2)", () => {
	// v0: 959b999f6f
	// v0: b4d1303b14
	it(
		"prints usage and exits 1 with no command or an unknown one, and with neither a config nor --app",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			const { dir } = fresh()
			const runs = [await run([], dir), await run(["serve"], dir), await run(["generate"], dir)]
			expect(runs.map(({ err, status }) => [status, err.split("\n")[0]])).toEqual([
				[1, "honey: missing command"],
				[1, "honey: unknown command: serve"],
				[1, "honey: no config found: add honey() to a vite.config.ts, or pass --app"],
			])
			expect(runs[0]?.err.endsWith(`${USAGE}\n`)).toBe(true)
			expect([await run(["--help"], dir), await run(["generate", "-h"], dir)]).toEqual([
				{ err: "", out: `${USAGE}\n`, status: 0 },
				{ err: "", out: `${USAGE}\n`, status: 0 },
			])
		},
	)

	// v0: 62e5575589
	// v0: 6e3d7e688e
	it(
		"generates by the Vite config's honey(), with --app over its app",
		async () => {
			const { dir } = fresh({
				"src/app.ts": appSource(),
				"src/other.ts": appSource({ extra: ['\t.get("/other").handler((c) => c.res.text("ok", "ok"))'] }),
				"vite.config.ts": CONFIG(
					'{ app: "src/app.ts", codegen: { manifest: true, openApi: { title: "CLI", version: "1" } } }',
				),
			})
			expect(await run(["generate"], dir)).toEqual({ err: "", out: "honey: generated\n", status: 0 })
			expect(
				["routes.gen.ts", "manifest.gen.json", "openapi.gen.json"].map((file) => read(dir, `src/_gen/${file}`) !== ""),
			).toEqual([true, true, true])
			expect((await run(["generate", "--app=src/other.ts"], dir)).status).toBe(0)
			expect(read(dir, "src/_gen/routes.gen.ts")).toContain('"GET /other"')
		},
		SLOW,
	)

	// v0: 801b406e79
	it(
		"generates from --app alone, with no Vite config, each output flag turning its output on",
		async () => {
			const { dir } = fresh({ "src/app.ts": appSource() })
			expect((await run(["generate", "--app", "src/app.ts", "--manifest", "--types"], dir)).status).toBe(0)
			expect(
				["routes.gen.ts", "manifest.gen.json", "types.gen.d.ts"].map((file) => read(dir, `src/_gen/${file}`) !== ""),
			).toEqual([true, true, true])
		},
		SLOW,
	)
})

describe("honey generate (bit 19 h2), continued (2)", () => {
	// v0: f3c257c447
	it(
		"refuses an unknown flag and a missing explicit config even with --app, and a config without honey()",
		async () => {
			const { dir } = fresh({ "src/app.ts": appSource(), "vite.config.ts": "export default { plugins: [] }\n" })
			const runs = [
				await run(["generate", "--app", "src/app.ts", "--manifset"], dir),
				await run(["generate", "--app", "src/app.ts", "--config", "nope.ts"], dir),
				await run(["generate"], dir),
			]
			expect(runs.map(({ err, status }) => [status, err.split("\n")[0]])).toEqual([
				[1, "honey: unknown option --manifset"],
				[1, "honey: config file not found: nope.ts"],
				[1, `honey: no honey() plugin found in ${join(dir, "vite.config.ts")}; add honey() to it or pass --app`],
			])
			expect(read(dir, "src/_gen/routes.gen.ts")).toBe("")
		},
		SLOW,
	)

	// v0: 3827a1216a
	it(
		"calls a function-form Vite config with the command and mode",
		async () => {
			const { dir } = fresh({
				"src/app.ts": appSource(),
				"vite.config.ts": `import { honey } from "@lovrozagar/honey/plugin"\nexport default ({ command, mode }) => ({ plugins: [honey({ app: "src/app.ts", codegen: { manifest: command === "build" && mode === "production" } })] })\n`,
			})
			expect((await run(["generate"], dir)).status).toBe(0)
			expect(read(dir, "src/_gen/manifest.gen.json")).not.toBe("")
		},
		SLOW,
	)
})

describe("honey generate (bit 19 h2), continued (3)", () => {
	// v0: 8181e4ba07
	it(
		"asks which plugin when the config has several, picks by --plugin or a matching --app, and refuses one out of range",
		async () => {
			const { dir } = fresh({
				"src/a.ts": appSource(),
				"src/b.ts": appSource({ extra: ['\t.get("/b").handler((c) => c.res.text("ok", "b"))'] }),
				"vite.config.ts": `import { honey } from "@lovrozagar/honey/plugin"\nexport default { plugins: [honey({ app: "src/a.ts" }), [honey({ app: "src/b.ts" })], honey({})] }\n`,
			})
			const asked = await run(["generate"], dir)
			expect([asked.status, asked.err.split("\n").slice(0, 4)]).toEqual([
				1,
				[
					`honey: ${join(dir, "vite.config.ts")} has 3 honey() plugins; pick one with --plugin <n>:`,
					"  0: src/a.ts",
					"  1: src/b.ts",
					"  2: (no app)",
				],
			])
			expect((await run(["generate", "--plugin", "1"], dir)).status).toBe(0)
			expect(read(dir, "src/_gen/routes.gen.ts")).toContain('"GET /b"')
			expect((await run(["generate", "--app", "src/a.ts"], dir)).status).toBe(0)
			expect(read(dir, "src/_gen/routes.gen.ts")).not.toContain('"GET /b"')
			expect((await run(["generate", "--plugin", "7"], dir)).err.split("\n")[0]).toBe(
				`honey: --plugin 7: ${join(dir, "vite.config.ts")} has 3 honey() plugin(s)`,
			)
		},
		SLOW,
	)

	it(
		"reports a failed generation and exits 1",
		async () => {
			const { dir } = fresh({ "src/app.ts": "export const app = 1\n" })
			const { err, out, status } = await run(["generate", "--app", "src/app.ts"], dir)
			expect({ first: err.split("\n")[0], out, status }).toEqual({
				first: `honey: generation failed: Expected a honey app as the app or default export of ${join(dir, "src/app.ts")}`,
				out: "",
				status: 1,
			})
		},
		SLOW,
	)
})

describe("honey generate's failure report (bit 19 j2)", () => {
	it(
		"follows a failed generation's message with the stack, naming the frame that threw",
		async () => {
			/* the diagnosis a once-seen failure lacked (j2): the message alone named no frame */
			const { dir } = fresh({ "src/app.ts": 'export const app = 1\nthrow new Error("boom at load")\n' })
			const { err, status } = await run(["generate", "--app", "src/app.ts"], dir)
			const [first, ...frames] = err.trimEnd().split("\n")
			expect([status, first, frames.some((line) => /^\s+at .*src\/app\.ts:2\b/.test(line))]).toEqual([
				1,
				"honey: generation failed: boom at load",
				true,
			])
		},
		SLOW,
	)
})

describe("honey generate through the bin (bit 19 h2)", () => {
	const bin = (runtime: string, dir: string, args: readonly string[]) =>
		spawnSync(runtime, [BIN, "generate", ...args], {
			cwd: dir,
			encoding: "utf8",
			env: { ...process.env, HONEY_NO_BUN_HANDOFF: "1" },
			timeout: SLOW,
		})

	// v0: 80d2523822
	it(
		"reads the config off the plugin object on Node and on Bun alike",
		() => {
			const { dir } = fresh({ "src/app.ts": appSource(), "vite.config.ts": CONFIG('{ app: "src/app.ts" }') })
			const runs = ["node", "bun"].map((runtime) => bin(runtime, dir, []))
			expect(runs.map((done) => [done.status, done.stdout, done.stderr])).toEqual([
				[0, "honey: generated\n", ""],
				[0, "honey: generated\n", ""],
			])
		},
		SLOW,
	)

	// v0: 619b088296
	/* its binding half retires (Q3): v1 never serves implicitly, so there is no bind to suppress */
	it(
		"ends once it has written, though the app's module left a timer running",
		() => {
			const { dir } = fresh({ "src/app.ts": `${appSource()}setInterval(() => {}, 1000)\n` })
			const started = Date.now()
			const done = bin("node", dir, ["--app", "src/app.ts"])
			expect([
				done.status,
				done.stderr,
				Date.now() - started < 30_000,
				read(dir, "src/_gen/routes.gen.ts") !== "",
			]).toEqual([0, "", true, true])
		},
		SLOW,
	)
})

describe("honey generate through the bin, a signal as it spawns (CI 40547426989)", () => {
	it("forwards a signal that lands the instant its Bun child is spawned, before any other statement", async () => {
		const mark = markOf()
		const dir = mkdtempSync(join(tmpdir(), "honey-bun-"))
		/* a Bun that runs nothing: it only has to live until the bin hands it the signal */
		writeFileSync(join(dir, "bun"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 })
		const parent = spawn(process.execPath, ["--import", SIGNAL_ON_SPAWN, BIN, "generate"], {
			env: {
				[MARK_KEY]: mark,
				PATH: process.env.PATH,
				npm_config_user_agent: "bun/1.3.11",
				npm_execpath: join(dir, "bun"),
			},
		})
		const signal = await new Promise<NodeJS.Signals | null>((settle) =>
			parent.on("exit", (_code, ended) => settle(ended)),
		)
		/* the child was handed the signal, so nothing carrying the mark outlives the parent for long */
		const gone = await until(() => marked(mark).length === 0, 3_000)
		reap(mark)
		rmSync(dir, { recursive: true, force: true })
		expect([signal, gone]).toEqual(["SIGTERM", true])
	}, 30_000)
})

/** `honey generate --watch <args>` in `dir`, until the leg ends. */
function watching(dir: string, args: readonly string[] = []) {
	const controller = new AbortController()
	const ended = run(["generate", "--watch", ...args], dir, controller.signal)
	watches.push({ controller, ended })
	return { controller, ended }
}

describe("honey generate --watch (bit 19 h2)", () => {
	// v0: 3c166848de
	// v0: 80932aac33
	it(
		"regenerates when the app, or a module it imports, changes",
		async () => {
			const made = fresh({
				"src/app.ts":
					'import { honey } from "@lovrozagar/honey"\nimport { path } from "./routes.ts"\nexport const app = honey().get(path).handler((c) => c.res.text("ok", "ok"))\n',
				"src/routes.ts": 'export const path = "/first"\n',
			})
			watching(made.dir, ["--app", "src/app.ts"])
			const tree = () => read(made.dir, "src/_gen/routes.gen.ts")
			expect(await until(() => tree().includes('"GET /first"'))).toBe(true)
			made.write("src/routes.ts", 'export const path = "/second"\n')
			expect(await until(() => tree().includes('"GET /second"'))).toBe(true)
			made.write(
				"src/app.ts",
				'import { honey } from "@lovrozagar/honey"\nexport const app = honey().get("/third").handler((c) => c.res.text("ok", "ok"))\n',
			)
			expect(await until(() => tree().includes('"GET /third"'))).toBe(true)
		},
		SLOW,
	)

	// v0: ca533d3400
	it(
		"keeps an edit made while the first generation runs",
		async () => {
			const made = fresh({ "src/app.ts": appSource(), "src/routes.ts": 'export const path = "/late"\n' })
			watching(made.dir, ["--app", "src/app.ts"])
			/* at once, before the first child can have finished */
			made.write("src/app.ts", appSource({ extra: ['\t.get("/late").handler((c) => c.res.text("ok", "ok"))'] }))
			expect(await until(() => read(made.dir, "src/_gen/routes.gen.ts").includes('"GET /late"'))).toBe(true)
		},
		SLOW,
	)
})

describe("honey generate --watch (bit 19 h2), continued (2)", () => {
	// v0: 6893b6cc95
	// v0: 872ff08c17
	it(
		"does not loop on its own outputs written beside the app",
		async () => {
			const made = fresh({
				"src/app.ts": appSource(),
				"vite.config.ts": CONFIG(
					'{ app: "src/app.ts", codegen: { manifest: "src/manifest.json", openApi: { path: "src/openapi.json", title: "T", version: "1" }, tree: "src/routes.gen.ts" } }',
				),
			})
			const log = join(made.dir, "evaluations.log")
			made.write(
				"src/app.ts",
				`import { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(log)}, "x")\n${appSource()}`,
			)
			const watch = watching(made.dir)
			expect(await until(() => read(made.dir, "src/openapi.yaml") !== "")).toBe(true)
			/* a settle window: a loop would evaluate the app again within it */
			const settled = read(made.dir, "evaluations.log").length
			await new Promise((done) => setTimeout(done, 1500))
			expect([settled, read(made.dir, "evaluations.log").length]).toEqual([settled, settled])
			watch.controller.abort()
			expect((await watch.ended).out).toBe(`honey: watching ${join(made.dir, "src")}\n`)
		},
		SLOW,
	)

	it(
		"refuses --watch with no app, and in a generation child",
		async () => {
			const { dir } = fresh({ "vite.config.ts": CONFIG("{}") })
			expect((await run(["generate", "--watch"], dir)).err.split("\n")[0]).toBe(
				"honey: --watch requires --app or a honey() config with app",
			)
			const child = await main(
				["generate", "--watch", "--app", "src/app.ts"],
				{ err: () => {}, out: () => {} },
				{ cwd: dir, env: { HONEY_WATCH_CHILD: "1" } },
			)
			expect(child).toBe(1)
		},
		SLOW,
	)
})

describe("honey init (bit 19 h2)", () => {
	// v0: e0df49e6b5
	it(
		"scaffolds a project whose generate picks up a route added between two runs",
		async () => {
			const made = fresh()
			expect((await run(["init"], made.dir)).status).toBe(0)
			expect((await run(["generate"], made.dir)).status).toBe(0)
			expect(read(made.dir, "src/_gen/routes.gen.ts")).not.toContain('"GET /users"')
			made.write(
				"src/app.ts",
				read(made.dir, "src/app.ts").replace(
					'.get("/health")',
					'.get("/users")\n\t\t.handler((ctx) => ctx.res.text("ok", "users"))\n\t\t.get("/health")',
				),
			)
			expect((await run(["generate"], made.dir)).status).toBe(0)
			expect(read(made.dir, "src/_gen/routes.gen.ts")).toContain('"GET /users"')
		},
		SLOW,
	)
})

describe("honey generate's edges (bit 19 h2)", () => {
	it(
		"reads the Vite command and mode a parent passes, and reports to its stderr",
		async () => {
			const { dir } = fresh({
				"src/app.ts": appSource({ extra: HIDDEN_ADDITION }),
				"vite.config.ts": `import { honey } from "@lovrozagar/honey/plugin"\nexport default ({ command, mode }) => ({ plugins: [honey({ app: "src/app.ts", codegen: { manifest: command === "serve" && mode === "development", tree: false, types: true } })] })\n`,
			})
			let err = ""
			const io = { err: (text: string) => void (err += text), out: () => {} }
			expect(await main(["generate"], io, { cwd: dir, env: { HONEY_VITE_COMMAND: "serve" } })).toBe(0)
			expect([read(dir, "src/_gen/manifest.gen.json") !== "", err]).toEqual([
				true,
				"honey: GET /hidden: extracted ctx additions match no documented operation (internal and filtered routes are not documented); not typed\n",
			])
		},
		SLOW,
	)

	it("runs from the process's own directory and environment by default", { timeout: SPAWN_TIMEOUT }, async () => {
		let out = ""
		expect(await main(["--help"], { err: () => {}, out: (text) => void (out += text) })).toBe(0)
		expect(out).toBe(`${USAGE}\n`)
	})
})

describe("honey generate --watch's edges (bit 19 h2)", () => {
	it(
		"goes on past a failed generation to the next edit's",
		async () => {
			const made = fresh()
			const log = join(made.dir, "evaluations.log")
			/* evaluated, then refused: not a honey app */
			made.write(
				"src/app.ts",
				`import { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(log)}, "x")\nexport const app = 1\n`,
			)
			const watch = watching(made.dir, ["--app", "src/app.ts"])
			expect(await until(() => read(made.dir, "evaluations.log") === "x")).toBe(true)
			made.write("src/app.ts", appSource())
			expect(await until(() => read(made.dir, "src/_gen/routes.gen.ts").includes('"GET /health"'))).toBe(true)
			watch.controller.abort()
			expect((await watch.ended).out).toBe(`honey: watching ${join(made.dir, "src")}\n`)
		},
		SLOW,
	)

	it(
		"starts on an entry not there yet and generates once it is",
		async () => {
			const made = fresh({ "src/other.ts": "export const x = 0\n" })
			const stop = new AbortController()
			let out = ""
			const io = { err: () => {}, out: (text: string) => void (out += text) }
			const ended = main(["generate", "--watch", "--app", "src/late.ts"], io, {
				cwd: made.dir,
				env: {},
				signal: stop.signal,
			})
			watches.push({ controller: stop, ended })
			/* written only once the watch is armed over an entry that was not there */
			expect(await until(() => out.includes("honey: watching"))).toBe(true)
			made.write("src/late.ts", appSource())
			expect(await until(() => read(made.dir, "src/_gen/routes.gen.ts").includes('"GET /health"'))).toBe(true)
		},
		SLOW,
	)
})
