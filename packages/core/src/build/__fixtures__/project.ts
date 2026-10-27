/**
 * A project whose `@lovrozagar/honey` is this checkout's source (bit 19 h2): the package carries its subpaths, the
 * plugin's `@lovrozagar/honey/plugin` among them (the exports map lands at phase i), and `zod` links to the repo's, so
 * an app, a Vite config and a merge entry import honey as a user's do. Its `src` is a copy of packages/core/src made
 * for this project and removed with it: a generation evaluates the app's core through jiti in this process, and jiti
 * evaluating the very files coverage measures would merge phantom statements into their report. A native leg, which
 * imports the app through the test runner and shares the test's own core, asks for a link instead.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const CORE = /* @__PURE__ */ resolve(import.meta.dirname, "../../..")
const ENTRIES = {
	".": "build/__fixtures__/honey.ts",
	"./build": "build/index.ts",
	"./openapi": "openapi/register.ts",
	"./plugin": "build/plugin.ts",
} as const

export type Project = { readonly dir: string; readonly done: () => void; write(path: string, text: string): void }

/** A fresh project of `files` with core's source copied, or linked when `link`; `done()` removes it. */
export function project(files: Readonly<Record<string, string>> = {}, options: { link?: boolean } = {}): Project {
	const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "honey-plugin-"))
	const honey = join(dir, "node_modules/@lovrozagar/honey")
	mkdirSync(honey, { recursive: true })
	if (options.link === true) symlinkSync(join(CORE, "src"), join(honey, "src"), "dir")
	else cpSync(join(CORE, "src"), join(honey, "src"), { filter: (path) => !path.endsWith(".test.ts"), recursive: true })
	symlinkSync(resolve(CORE, "../../node_modules/zod"), join(dir, "node_modules/zod"), "dir")
	const exports = Object.fromEntries(Object.entries(ENTRIES).map(([subpath, file]) => [subpath, `./src/${file}`]))
	writeFileSync(join(honey, "package.json"), JSON.stringify({ exports, name: "@lovrozagar/honey", type: "module" }))
	const write = (path: string, text: string) => {
		mkdirSync(dirname(join(dir, path)), { recursive: true })
		writeFileSync(join(dir, path), text)
	}
	for (const [path, text] of Object.entries(files)) write(path, text)
	return { dir, done: () => rmSync(dir, { force: true, recursive: true }), write }
}

/** An app module: `export const app` (or `export default`) with GET /health and POST /items, plus `extra` lines. */
export function appSource(options: { extra?: readonly string[]; named?: boolean } = {}): string {
	return [
		'import { createMiddleware, honey } from "@lovrozagar/honey"',
		'import * as z from "zod"',
		`${options.named === false ? "export default" : "export const app ="} honey()`,
		'\t.get("/health").handler((c) => c.res.text("ok", "ok"))',
		'\t.post("/items")',
		"\t.input({ json: z.object({ name: z.string() }) })",
		'\t.handler((c) => c.res.text("ok", "ok"))',
		...(options.extra ?? []),
		"",
	].join("\n")
}
