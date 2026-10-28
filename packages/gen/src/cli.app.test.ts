/**
 * `honey-codegen generate --app` (bit 19 h2, Q1): the SDKs, the CLI and MCP generated from a honey app module, its
 * document made by the app's own core with the module's `openApi` export as its options (security schemes, the
 * invalidate check). `--spec` and `--app` name the document, so both at once is a usage error, never one silently
 * winning. Under `bun run` the bin hands the load to Bun, whose loaders the app may need, and a run ends once it has
 * written, whatever handles the app's module left open.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { main } from "./cli.ts"
import { pinnedBunVersion, withPinnedBun } from "./gen/__fixtures__/pinned-bun.ts"
import { MARK_KEY, markOf, reap } from "./gen/__fixtures__/survivors.ts"
import { appProject } from "./ir/__fixtures__/app-project.ts"

const BIN = resolve(import.meta.dirname, "../bin/honey-codegen.js")
const REPO = resolve(import.meta.dirname, "../../..")
const PINNED_BUN = withPinnedBun()
const MARK = markOf()
const HONEY = 'import { honey } from "@lovrozagar/honey"\n'

const projects: (() => void)[] = []
afterEach(() => {
	for (const done of projects.splice(0)) done()
	vi.restoreAllMocks()
})

/** A fresh project of `files`, removed after the leg. */
function project(files: Record<string, string>): string {
	const { dir, done } = appProject(files)
	projects.push(done)
	return dir
}

/**
 * `main` in process from `cwd`: its exit code, what it wrote, and every line the app's logger printed meanwhile (its
 * default sink, stdout; NODE_ENV production, since under test it is silent).
 */
async function run(argv: readonly string[], cwd: string) {
	let [out, err, logged] = ["", "", ""]
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => ((logged += String(chunk)), true))
	vi.stubEnv("NODE_ENV", "production")
	const status = await main(argv, { err: (text) => (err += text), out: (text) => (out += text) }, { cwd })
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
	return { err, logged, out, status }
}

/** Every generated file's text under `dir`, joined. */
const textUnder = (dir: string) =>
	readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
		.join("\n")

const GENERATE = ["generate", "--target", "ts", "--out", "out"]

describe("generate --app (bit 19 h2)", () => {
	// v0: 801b406e79
	// v0: cb437d7688
	it("generates the TypeScript SDK from an app module, no spec given", async () => {
		const dir = project({
			"src/app.ts": `${HONEY}export const app = honey().get("/health").meta({ operationId: "health.get" }).handler((c) => c.res.text("ok", "ok"))\n`,
		})
		const result = await run(["generate", "--app", "src/app.ts", "--target", "ts", "--out", "out"], dir)
		expect([result.status, result.err, result.out.startsWith("honey-codegen: generated")]).toEqual([0, "", true])
		expect(textUnder(join(dir, "out/ts"))).toContain('"/health"')
	})

	// v0: f3c257c447
	it("refuses --spec beside --app, an --app with no value and an unknown flag, writing nothing", async () => {
		const dir = project({ "src/app.ts": `${HONEY}export const app = honey()\n`, "stale.json": "{}" })
		const firstLines = []
		for (const argv of [
			[...GENERATE, "--spec", "stale.json", "--app", "src/app.ts"],
			[...GENERATE, "--app"],
			[...GENERATE, "--app", "src/app.ts", "--manifset"],
		])
			firstLines.push(await run(argv, dir).then(({ err, status }) => [status, err.split("\n")[0]]))
		expect(firstLines).toEqual([
			[1, "honey-codegen: --spec and --app each name the document: give one"],
			[1, "honey-codegen: --app requires a value"],
			[1, "honey-codegen: unknown option --manifset"],
		])
		expect(readdirSync(dir).sort()).toEqual(["node_modules", "src", "stale.json"])
	})
})

