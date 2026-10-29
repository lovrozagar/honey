/**
 * The Node ci.yml calls current: the newest RELEASE in nodejs.org's index, never a prerelease. setup-node's own
 * `current` takes the index's top entry, and on 2026-10-29 that was v27.0.0-alpha.0.0.0, published that day (CI
 * 40952484194 red on it). ci.yml's node-current job runs this once; every job not pinned to a Node takes its output.
 * A failed fetch or an index without a release fails the run: there is no fallback to setup-node's `current`.
 *
 *     bun packages/core/tests/build/node-current.ts   # prints vX.Y.Z; writes version=vX.Y.Z to $GITHUB_OUTPUT if set
 */
import { appendFileSync } from "node:fs"

export const INDEX = "https://nodejs.org/dist/index.json"

/* a release is vMAJOR.MINOR.PATCH and nothing more; a prerelease carries a -suffix (alpha, rc, nightly) */
const RELEASE = /^v(\d+)\.(\d+)\.(\d+)$/

/** The highest release among `index`'s versions; throws when it holds none. */
export function newestRelease(index: readonly { readonly version: string }[]): string {
	let best: { parts: number[]; version: string } | undefined
	for (const { version } of index) {
		const match = RELEASE.exec(version)
		if (match === null) continue
		const parts = match.slice(1).map(Number)
		if (best === undefined || compare(parts, best.parts) > 0) best = { parts, version }
	}
	if (best === undefined) throw new Error(`node-current: no release in ${INDEX}`)
	return best.version
}

function compare(a: readonly number[], b: readonly number[]): number {
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0)
	return 0
}

/** Fetches the index through `get` and answers its newest release. */
export async function resolveNodeCurrent(get: (url: string) => Promise<Response>): Promise<string> {
	const response = await get(INDEX)
	if (!response.ok) throw new Error(`node-current: ${INDEX} answered ${response.status}`)
	const index: unknown = await response.json()
	if (!isIndex(index)) throw new Error(`node-current: ${INDEX} is not a list of versions`)
	return newestRelease(index)
}

function isIndex(index: unknown): index is readonly { readonly version: string }[] {
	return (
		Array.isArray(index) &&
		index.every((entry: unknown) => typeof (entry as { version?: unknown } | null)?.version === "string")
	)
}

if (import.meta.main) {
	const version = await resolveNodeCurrent((url) => fetch(url, { signal: AbortSignal.timeout(30_000) }))
	process.stdout.write(`node-current: ${version}\n`)
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`)
}
