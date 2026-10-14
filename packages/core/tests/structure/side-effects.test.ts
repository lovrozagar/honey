/**
 * The package declares side effects for exactly its optional feature entries (H19.3): a file whose
 * module scope registers a feature (`// feature-entry: <name>`) must be in `sideEffects`, or a
 * bundler drops the import that registers it; a listed file that registers nothing would keep
 * code a bundler could drop. The `./trust` subpath resolves to the trust entry.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const CORE = resolve(import.meta.dirname, "../..")

type Manifest = { exports: Record<string, Record<string, string>>; sideEffects: unknown }

const manifest = JSON.parse(readFileSync(resolve(CORE, "package.json"), "utf8")) as Manifest

/** Every source file, outside tests, whose module scope carries a `// feature-entry:` marker. */
function featureEntries(): string[] {
	const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "src"], {
		cwd: CORE,
		encoding: "utf8",
	})
		.split("\n")
		.filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
	return files
		.filter((file) => /^\/\/ feature-entry: [a-z][a-z0-9-]*$/m.test(readFileSync(resolve(CORE, file), "utf8")))
		.map((file) => `./${file}`)
		.sort()
}

describe("the package's side effects", () => {
	it("are exactly the optional feature entries, never false while an entry exists", () => {
		expect(Array.isArray(manifest.sideEffects)).toBe(true)
		expect([...(manifest.sideEffects as string[])].sort()).toEqual(featureEntries())
	})

	it("include the trust entry, which the ./trust subpath resolves to", () => {
		expect(featureEntries()).toContain("./src/trust/trust.ts")
		expect(manifest.exports["./trust"]).toEqual({
			"honey-source": "./src/trust/trust.ts",
			default: "./src/trust/trust.ts",
		})
	})
})
