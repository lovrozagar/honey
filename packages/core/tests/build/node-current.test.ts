/**
 * CI's `current` Node (node-current.ts): the newest release in nodejs.org's index, never a prerelease, resolved once
 * by ci.yml's node-current job and fed to every job that ran setup-node's own `current` (CI 40952484194 got
 * v27.0.0-alpha.0.0.0, the index's top entry the day it was published).
 */
import { describe, expect, it } from "vitest"
import { type Step, workflow } from "./fixture/workflows.ts"
import { INDEX, newestRelease, resolveNodeCurrent } from "./node-current.ts"

const ci = workflow("ci.yml")
const FED = "${{ needs.node-current.outputs.node }}"
/* a matrix job's node: its "current" (or none, a runtime that only needs some Node) is node-current's */
const MAPPED = "${{ (matrix.node || 'current') == 'current' && needs.node-current.outputs.node || matrix.node }}"

/* nodejs.org's index top on 2026-10-29, as the run that went red read it */
const TODAY = [
	{ version: "v27.0.0-alpha.0.0.0" },
	{ version: "v26.13.0" },
	{ version: "v26.12.1" },
	{ version: "v24.11.0" },
	{ version: "v22.21.1" },
]

const answering = (status: number, body: unknown) => async (url: string) => {
	expect(url).toBe(INDEX)
	return new Response(JSON.stringify(body), { status })
}

describe("the newest release in nodejs.org's index", () => {
	it("skips a prerelease at the top", () => {
		expect(newestRelease(TODAY)).toBe("v26.13.0")
	})

	it("skips every prerelease ahead of the first release, whatever its kind", () => {
		const index = [
			{ version: "v28.0.0-nightly20261101abcdef" },
			{ version: "v27.0.0-rc.1" },
			{ version: "v27.0.0-alpha.0.0.0" },
			...TODAY.slice(1),
		]
		expect(newestRelease(index)).toBe("v26.13.0")
	})

	it("takes the highest release, not the first listed", () => {
		expect(newestRelease([{ version: "v22.21.2" }, ...TODAY])).toBe("v26.13.0")
	})

	it("throws on an index with no release in it", () => {
		expect(() => newestRelease([{ version: "v27.0.0-alpha.0.0.0" }])).toThrow(/no release/)
	})
})

describe("resolving it", () => {
	it("reads the index and answers its newest release", async () => {
		expect(await resolveNodeCurrent(answering(200, TODAY))).toBe("v26.13.0")
	})

	it("fails loudly on a failed fetch, never falling back to setup-node's current", async () => {
		await expect(resolveNodeCurrent(answering(503, "unavailable"))).rejects.toThrow(/503/)
	})

	it("fails loudly on an index that is not a list of versions", async () => {
		await expect(resolveNodeCurrent(answering(200, { versions: [] }))).rejects.toThrow(/not a list/)
	})
})

const needs = (job: string) => [ci.jobs[job]?.needs ?? []].flat()

describe("ci.yml's current Node", () => {
	const nodeSteps = Object.entries(ci.jobs).flatMap(([job, { steps = [] }]) =>
		(steps as readonly Step[])
			.filter((step) => step.uses?.startsWith("actions/setup-node@") === true)
			.map((step) => ({ job, version: String(step.with?.["node-version"]) })),
	)

	it("pins a Node by number or takes node-current's, never setup-node's own current", () => {
		expect(nodeSteps.filter(({ version }) => !/^\d/.test(version) && version !== FED && version !== MAPPED)).toEqual([])
	})

	it("needs node-current in every job it feeds", () => {
		const fed = nodeSteps.filter(({ version }) => version === FED || version === MAPPED)
		expect(fed.filter(({ job }) => !needs(job).includes("node-current"))).toEqual([])
		expect(fed.length).toBeGreaterThan(0)
	})

	it("maps a matrix's current, or no node at all, to node-current's, and a pinned one to itself", () => {
		const mapped = nodeSteps.filter(({ version }) => version === MAPPED).map(({ job }) => job)
		const nodes = mapped.flatMap((job) => {
			const matrix = (ci.jobs[job] as { strategy?: { matrix?: Record<string, unknown> } }).strategy?.matrix ?? {}
			const listed = (matrix.node ?? []) as readonly string[]
			const included = ((matrix.include ?? []) as readonly { node?: string }[]).map(({ node }) => node)
			return [...listed, ...included]
		})
		expect(nodes.filter((node) => node !== undefined && node !== "current" && !/^\d/.test(node))).toEqual([])
		expect(mapped.length).toBeGreaterThan(0)
	})

	it("resolves it once, through node-current.ts, writing the version to the job's output", () => {
		const job = ci.jobs["node-current"] as { outputs?: Record<string, string>; steps?: readonly Step[] } | undefined
		expect(job?.outputs?.node).toBe("${{ steps.resolve.outputs.version }}")
		const resolve = job?.steps?.find((step) => (step as { id?: string }).id === "resolve")
		expect(resolve?.run).toContain("packages/core/tests/build/node-current.ts")
	})
})
