/**
 * The TS SDK published to JSR (plan 39 8.3): its jsr.json and sources pass JSR's publish check as they are written,
 * slow types refused and the `.js` imports mapped to their `.ts` files. JSR's publish check is Deno's CLI, so this leg
 * runs where one is installed and is skipped elsewhere; it is the one file the H15 rule exempts for naming it.
 */
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import { SPAWN_TIMEOUT } from "../../gen/__fixtures__/spawn-timeout.ts"
import { written } from "../mcp/__fixtures__/written.ts"
import { tsFiles, withPeer } from "./__fixtures__/package-run.ts"

const CLI = "deno"
const installed = (): boolean => spawnSync(CLI, ["--version"]).status === 0

describe.skipIf(!installed())("the TS SDK published to JSR (plan 39 8.3)", { timeout: 4 * SPAWN_TIMEOUT }, () => {
	it("passes the publish dry run from its sources, slow types refused", async () => {
		/* npm specifiers resolve from node_modules beside a package.json, as a release installs them first */
		const dir = withPeer(written(await tsFiles()))
		const run = spawnSync(CLI, ["publish", "--dry-run", "--allow-dirty", "--config", "jsr.json"], {
			cwd: dir,
			encoding: "utf8",
			timeout: SPAWN_TIMEOUT,
		})
		expect([run.status, run.stderr.split("\n").filter((line) => /error|warning/i.test(line))]).toEqual([0, []])
	})
})
