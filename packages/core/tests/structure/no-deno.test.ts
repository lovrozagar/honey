import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { detectRuntime } from "@lovrozagar/honey"
import { describe, expect, it } from "vitest"

const REPO = resolve(import.meta.dirname, "../../../..")
const SELF = "packages/core/tests/structure/no-deno.test.ts"

/* History stays where it is (blueprint README): the changelog, the regression matrix and old specs
 * record what v0 did. The blueprint and agent tooling are not honey source. */
const EXEMPT = [
	/^CHANGELOG\.md$/,
	/^blueprint\//,
	/^packages\/core\/docs\/regression-matrix\//,
	/^\.(agents|claude|codex|gemini|grok|rulesync)\//,
	/^(AGENTS|CLAUDE|GEMINI)\.md$/,
]

function repoFiles(): string[] {
	const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
		cwd: REPO,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	})
	return out.split("\0").filter((f) => f !== "" && f !== SELF && !EXEMPT.some((re) => re.test(f)))
}

function mentionsDeno(file: string): boolean {
	const path = join(REPO, file)
	if (!existsSync(path)) return false
	const bytes = readFileSync(path)
	if (bytes.includes(0)) return false
	return /deno/i.test(bytes.toString("utf8"))
}

describe("Deno is gone (H15)", () => {
	it("no file outside history names deno", () => {
		expect(repoFiles().filter(mentionsDeno)).toEqual([])
	})

	it("the core manifest publishes no ./ws/deno subpath", () => {
		const pkg = JSON.parse(readFileSync(join(REPO, "packages/core/package.json"), "utf8")) as {
			exports: Record<string, unknown>
		}
		expect(Object.keys(pkg.exports)).not.toContain("./ws/deno")
	})
})

describe("node, bun and cloudflare detection still resolves", () => {
	it("detects node from process.versions", () => {
		expect(detectRuntime({ process: { versions: { node: "22.0.0" } } })).toBe("node")
	})

	it("detects bun from the Bun global", () => {
		expect(detectRuntime({ Bun: {} })).toBe("bun")
	})

	it("detects cloudflare from the workers user agent", () => {
		expect(detectRuntime({ navigator: { userAgent: "Cloudflare-Workers" } })).toBe("cloudflare")
	})

	it("a Deno global no longer selects a runtime", () => {
		const g = { Deno: {}, process: { versions: { node: "22.0.0" } } }
		expect(detectRuntime(g)).toBe("node")
	})

	it("a Deno global alone is not a runtime", () => {
		const g = { Deno: {}, navigator: { userAgent: "" } }
		expect(() => detectRuntime(g)).toThrow(/could not detect a runtime/)
	})
})
