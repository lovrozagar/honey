/**
 * How CI re-records a bench ceiling (bit 20 e3, 00-rules' perf gate step 4): ci.yml's workflow_dispatch takes a
 * `bench_mode` input (judge or record, judge by default), and each of the five bench steps maps it to BENCH_MODE. A
 * push and a release's call always judge; a dispatch with bench_mode=record prints every RATIO line and never fails.
 */
import { describe, expect, it } from "vitest"
import { type Step, workflow } from "./fixture/workflows.ts"

const ci = workflow("ci.yml")
const BENCHES = ["hotpath", "finalize", "streaming", "websockets", "adapter"] as const
const MAPPED = "${{ inputs.bench_mode || 'judge' }}"

type Dispatch = { inputs?: Record<string, { default?: unknown; options?: unknown; type?: unknown }> }

describe("ci.yml's bench mode", () => {
	it("is a dispatch input, judge or record, judge by default", () => {
		const dispatch = (ci.on.workflow_dispatch ?? {}) as Dispatch
		expect(dispatch.inputs?.bench_mode).toEqual({
			default: "judge",
			description: expect.any(String),
			options: ["judge", "record"],
			type: "choice",
		})
	})

	it("reaches each of the five bench steps as BENCH_MODE, judge when nothing sets it", () => {
		const steps = (ci.jobs.hotpath?.steps ?? []) as readonly Step[]
		const mapping = BENCHES.map((name) => [name, steps.find((step) => step.name === name)?.env?.BENCH_MODE])
		expect(mapping).toEqual(BENCHES.map((name) => [name, MAPPED]))
	})
})
