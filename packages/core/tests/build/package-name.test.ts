/**
 * One package name, in every place that declares it (bit 22, the honey-clients rename). The generator package is
 * named in four places that cannot see each other: its own manifest, core's dynamic `import()` of it, core's
 * optional `peerDependencies` entry, and the bin it installs. A rename that misses one of them type-checks, installs
 * and ships — the import fails only when a user runs `honey generate`, and the peer warning only when they install.
 * So the four are read here and held equal.
 *
 * The name is read out of `generate.ts`'s source rather than imported, because `CLIENTS` is module-local and should
 * stay that way: a constant does not become exported to satisfy a test (the budget ledger leg reads its constants
 * the same way).
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ROOT } from "./fixture/workflows.ts"

type Manifest = {
	bin?: Record<string, string>
	devDependencies?: Record<string, string>
	files?: string[]
	name?: string
	peerDependencies?: Record<string, string>
	peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

const read = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8")) as Manifest
const gen = read("packages/gen/package.json")
const core = read("packages/core/package.json")

/** The package `generate.ts` imports, from its `CLIENTS` constant; it throws when the constant is not there to read. */
export function importedName(source: string): string {
	const named = /^const CLIENTS = "(@[\w./-]+)"$/m.exec(source)
	if (named === null) throw new Error('generate.ts declares no `const CLIENTS = "…"` to read')
	return named[1] as string
}

/** Each place that names the generator package, by where it is declared. */
export function declaredNames(manifest: Manifest, consumer: Manifest, source: string): Record<string, string[]> {
	const scoped = (names: readonly string[]) => names.filter((name) => name.startsWith("@lovrozagar/honey-"))
	return {
		"core's dynamic import": [importedName(source)],
		"core's optional peer": scoped(Object.keys(consumer.peerDependencies ?? {})),
		"core's peer meta": scoped(Object.keys(consumer.peerDependenciesMeta ?? {})),
		"the generator's manifest": manifest.name === undefined ? [] : [manifest.name],
	}
}

/** The names in `declared` that are not the one `manifest` carries, as `<where>: <name>`. */
export function disagreeing(declared: Record<string, string[]>, expected: string): string[] {
	return Object.entries(declared).flatMap(([where, names]) =>
		names.filter((name) => name !== expected).map((name) => `${where}: ${name}`),
	)
}

describe("the generator package is named the same everywhere (bit 22)", () => {
	it("reads the name out of generate.ts, and refuses a source that declares none", () => {
		expect(importedName('const CLIENTS = "@lovrozagar/honey-clients"\n')).toBe("@lovrozagar/honey-clients")
		expect(() => importedName("const CLIENTS = loadIt()\n")).toThrow("declares no `const CLIENTS")
	})

	it("holds the manifest, the import and both peer entries to one name", () => {
		const source = readFileSync(join(ROOT, "packages/core/src/build/generate.ts"), "utf8")
		const declared = declaredNames(gen, core, source)
		expect(gen.name).toBe("@lovrozagar/honey-clients")
		expect(disagreeing(declared, gen.name as string)).toEqual([])
		/* and every place is actually declared: a missing one is not an agreement */
		expect(Object.entries(declared).filter(([, names]) => names.length === 0)).toEqual([])
	})

	it("reports each place that drifts, naming it", () => {
		const declared = declaredNames(
			{ name: "@lovrozagar/honey-clients" },
			{ peerDependencies: { "@lovrozagar/honey-codegen": ">=1.0.0" }, peerDependenciesMeta: {} },
			'const CLIENTS = "@lovrozagar/honey-older"\n',
		)
		expect(disagreeing(declared, "@lovrozagar/honey-clients")).toEqual([
			"core's dynamic import: @lovrozagar/honey-older",
			"core's optional peer: @lovrozagar/honey-codegen",
		])
	})

	it("installs a bin of that name, from a file it ships", () => {
		const bins = Object.entries(gen.bin ?? {})
		expect(bins).toEqual([["honey-clients", "bin/honey-clients.js"]])
		const [[, path]] = bins as [[string, string]]
		expect(existsSync(join(ROOT, "packages/gen", path))).toBe(true)
		expect(gen.files).toContain(path.split("/")[0])
	})

	it("keeps the devDependency on the same package, so the workspace link is the shipped name", () => {
		const dev = Object.keys(core.devDependencies ?? {}).filter((name) => name.startsWith("@lovrozagar/honey-"))
		expect(dev).toEqual([gen.name])
	})
})
