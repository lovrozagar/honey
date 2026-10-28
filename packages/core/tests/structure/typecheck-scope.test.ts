/**
 * Every tsconfig.json the repository tracks is type-checked by a gate (bit 20 k-fix): the cf e2e host's carried two
 * errors that no gate ran. A gate is `typecheck` or one the standards block names; it checks a tsconfig through
 * `tsc --noEmit -p <path>`, or through `bun run --filter <...> type:check` over the workspaces it selects, whose
 * `type:check` is `tsc --noEmit` in their own directory.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { SPAWN_TIMEOUT } from "../../../gen/src/gen/__fixtures__/spawn-timeout.ts"

const ROOT = join(import.meta.dirname, "../../../..")
/* checked against the packed tarball by test:packaging: in the tree it resolves no published exports (bit 19 i) */
const PACKED_ONLY = ["packages/core/tests/e2e/strict-consumer/tsconfig.json"]

type Manifest = { name?: string; scripts?: Record<string, string>; standards?: { gates?: string[] } }

const manifestAt = (dir: string) => JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) as Manifest
/** The tracked files named `name`, repo-relative. */
const tracked = (name: string) =>
	execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
		.split("\n")
		.filter((path) => path === name || path.endsWith(`/${name}`))

/** A `bun --filter` value as a test on a workspace: a `./` path glob (`*` within one segment), else a package name. */
function selects(filter: string, dir: string, name: string | undefined): boolean {
	if (!filter.startsWith("./")) return filter === name
	const glob = filter
		.slice(2)
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
	return new RegExp(`^${glob.join("[^/]*")}$`).test(dir)
}

/** The tsconfig.json paths the root scripts `gates` type-check, repo-relative. */
function checkedBy(scripts: Record<string, string>, gates: readonly string[]): Set<string> {
	const workspaces = tracked("package.json")
		.map((path) => dirname(path))
		.filter((dir) => dir !== ".")
	const checked = new Set<string>()
	for (const gate of gates) {
		const script = scripts[gate] ?? ""
		for (const [, path] of script.matchAll(/tsc --noEmit -p (\S+)/g)) checked.add(path as string)
		if (!/\btype:check$/.test(script)) continue
		const filters = [...script.matchAll(/--filter '?([^'\s]+)'?/g)].map(([, filter]) => filter as string)
		for (const dir of workspaces) {
			const manifest = manifestAt(dir)
			if (manifest.scripts?.["type:check"] !== "tsc --noEmit") continue
			if (filters.some((filter) => selects(filter, dir, manifest.name))) checked.add(join(dir, "tsconfig.json"))
		}
	}
	return checked
}

describe("every tracked tsconfig.json is type-checked by a gate (bit 20 k-fix)", () => {
	it("names none a gate leaves unchecked", { timeout: SPAWN_TIMEOUT }, () => {
		const root = manifestAt(".")
		const checked = checkedBy(root.scripts ?? {}, ["typecheck", ...(root.standards?.gates ?? [])])
		const unchecked = tracked("tsconfig.json").filter((path) => !checked.has(path) && !PACKED_ONLY.includes(path))
		expect(unchecked).toEqual([])
	})
})
