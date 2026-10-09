import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { NPM_README, ROOT_README, npmReadme } from "../../../scripts/sync-readme.ts"

describe("npm README", () => {
	// regression: S11 — the npm copy drifted from the root README (missing ctx.error, route(prefix, sub), honey/trust)
	it("is the root README with the npm link rewrites (run `bun run readme:sync`)", () => {
		const expected = npmReadme(readFileSync(ROOT_README, "utf-8"))
		expect(readFileSync(NPM_README, "utf-8")).toBe(expected)
	})
})
