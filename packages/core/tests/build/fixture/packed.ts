/**
 * The published tarballs and the projects that install them (bit 19 i). Both packages are packed by
 * scripts/pack.ts, the script release.yml's pack job runs: a staged copy with every catalog: and workspace: specifier
 * resolved, prepack building dist/ there, so the checkout never gets a dist/ a source run could pick up by mistake. A
 * consumer sits under TMPDIR, outside the repo, so nothing its install lacks resolves from the repo's node_modules.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

export const CORE = resolve(import.meta.dirname, "../../..")
export const REPO = resolve(CORE, "../..")

export type Tarballs = { readonly core: string; readonly gen: string }
export type Run = { code: number; out: string }

/** `cmd args` in `cwd`, its stdout and stderr together; bounded, so a hung child fails its leg. */
export function run(cmd: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = {}): Run {
	const done = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, timeout: 120_000 })
	return { code: done.status ?? 1, out: `${done.stdout ?? ""}${done.stderr ?? ""}` }
}

function must(what: string, result: Run): void {
	if (result.code !== 0) throw new Error(`${what} failed (${result.code}):\n${result.out}`)
}

/** A scratch directory for one test file, outside the repo; `done()` removes it. */
export function scratch(name: string): { done: () => void; out: string } {
	const out = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `honey-${name}-`))
	return { done: () => rmSync(out, { force: true, recursive: true }), out }
}

/** Both packages' tarballs as release.yml packs them, into `out`. */
export function pack(out: string): Tarballs {
	const into = join(out, "tarballs")
	const packed = spawnSync("bun", [join(REPO, "scripts/pack.ts"), into, CORE, resolve(CORE, "../gen")], {
		cwd: REPO,
		encoding: "utf8",
		timeout: 120_000,
	})
	must("scripts/pack.ts", { code: packed.status ?? 1, out: `${packed.stdout}${packed.stderr}` })
	const [core = "", gen = ""] = packed.stdout.trim().split("\n")
	return { core, gen }
}

/** A consumer project at `dir` that npm-installs `dependencies`, then links `links` from the repo's node_modules. */
export function consumer(
	dir: string,
	dependencies: Readonly<Record<string, string>>,
	links: readonly string[] = [],
): string {
	mkdirSync(dir, { recursive: true })
	const manifest = { dependencies, name: "honey-consumer", private: true, type: "module", version: "0.0.0" }
	writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
	must("npm install", run("npm", ["install", "--no-audit", "--no-fund", "--prefer-offline", "--silent"], dir))
	for (const name of links) {
		mkdirSync(dirname(join(dir, "node_modules", name)), { recursive: true })
		symlinkSync(join(REPO, "node_modules", name), join(dir, "node_modules", name), "dir")
	}
	return dir
}

/** Each of `files` written under `dir`. */
export function write(dir: string, files: Readonly<Record<string, string>>): void {
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true })
		writeFileSync(join(dir, path), text)
	}
}
