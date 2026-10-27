/**
 * A miss leaks nothing through its timing: a 404 for a path that nearly names a route takes as long as one for a path
 * that names nothing. Measured in-process through app.fetch, never over a socket (loopback overhead would swamp a
 * per-path difference), on warm medians sampled round-robin, so machine load lands on every path alike.
 */
import { describe, expect, it } from "vitest"
import { honey } from "../../../src/routing/app.ts"

/* a near miss of the one route, a short and a long unrelated path, and one between */
const PATHS = ["/a", "/aaaaaaaaaa", "/secret-admin-pane", "/zzzzzzzzzzz"]
const WARM_ROUNDS = 50
const ROUNDS = 200

/** Each path's median `app.fetch` time in ms, after warm-up, the paths sampled in turn. */
async function medianMs(fetch: (req: Request) => Promise<Response> | Response): Promise<number[]> {
	for (let round = 0; round < WARM_ROUNDS; round++)
		for (const path of PATHS) await fetch(new Request(`http://localhost${path}`))
	const samples = PATHS.map((): number[] => [])
	for (let round = 0; round < ROUNDS; round++)
		for (const [i, path] of PATHS.entries()) {
			const start = performance.now()
			await fetch(new Request(`http://localhost${path}`))
			samples[i]?.push(performance.now() - start)
		}
	return samples.map((times) => times.sort((a, b) => a - b)[times.length >> 1] ?? 0)
}

describe("a miss's timing", () => {
	// v0: e76f7ba03c
	it("answers 404 for a near miss of a route in the time of any other path (within 4x on warm medians)", async () => {
		const app = honey()
			.get("/secret-admin-panel")
			.handler((c) => c.res.text("ok", "admin"))
		const statuses = await Promise.all(
			PATHS.map(async (path) => (await app.fetch(new Request(`http://localhost${path}`), {})).status),
		)
		const medians = await medianMs((req) => app.fetch(req, {}))
		/* warm medians sit within 1.5x; 4x leaves headroom yet reds a leak linear in path length (8x over these paths) */
		expect(statuses).toEqual([404, 404, 404, 404])
		expect(Math.max(...medians) / Math.max(Math.min(...medians), 0.0001)).toBeLessThan(4)
	})
})
