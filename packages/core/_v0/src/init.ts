import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { InitFlags } from "./cli-args.ts"

export type { InitFlags } from "./cli-args.ts"
export { parseInitFlags } from "./cli-args.ts"

type PackageJson = {
	dependencies?: Record<string, string>
	name?: string
	private?: boolean
	scripts?: Record<string, string>
	type?: string
}

const APP_TS = `import { honey } from "@lovrozagar/honey"

export const app = honey()
	.get("/health")
	.handler((ctx) => ctx.res.text("ok", "ok"))
	.openapi({ docs: "scalar", title: "Honey", version: "0.0.1" })
`

const SERVER_TS = `import { app } from "./app.ts"

const port = Number(process.env.PORT ?? 3000)
await app.serve({ port })
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
	fetch: (req: Request, env: Record<string, unknown>, ctx: unknown) => app.fetch(req, env, ctx),
}
`

export function runInit(cwd: string, flags: InitFlags): void {
	const files: Record<string, string> = {
		"src/app.ts": APP_TS,
		"src/server.ts": SERVER_TS,
		"vite.config.ts": VITE_CONFIG_TS,
	}
	if (flags.cf) {
		files["src/worker.ts"] = WORKER_TS
		files["wrangler.jsonc"] = wranglerJsonc(packageNameFromDir(cwd))
	}

	const collisions = Object.keys(files).filter((rel) => existsSync(join(cwd, rel)))
	if (collisions.length > 0 && !flags.force) {
		throw new Error(`${collisions[0]} already exists. Use --force to overwrite.`)
	}

	for (const [rel, contents] of Object.entries(files)) {
		writeText(join(cwd, rel), contents)
	}
	writePackageJson(cwd, flags.force)
	console.log("honey: initialized")
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

const PACKAGE_NAME = "@lovrozagar/honey"

const SCRIPTS: Record<string, string> = {
	dev: "bun --watch src/server.ts",
	generate: "honey generate",
}

/**
 * Creates package.json, or adds what is missing to an existing one. Existing scripts, `type` and
 * dependency ranges are kept unless `force` is set; each kept value is reported.
 */
function writePackageJson(cwd: string, force: boolean): void {
	const path = join(cwd, "package.json")
	const exists = existsSync(path)
	const existing = exists ? readPackageJson(path) : {}
	const notes: string[] = []

	const scripts = { ...existing.scripts }
	for (const [name, command] of Object.entries(SCRIPTS)) {
		const current = scripts[name]
		if (current === undefined || current === command || force) scripts[name] = command
		else notes.push(`kept scripts.${name} ("${current}"); honey expects "${command}"`)
	}

	const dependencies = { ...existing.dependencies }
	if (dependencies[PACKAGE_NAME] === undefined || force) dependencies[PACKAGE_NAME] = `^${honeyVersion()}`

	const next: PackageJson = { ...existing, dependencies, scripts }
	if (!exists) {
		next.name = packageNameFromDir(cwd)
		next.private = true
	}
	if (existing.type === undefined) {
		if (!exists || force) next.type = "module"
		else notes.push('package.json has no "type"; the scaffold is ESM, so set "type": "module" or rerun with --force')
	}

	writeText(path, `${JSON.stringify(next, null, "\t")}\n`)
	for (const note of notes) console.log(`honey: ${note}`)
}

function readPackageJson(path: string): PackageJson {
	let parsed: unknown
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"))
	} catch {
		throw new Error(`package.json is not valid JSON`)
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("package.json must be an object")
	}
	return parsed as PackageJson
}

function writeText(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, contents.endsWith("\n") ? contents : `${contents}\n`, "utf-8")
}

function packageNameFromDir(dir: string): string {
	const base = basename(dir)
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
	return base || "honey-app"
}

function honeyVersion(): string {
	try {
		const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json")
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string }
		return typeof pkg.version === "string" ? pkg.version : "0.0.1"
	} catch {
		return "0.0.1"
	}
}