describe("generate --app with the module's openApi options (bit 19 h2)", () => {
	// v0: 13874dcde2
	it("takes a security scheme the module's openApi declares as declared, and the SDK sends it", async () => {
		const route = `honey().get("/t").meta({ operationId: "t.get", security: "iaTesterKey" }).handler((c) => c.res.json("ok", {}))`
		const scheme = `{ iaTesterKey: { in: "header", name: "x-ia-tester-key", type: "apiKey" } }`
		const dir = project({
			"src/bare.ts": `${HONEY}export const app = ${route}\n`,
			"src/declared.ts": `${HONEY}export const app = ${route}\nexport const openApi = { info: { title: "t", version: "1" }, securitySchemes: ${scheme} }\n`,
		})
		const bare = await run(["generate", "--app", "src/bare.ts", "--target", "ts", "--out", "bare"], dir)
		const declared = await run(["generate", "--app", "src/declared.ts", ...GENERATE.slice(1)], dir)
		expect([
			/not declared/.test(bare.logged),
			/not declared|UNKNOWN_SECURITY/.test(declared.logged),
			declared.status,
		]).toEqual([true, false, 0])
		expect(textUnder(join(dir, "out/ts"))).toContain("x-ia-tester-key")
	})

	// v0: cfefebba33
	it("says nothing of a mutation's missing invalidate when the module's openApi turns the check off", async () => {
		const routes = `honey().post("/tables").meta({ operationId: "tables.create" }).handler((c) => c.res.text("ok", "ok")).get("/tables").meta({ operationId: "tables.list" }).handler((c) => c.res.text("ok", "ok"))`
		const dir = project({
			"src/checked.ts": `${HONEY}export const app = ${routes}\n`,
			"src/off.ts": `${HONEY}export const app = ${routes}\nexport const openApi = { info: { title: "t", version: "1" }, invalidate: "off" }\n`,
		})
		const targets = ["--target", "ts", "--target", "python"]
		const checked = await run(["generate", "--app", "src/checked.ts", ...targets, "--out", "checked"], dir)
		const off = await run(["generate", "--app", "src/off.ts", ...targets, "--out", "off"], dir)
		expect([/POST\s+\/tables → GET \/tables/.test(checked.logged), off.logged, off.status]).toEqual([true, "", 0])
	})
})

describe.skipIf(!PINNED_BUN)(`generate --app through the bin under Bun ${pinnedBunVersion()} (bit 19 h2)`, () => {
	/** The bin under Node from `cwd`, as `bun run` starts it when `bun` is set (else with no handoff), its run marked. */
	const bin = (cwd: string, args: readonly string[], bun?: string) =>
		spawnSync("node", [BIN, ...args], {
			cwd,
			encoding: "utf8",
			env: {
				...process.env,
				[MARK_KEY]: MARK,
				...(bun === undefined
					? { HONEY_NO_BUN_HANDOFF: "1" }
					: { HONEY_NO_BUN_HANDOFF: "", npm_config_user_agent: "bun/1 npm/? node/v24 linux x64", npm_execpath: bun }),
			},
			timeout: 60_000,
		})

	// v0: aeff0f4b4d
	it("hands the load to the Bun that started it, so a module Bun alone can load generates", () => {
		const dir = project({
			"src/app.ts": `import terms from "./terms.md"\n${HONEY}export const app = honey().get("/terms").handler((c) => c.res.text("ok", String(terms)))\n`,
			"src/terms.md": "# Terms\n",
		})
		const run = bin(dir, ["generate", "--app", "src/app.ts", ...GENERATE.slice(1)], PINNED_BUN as string)
		expect([run.status, run.stderr]).toEqual([0, ""])
	}, 90_000)

	// v0: 619b088296
	it("ends once it has written, though the app's module left a timer running", () => {
		const dir = project({
			"src/app.ts": `${HONEY}export const app = honey().get("/health").handler((c) => c.res.text("ok", "ok"))\nsetInterval(() => {}, 1000)\n`,
		})
		const started = Date.now()
		const run = bin(dir, ["generate", "--app", "src/app.ts", ...GENERATE.slice(1)])
		expect([run.status, run.stderr, Date.now() - started < 30_000]).toEqual([0, "", true])
	}, 90_000)
})

/** The bin started by Bun itself from `cwd`, a fresh TMPDIR (a cold jiti cache) and `env` over the rest, its run marked. */
function onBun(cwd: string, env: NodeJS.ProcessEnv = {}) {
	const tmp = join(cwd, "cold-tmp")
	mkdirSync(tmp, { recursive: true })
	return spawnSync(PINNED_BUN as string, [BIN, "generate", "--app", "src/app.ts", ...GENERATE.slice(1)], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, BUN_OPTIONS: "", [MARK_KEY]: MARK, TMPDIR: tmp, ...env },
		timeout: 60_000,
	})
}

