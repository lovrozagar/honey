/**
 * How CI records the e2e build gate's ceilings (bit 21 cfb, tests/e2e/build-gate.ts): ci.yml's workflow_dispatch takes
 * a `build_mode` input (judge or record, judge by default), its own and not bench_mode's, so recording one gate never
 * silences the other's judging. It reaches every step that builds an e2e app through run-build.ts: the build job's
 * and the e2e job's (a prod cell builds its app first). A push and a release's call always judge.
 */
import { describe, expect, it } from "vitest"
import { runtimeKey } from "../e2e/build-gate.ts"
import { type Step, workflow } from "./fixture/workflows.ts"

const ci = workflow("ci.yml")
const MAPPED = "${{ inputs.build_mode || 'judge' }}"

type Dispatch = { inputs?: Record<string, { default?: unknown; options?: unknown; type?: unknown }> }

const stepOf = (job: string, run: string) =>
	((ci.jobs[job]?.steps ?? []) as readonly Step[]).find((step) => step.run?.startsWith(run))

describe("ci.yml's build mode", () => {
	it("is a dispatch input of its own, judge or record, judge by default", () => {
		const dispatch = (ci.on.workflow_dispatch ?? {}) as Dispatch
		expect(dispatch.inputs?.build_mode).toEqual({
			default: "judge",
			description: expect.any(String),
			options: ["judge", "record"],
			type: "choice",
		})
	})

	it("reaches the build job's run-build.ts step and the e2e job's script step as BUILD_MODE", () => {
		expect([
			stepOf("build", "bun packages/core/tests/e2e/run-build.ts")?.env?.BUILD_MODE,
			stepOf("e2e", "bun run ${{ matrix.script }}")?.env?.BUILD_MODE,
		]).toEqual([MAPPED, MAPPED])
	})

	it("pins the Bun its build ceilings are kept under: a BUN_VERSION bump to a new minor needs a re-record", () => {
		const pinned = (ci as unknown as { env: { BUN_VERSION: string } }).env.BUN_VERSION
		expect(runtimeKey("bun", pinned)).toBe("bun 1.3")
	})
})
