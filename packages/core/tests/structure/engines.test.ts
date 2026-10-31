/**
 * The Node each published package declares (`engines.node`) is the oldest Node CI runs it on (bit 20 d). Core uses
 * `Promise.withResolvers` (producer-stream.ts), which Node 20 lacks, so a floor below CI's is a promise nothing tests.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ROOT, workflow } from "../build/fixture/workflows.ts"

type Versioned = {
	readonly steps?: readonly { readonly with?: Readonly<Record<string, unknown>> }[]
	readonly strategy?: { readonly matrix?: { readonly node?: readonly unknown[] } }
}

/** Every exact Node version ci.yml pins (x.y.z); "22" is the newest 22.x and "current" the newest release, so neither is a floor. */
function pinnedNodes(): number[][] {
	const jobs = Object.values(workflow("ci.yml").jobs) as readonly Versioned[]
	const named = jobs.flatMap((job) => [
		...(job.steps ?? []).map((step) => step.with?.["node-version"]),
		...(job.strategy?.matrix?.node ?? []),
	])
	return named
		.filter((value): value is string => typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value))
		.map((value) => value.split(".").map(Number))
}

/** The oldest of `versions`. */
function oldest(versions: readonly number[][]): string {
	const [first] = versions.toSorted(
		(a, b) => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0),
	)
	return (first ?? []).join(".")
}

describe("each published package's Node floor", () => {
	it("is the oldest Node CI runs, for honey and honey-clients alike", () => {
		const floor = `>=${oldest(pinnedNodes())}`
		const declared = ["packages/core", "packages/gen"].map(
			(dir) =>
				(JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) as { engines?: { node?: string } }).engines
					?.node,
		)
		expect([floor, declared]).toEqual([">=22.12.0", [floor, floor]])
	})
})