describe.skipIf(!PINNED_BUN)(`generate --app on Bun ${pinnedBunVersion()}, by Bun's own import (bit 20)`, () => {
	afterEach(() => void reap(MARK))

	it("evaluates a module that throws at load once, and says why", () => {
		const dir = project({
			"src/app.ts":
				'import { appendFileSync } from "node:fs"\nappendFileSync("evaluations.log", "x")\nthrow new Error("boom at load")\n',
		})
		const run = onBun(dir)
		expect([run.status, run.stderr, readFileSync(join(dir, "evaluations.log"), "utf8")]).toEqual([
			1,
			"honey-codegen: boom at load\n",
			"x",
		])
	}, 90_000)

	/* Vite's Node chunk makes follow-redirects' errors with a non-Error captureStackTrace at load: once jiti's Babel has
	 * hooked Error.prepareStackTrace, Bun throws "First argument must be an Error object" there */
	it("generates from a module importing vite, a cold jiti cache", () => {
		const dir = project({
			"src/app.ts": `import { defaultClientConditions } from "vite"\n${HONEY}export const app = honey().get("/health").handler((c) => c.res.text("ok", "ok"))\nexport const conditions = defaultClientConditions\n`,
		})
		symlinkSync(join(REPO, "node_modules/vite"), join(dir, "node_modules/vite"), "dir")
		const run = onBun(dir)
		expect([run.status, run.stderr, existsSync(join(dir, "out/ts/.honey-generated.json"))]).toEqual([0, "", true])
	}, 90_000)

	it("reads a checkout core from its source, never a stale dist/ beside it", () => {
		const stale = (file: string) =>
			`import { appendFileSync } from "node:fs"\nappendFileSync("evaluations.log", "dist ")\nexport * from ${JSON.stringify(join(REPO, "packages/core/src", file))}\n`
		const dir = project({
			"node_modules/@lovrozagar/honey/dist/openapi/register.js": stale("openapi/register.ts"),
			"node_modules/@lovrozagar/honey/dist/routing/app.js": stale("routing/app.ts"),
			"src/app.ts": `${HONEY}export const app = honey().get("/health").handler((c) => c.res.text("ok", "ok"))\n`,
		})
		const run = onBun(dir)
		expect([run.status, run.stderr, existsSync(join(dir, "evaluations.log"))]).toEqual([0, "", false])
	}, 90_000)
})

describe.skipIf(!PINNED_BUN)(`the bin's honey-source hand-off on Bun ${pinnedBunVersion()} (bit 20)`, () => {
	afterEach(() => void reap(MARK))

	/* each Bun process the run starts logs one start (a preload), and the fourth ends itself: a loop is bounded */
	it("hands off to itself once without the honey-source condition, and not at all with it in BUN_OPTIONS", () => {
		const dir = project({
			"src/app.ts": `${HONEY}export const app = honey().get("/health").handler((c) => c.res.text("ok", "ok"))\n`,
		})
		const starts = join(dir, "starts.log")
		writeFileSync(
			join(dir, "count.mjs"),
			`import { appendFileSync, readFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(starts)}, "s")\nif (readFileSync(${JSON.stringify(starts)}, "utf8").length > 3) process.exit(9)\n`,
		)
		const counted = (options: string) => {
			writeFileSync(starts, "")
			const run = onBun(dir, { BUN_OPTIONS: `--preload ${join(dir, "count.mjs")}${options}` })
			return [run.status, run.stderr, readFileSync(starts, "utf8").length]
		}
		expect([counted(""), counted(" --conditions=honey-source")]).toEqual([
			[0, "", 2],
			[0, "", 1],
		])
	}, 90_000)
})

describe("generate --app --watch (bit 19 h2)", () => {
	/** Whether `check()` came to hold within `ms`, polled each 50 ms. */
	async function until(check: () => boolean, ms = 30_000): Promise<boolean> {
		for (const start = Date.now(); !check(); await new Promise((done) => setTimeout(done, 50)))
			if (Date.now() - start > ms) return false
		return true
	}

	it("generates again on each change of the app module", async () => {
		const route = (path: string) =>
			`${HONEY}export const app = honey().get("${path}").handler((c) => c.res.text("ok", "ok"))\n`
		const dir = project({ "src/app.ts": route("/first") })
		const stop = new AbortController()
		let stdout = ""
		const io = { err: () => {}, out: (text: string) => void (stdout += text) }
		const watching = main([...GENERATE, "--app", "src/app.ts", "--watch"], io, {
			cwd: dir,
			env: { ...process.env, [MARK_KEY]: MARK },
			signal: stop.signal,
		})
		const holds = (path: string) =>
			until(() => existsSync(join(dir, "out/ts")) && textUnder(join(dir, "out/ts")).includes(`"${path}"`))
		expect(await holds("/first")).toBe(true)
		writeFileSync(join(dir, "src/app.ts"), route("/second"))
		expect(await holds("/second")).toBe(true)
		stop.abort()
		expect([await watching, stdout]).toEqual([0, `honey-codegen: watching ${join(dir, "src/app.ts")}\n`])
	}, 90_000)
})

describe("no process left behind (bit 19 h2)", () => {
	it("leaves no child of this file running: any that outlived its leg is killed and named", () => {
		expect(reap(MARK)).toEqual([])
	})
})
