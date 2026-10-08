#!/usr/bin/env bun
/**
 * Builds `dist/`: JavaScript, declarations and source maps for every module under `src/`, plus
 * the non-TypeScript assets codegen reads at run time (SDK runtimes, CLI and MCP templates).
 * `prepack` runs this, so a tarball cannot ship without it. See docs/packaging.md.
 *
 *   bun scripts/build.ts
 */
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const src = join(pkgRoot, "src")
const dist = join(pkgRoot, "dist")

/** Directories codegen reads as text through `new URL("./<dir>/…", import.meta.url)`. */
const ASSET_DIRS = ["cli-go", "client-go", "client-mcp", "client-python", "client-rust"] as const

rmSync(dist, { force: true, recursive: true })

const tscBin = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc")
const tsc = spawnSync(process.execPath, [tscBin, "-p", "tsconfig.build.json"], {
	cwd: pkgRoot,
	stdio: "inherit",
})
if (tsc.status !== 0) {
	console.error("build: tsc failed")
	process.exit(tsc.status ?? 1)
}

for (const dir of ASSET_DIRS) {
	const from = join(src, dir)
	if (!existsSync(from)) throw new Error(`build: missing asset directory src/${dir}`)
	cpSync(from, join(dist, dir), { recursive: true })
}

console.log("build: dist ready")
