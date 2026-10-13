import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ENVS = ["bun", "node", "cf"] as const
type EnvName = (typeof ENVS)[number]

const FILTER: Record<EnvName, string> = {
	bun: "@honey/e2e-bun",
	cf: "@honey/e2e-cf-workers",
	node: "@honey/e2e-node",
}

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, "../../../..")
const appsRoot = join(here, "apps")

function discoverApps(): string[] {
	return readdirSync(appsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(appsRoot, entry.name, "tests", "e2e")))
		.map((entry) => entry.name)
		.sort()
}

function printHelp(): void {
	process.stdout.write(`Run Playwright e2e for one environment × one or all consumer apps.

Usage:
  bun packages/core/tests/e2e/run.ts [--env bun|node|cf|all] [--app <name>|all] [--mode dev|prod] [--record <file>]

--record merges each cell's passed / skipped / failed test names into <file> (the committed
expected set is blueprint/baselines/e2e-expected.json).

Defaults:
  --env bun --app all --mode dev

Examples:
  bun packages/core/tests/e2e/run.ts
  bun packages/core/tests/e2e/run.ts --env node
  bun packages/core/tests/e2e/run.ts --env bun --app kitchen
  bun packages/core/tests/e2e/run.ts --env all
`)
}

type Args = { app: string; env: EnvName | "all"; mode: "dev" | "prod"; record: string | null }

function parseArgs(argv: string[]): Args {
	let env: EnvName | "all" = "bun"
	let app = "all"
	let mode: "dev" | "prod" = "dev"
	let record: string | null = null

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === "--help" || arg === "-h") {
			printHelp()
			process.exit(0)
		}
		const next = argv[i + 1]
		if (arg === "--env" && next) {
			env = next as EnvName | "all"
			i++
			continue
		}
		if (arg === "--app" && next) {
			app = next
			i++
			continue
		}
		if (arg === "--mode" && next) {
			mode = next as "dev" | "prod"
			i++
			continue
		}
		if (arg === "--record" && next) {
			record = next
			i++
			continue
		}
		throw new Error(`unknown argument: ${arg}`)
	}

	if (env !== "all" && !ENVS.includes(env)) {
		throw new Error(`unknown --env "${env}". expected ${[...ENVS, "all"].join(", ")}`)
	}
	if (mode !== "dev" && mode !== "prod") {
		throw new Error(`unknown --mode "${mode}". expected dev, prod`)
	}
	return { app, env, mode, record }
}

type Outcomes = { failed: string[]; passed: string[]; skipped: string[] }
type Suite = { specs?: Spec[]; suites?: Suite[]; title: string }
type Spec = { tests: Array<{ status: string }>; title: string }

/** Every test in a Playwright JSON report, named file > describe … > title, by outcome. */
function outcomesOf(report: { suites?: Suite[] }): Outcomes {
	const out: Outcomes = { failed: [], passed: [], skipped: [] }
	const walk = (suite: Suite, path: string[]) => {
		const titles = [...path, suite.title]
		for (const spec of suite.specs ?? []) {
			const name = [...titles, spec.title].join(" > ")
			for (const test of spec.tests) {
				if (test.status === "skipped") out.skipped.push(name)
				else if (test.status === "expected") out.passed.push(name)
				else out.failed.push(name)
			}
		}
		for (const child of suite.suites ?? []) walk(child, titles)
	}
	for (const suite of report.suites ?? []) walk(suite, [])
	for (const list of Object.values(out)) list.sort()
	return out
}

function runCell(
	env: EnvName,
	app: string,
	mode: "dev" | "prod",
	recording: boolean,
): { ok: boolean; outcomes: Outcomes | null } {
	process.stdout.write(`\n=== e2e ${env} × ${app} (${mode}) ===\n`)
	const reportFile = join(tmpdir(), `honey-e2e-${env}-${mode}-${app}.json`)
	rmSync(reportFile, { force: true })
	const record = recording ? { HONEY_E2E_RECORD: reportFile } : {}
	const result = spawnSync("bun", ["run", "--filter", FILTER[env], "test"], {
		cwd: repoRoot,
		env: { ...process.env, ...record, HONEY_E2E_APP: app, HONEY_E2E_ENV: env, TEST_MODE: mode },
		stdio: "inherit",
	})
	const ok = result.status === 0
	process.stdout.write(ok ? `=== pass ${env} × ${app} ===\n` : `=== fail ${env} × ${app} ===\n`)
	if (!recording || !existsSync(reportFile)) return { ok, outcomes: null }
	return { ok, outcomes: outcomesOf(JSON.parse(readFileSync(reportFile, "utf8")) as { suites?: Suite[] }) }
}

const { app, env, mode, record } = parseArgs(process.argv.slice(2))
const knownApps = discoverApps()
if (knownApps.length === 0) {
	throw new Error(`no e2e apps with tests/e2e under ${appsRoot}`)
}

const apps = app === "all" ? knownApps : [app]
for (const name of apps) {
	if (!knownApps.includes(name)) {
		throw new Error(`unknown --app "${name}". known: ${knownApps.join(", ")}`)
	}
}

const envs: EnvName[] = env === "all" ? [...ENVS] : [env]
const results: { app: string; env: EnvName; ok: boolean }[] = []
const recorded: Record<string, Outcomes> = {}

for (const nextEnv of envs) {
	for (const nextApp of apps) {
		const cell = runCell(nextEnv, nextApp, mode, record !== null)
		results.push({ app: nextApp, env: nextEnv, ok: cell.ok })
		if (cell.outcomes !== null) recorded[`${nextEnv}/${mode}/${nextApp}`] = cell.outcomes
	}
}

if (record !== null) {
	const previous = existsSync(record)
		? (JSON.parse(readFileSync(record, "utf8")) as { cells?: Record<string, Outcomes> })
		: {}
	const cells = { ...previous.cells, ...recorded }
	const sorted = Object.fromEntries(Object.entries(cells).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
	const note =
		"e2e expected set: per cell (env/mode/app) the Playwright tests that pass, skip and fail. Re-record with `bun packages/core/tests/e2e/run.ts --env all --mode <dev|prod> --record blueprint/baselines/e2e-expected.json`."
	writeFileSync(record, `${JSON.stringify({ cells: sorted, note }, null, "\t")}\n`)
}

const failed = results.filter((row) => !row.ok)
process.stdout.write("\n=== e2e matrix ===\n")
for (const row of results) {
	process.stdout.write(`${row.ok ? "pass" : "FAIL"}  ${row.env} × ${row.app}\n`)
}

if (failed.length > 0) {
	process.exit(1)
}
