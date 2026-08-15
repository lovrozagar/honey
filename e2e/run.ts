import { spawnSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ENVS = ["bun", "node", "deno", "cf"] as const
type EnvName = (typeof ENVS)[number]

const FILTER: Record<EnvName, string> = {
	bun: "@honey/e2e-bun",
	cf: "@honey/e2e-cf-workers",
	deno: "@honey/e2e-deno",
	node: "@honey/e2e-node",
}

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, "..")
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
  bun e2e/run.ts [--env bun|node|deno|cf|all] [--app <name>|all] [--mode dev|prod]

Defaults:
  --env bun --app all --mode dev

Examples:
  bun e2e/run.ts
  bun e2e/run.ts --env node
  bun e2e/run.ts --env bun --app kitchen
  bun e2e/run.ts --env all
`)
}

function parseArgs(argv: string[]): { app: string; env: EnvName | "all"; mode: "dev" | "prod" } {
	let env: EnvName | "all" = "bun"
	let app = "all"
	let mode: "dev" | "prod" = "dev"

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
		throw new Error(`unknown argument: ${arg}`)
	}

	if (env !== "all" && !ENVS.includes(env)) {
		throw new Error(`unknown --env "${env}". expected ${[...ENVS, "all"].join(", ")}`)
	}
	if (mode !== "dev" && mode !== "prod") {
		throw new Error(`unknown --mode "${mode}". expected dev, prod`)
	}
	return { app, env, mode }
}

function runCell(env: EnvName, app: string, mode: "dev" | "prod"): boolean {
	process.stdout.write(`\n=== e2e ${env} × ${app} (${mode}) ===\n`)
	const result = spawnSync("bun", ["run", "--filter", FILTER[env], "test"], {
		cwd: repoRoot,
		env: { ...process.env, HONEY_E2E_APP: app, HONEY_E2E_ENV: env, TEST_MODE: mode },
		stdio: "inherit",
	})
	const ok = result.status === 0
	process.stdout.write(ok ? `=== pass ${env} × ${app} ===\n` : `=== fail ${env} × ${app} ===\n`)
	return ok
}

const { app, env, mode } = parseArgs(process.argv.slice(2))
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

for (const nextEnv of envs) {
	for (const nextApp of apps) {
		results.push({ app: nextApp, env: nextEnv, ok: runCell(nextEnv, nextApp, mode) })
	}
}

const failed = results.filter((row) => !row.ok)
process.stdout.write("\n=== e2e matrix ===\n")
for (const row of results) {
	process.stdout.write(`${row.ok ? "pass" : "FAIL"}  ${row.env} × ${row.app}\n`)
}

if (failed.length > 0) {
	process.exit(1)
}
