import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { SPAWN_TIMEOUT } from "../fixture/spawn-timeout.ts"

const REPO = resolve(import.meta.dirname, "../../../..")
const SELF = "packages/core/tests/structure/neutral-names.test.ts"

/* honey stays neutral (plan 39 8.9): no consumer's name in its packages or its docs. Tests and fixtures model an API
 * as Acme's, and the reserved example domains stand in for a real one. The changelog and the blueprint, which record
 * history, sit outside the two trees this guard reads; neither needs an exemption here. */
const NAMES = /anyrow|lifeonomous/i

/** Every file git tracks or would add under `packages/` and `docs/`, but this guard, which spells what it refuses. */
function scanned(): string[] {
	const out = execFileSync(
		"git",
		["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "packages", "docs"],
		{ cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	)
	return out.split("\0").filter((file) => file !== "" && file !== SELF)
}

/** Each place `file` names a consumer, as `<file>:<line>`, its path included. */
function named(file: string): string[] {
	if (NAMES.test(file)) return [file]
	const path = join(REPO, file)
	if (!existsSync(path)) return []
	const bytes = readFileSync(path)
	if (bytes.includes(0)) return []
	return bytes
		.toString("utf8")
		.split("\n")
		.flatMap((line, i) => (NAMES.test(line) ? [`${file}:${i + 1}`] : []))
}

describe("honey names no consumer (plan 39 8.9)", () => {
	it("no file under packages/ or docs/ names one, in its path or its text", { timeout: SPAWN_TIMEOUT }, () => {
		expect(scanned().flatMap(named)).toEqual([])
	})
})
