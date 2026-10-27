#!/usr/bin/env bun
// `bun scripts/pack.ts <out dir> <package dir>...`: each package's tarball as npm publishes it, its path printed per
// line. npm packs a manifest as written, and `catalog:` (the root catalog's pins) and `workspace:` (a sibling's
// version) resolve only inside this repo, so each package is packed from a staged copy whose manifest names versions;
// prepack builds dist/ in the copy, so the checkout never gets one. release.yml's pack job and core's packaging tests
// both pack here (bit 19 i).
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

type Manifest = { name: string; version: string } & Partial<Record<(typeof FIELDS)[number], Record<string, string>>>

const ROOT = resolve(import.meta.dirname, "..")
const FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const
const UNSTAGED = new Set(["coverage", "dist", "node_modules", "tests"])

const read = (dir: string): Manifest => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest

/** The repo's own packages by name: the versions `workspace:` names. */
function siblings(): Map<string, string> {
	const dir = join(ROOT, "packages")
	return new Map(
		readdirSync(dir).flatMap((entry) => {
			const pkg = join(dir, entry)
			return existsSync(join(pkg, "package.json")) ? [[read(pkg).name, read(pkg).version] as const] : []
		}),
	)
}

/** `spec` for `name` with `catalog:` and `workspace:` resolved, as bun and pnpm publish them. */
function resolveSpec(
	name: string,
	spec: string,
	catalog: Record<string, string>,
	versions: Map<string, string>,
): string {
	if (spec.startsWith("catalog:")) {
		const pinned = spec === "catalog:" ? catalog[name] : undefined
		if (pinned === undefined) throw new Error(`pack: ${name}@${spec} names no pin in the root catalog`)
		return pinned
	}
	if (!spec.startsWith("workspace:")) return spec
	const version = versions.get(name)
	if (version === undefined) throw new Error(`pack: ${name}@${spec} is no package under packages/`)
	const range = spec.slice("workspace:".length)
	if (range === "*" || range === "") return version
	return range === "^" || range === "~" ? `${range}${version}` : range
}

/** The manifest of `dir` with every dependency specifier resolved. */
function published(dir: string): Manifest {
	const { workspaces } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
		workspaces: { catalog: Record<string, string> }
	}
	const versions = siblings()
	const manifest = read(dir)
	for (const field of FIELDS) {
		const deps = manifest[field]
		if (deps === undefined) continue
		manifest[field] = Object.fromEntries(
			Object.entries(deps).map(([name, spec]) => [name, resolveSpec(name, spec, workspaces.catalog, versions)]),
		)
	}
	return manifest
}

/** The tarball of the package at `dir`, packed into `out` from a copy staged inside the package. */
function pack(dir: string, out: string): string {
	const manifest = published(dir)
	const stage = mkdtempSync(join(dir, ".tmp-pack-"))
	try {
		for (const entry of readdirSync(dir)) {
			if (UNSTAGED.has(entry) || entry.startsWith(".tmp")) continue
			cpSync(join(dir, entry), join(stage, entry), { recursive: true })
		}
		writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`)
		/* npm prints the tarball's name and prepack its log on stdout: both to stderr, the path alone to stdout */
		const packed = spawnSync("npm", ["pack", "--pack-destination", out], { cwd: stage, stdio: ["ignore", 2, 2] })
		if (packed.status !== 0) throw new Error(`pack: npm pack ${manifest.name} failed (${packed.status})`)
	} finally {
		rmSync(stage, { force: true, recursive: true })
	}
	const tarball = join(out, `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz`)
	if (!existsSync(tarball)) throw new Error(`pack: npm pack wrote no ${tarball}`)
	return tarball
}

if (import.meta.main) {
	const [out, ...dirs] = process.argv.slice(2)
	if (out === undefined || dirs.length === 0) {
		console.error("usage: bun scripts/pack.ts <out dir> <package dir>...")
		process.exit(2)
	}
	mkdirSync(resolve(out), { recursive: true })
	for (const dir of dirs) console.log(pack(resolve(dir), resolve(out)))
}
