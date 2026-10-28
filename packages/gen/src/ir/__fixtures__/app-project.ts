/**
 * A project whose `@lovrozagar/honey` is core's v1 source as a checkout (bit 19 h2): the package carries tsconfig.json
 * and core's export shape over a `src` link to packages/core/src, each subpath's `honey-source` its source and its
 * `default` its unbuilt dist/ (bit 20: no `bun` condition, which core dropped and which pointed Bun at the source), so
 * `--app` resolves core from the app as a checkout would. Test-only: core is reached by path, never imported.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const ENTRIES = { ".": "routing/app.ts", "./openapi": "openapi/register.ts" }

/**
 * `files` written into a fresh project beside its core checkout, or as an install with no tsconfig.json when
 * `installed`, its `default` then the source standing in for dist/; `done()` removes it.
 */
export function appProject(
	files: Readonly<Record<string, string>>,
	options: { installed?: boolean } = {},
): { dir: string; done: () => void } {
	const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "codegen-app-"))
	const core = join(dir, "node_modules/@lovrozagar/honey")
	mkdirSync(core, { recursive: true })
	symlinkSync(resolve(import.meta.dirname, "../../../../core/src"), join(core, "src"), "dir")
	const installed = options.installed === true
	const exports = Object.fromEntries(
		Object.entries(ENTRIES).map(([subpath, file]) => {
			const source = `./src/${file}`
			return [subpath, { "honey-source": source, default: installed ? source : `./dist/${file.replace(/ts$/, "js")}` }]
		}),
	)
	/* a plain subpath and one with no source condition, as a real exports map has */
	const all = { ...exports, "./package.json": "./package.json", "./plain": { default: "./src/routing/app.ts" } }
	writeFileSync(join(core, "package.json"), JSON.stringify({ exports: all, name: "@lovrozagar/honey", type: "module" }))
	if (!installed) writeFileSync(join(core, "tsconfig.json"), "{}\n")
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true })
		writeFileSync(join(dir, path), text)
	}
	return { dir, done: () => rmSync(dir, { force: true, recursive: true }) }
}
