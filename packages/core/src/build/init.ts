/**
 * `honey init`: a new project's app, server and Vite config, and with `--cf` a Worker and its wrangler.jsonc. An
 * existing file is refused unless `--force`; an existing package.json keeps its own scripts and `type` unless
 * `--force`, each kept value reported. Lines go to `out` (the CLI's stdout): core prints only through it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import type { InitFlags } from "./cli-args.ts"

type PackageJson = {
	dependencies?: Record<string, string>
	name?: string
	private?: boolean
	scripts?: Record<string, string>
	type?: string
}

const APP_TS = `import { honey } from "@lovrozagar/honey"
import { serveOpenApi } from "@lovrozagar/honey/openapi"

export const app = serveOpenApi(
	honey()
		.get("/health")
		.handler((ctx) => ctx.res.text("ok", "ok")),
	{ docs: "scalar", title: "Honey", version: "0.0.1" },
)
`

const SERVER_TS = `import { serve } from "@lovrozagar/honey/serve"
import { app } from "./app.ts"

await serve(app, { port: Number(process.env.PORT ?? 3000) })
`

const VITE_CONFIG_TS = `import { honey } from "@lovrozagar/honey/plugin"

export default {
	plugins: [
		honey({
			app: "src/app.ts",
		}),
	],
}
`

const WORKER_TS = `import { cfWebSocket } from "@lovrozagar/honey/ws/cloudflare"
import { app } from "./app.ts"

app.wsAdapter(cfWebSocket())

export default {
	fetch: (...args: Parameters<typeof app.fetch>) => app.fetch(...args),
}
`

/** The scoped package the templates import: unscoped `honey` on npm is someone else's. */
const PACKAGE_NAME = "@lovrozagar/honey"

const SCRIPTS: Readonly<Record<string, string>> = { dev: "bun --watch src/server.ts", generate: "honey generate" }

/** Scaffold `cwd`; an existing file is refused, naming it, unless `flags.force`. */
export function runInit(cwd: string, flags: InitFlags, out: (line: string) => void): void {
	const files: Record<string, string> = {
		"src/app.ts": APP_TS,
		"src/server.ts": SERVER_TS,
		"vite.config.ts": VITE_CONFIG_TS,
	}
	if (flags.cf) {
		files["src/worker.ts"] = WORKER_TS
		files["wrangler.jsonc"] = wranglerJsonc(packageNameOf(cwd))
	}
	const collision = Object.keys(files).find((rel) => existsSync(join(cwd, rel)))
	if (collision !== undefined && !flags.force)
		throw new Error(`${collision} already exists: rerun with --force to overwrite it`)
	for (const [rel, contents] of Object.entries(files)) writeText(join(cwd, rel), contents)
	for (const note of writePackageJson(cwd, flags.force)) out(`honey: ${note}`)
	out("honey: initialized")
}

function wranglerJsonc(name: string): string {
	return `{
	"compatibility_date": "2026-01-20",
	"compatibility_flags": ["nodejs_compat"],
	"main": "src/worker.ts",
	"name": ${JSON.stringify(name)},
	"workers_dev": true
}
`
}

/** Write package.json, or add what is missing to the one there; what it kept, as notes. */
function writePackageJson(cwd: string, force: boolean): string[] {
	const path = join(cwd, "package.json")
	const exists = existsSync(path)
	const existing = exists ? readPackageJson(path) : {}
	const notes: string[] = []
	const scripts = { ...existing.scripts }
	for (const [name, command] of Object.entries(SCRIPTS)) {
		const current = scripts[name]
		if (current === undefined || current === command || force) scripts[name] = command
		else notes.push(`kept scripts.${name} (${JSON.stringify(current)}); honey expects ${JSON.stringify(command)}`)
	}
	const dependencies = { ...existing.dependencies }
	if (dependencies[PACKAGE_NAME] === undefined || force) dependencies[PACKAGE_NAME] = `^${honeyVersion()}`
	const next: PackageJson = { ...existing, dependencies, scripts }
	if (!exists) Object.assign(next, { name: packageNameOf(cwd), private: true })
	/* an explicit `type` is the project's choice, kept even under --force */
	if (existing.type === undefined && (!exists || force)) next.type = "module"
	else if (existing.type === undefined)
		notes.push('package.json has no "type"; the scaffold is ESM: set "type": "module", or rerun with --force')
	writeText(path, `${JSON.stringify(next, null, "\t")}\n`)
	return notes
}

function readPackageJson(path: string): PackageJson {
	let parsed: unknown
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"))
	} catch {
		throw new Error("package.json is not valid JSON")
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("package.json must be an object")
	return parsed as PackageJson
}

function writeText(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, contents, "utf8")
}

/** A package name from the directory's: lower case, npm's characters only, else `honey-app`. */
function packageNameOf(dir: string): string {
	const base = basename(dir)
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
	return base || "honey-app"
}

/** This package's version, the dependency range the scaffold asks for. */
function honeyVersion(): string {
	return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string })
		.version
}
