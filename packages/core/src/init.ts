import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export type InitFlags = {
	cf: boolean
	force: boolean
}

type PackageJson = {
	dependencies?: Record<string, string>
	name?: string
	private?: boolean
	scripts?: Record<string, string>
	type?: string
}

const APP_TS = `import { honey } from "honey"

export const app = honey()
	.get("/health")
	.handler((ctx) => ctx.res.text("ok", "ok"))
	.openapi({ docs: "scalar", title: "Honey", version: "0.0.1" })
`

const SERVER_TS = `import { app } from "./app.ts"

const port = Number(process.env.PORT ?? 3000)
await app.serve({ port })
`

const VITE_CONFIG_TS = `import { honey } from "honey/plugin"

export default {
	plugins: [
		honey({
			app: "src/app.ts",
		}),
	],
}
`

const WORKER_TS = `import { cfWebSocket } from "honey/ws/cloudflare"
import { app } from "./app.ts"

app.wsAdapter(cfWebSocket())

export default {
	fetch: (req: Request, env: Record<string, unknown>, ctx: unknown) => app.fetch(req, env, ctx),
}
`

export function parseInitFlags(args: string[]): InitFlags {
	return {
		cf: args.includes("--cf"),
		force: args.includes("--force"),
	}
}

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
	writePackageJson(cwd)
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

function writePackageJson(cwd: string): void {
	const path = join(cwd, "package.json")
	const existing = existsSync(path) ? readPackageJson(path) : {}
	const next: PackageJson = {
		...existing,
		name: existing.name ?? packageNameFromDir(cwd),
		private: existing.private ?? true,
		type: existing.type ?? "module",
		scripts: {
			...existing.scripts,
			dev: "bun --watch src/server.ts",
			generate: "honey generate",
		},
		dependencies: {
			...existing.dependencies,
			honey: existing.dependencies?.honey ?? `^${honeyVersion()}`,
		},
	}
	writeText(path, `${JSON.stringify(next, null, "\t")}\n`)
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
