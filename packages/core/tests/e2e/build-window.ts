/**
 * The order a build-gate cell's builds are timed in (bit 21 bref), as a pure helper run-build.ts drives with real
 * builds and e2e-build-window.test.ts with a fake clock.
 *
 * Each cell times its honey-free reference around its own app builds, ref, build, ref, build, ref, build, ref, and is
 * judged on the median of its builds over the median of those references: both sides of the ratio from the same
 * minutes of the same runner. A reference timed once per target at the job's start and reused for every cell of that
 * target redded unchanged code twice in 6 CI runs at 5f2942e: 40965667478's runner slowed ~14% after its reference was
 * taken (surface×cloudflare built in 7,446 ms against its usual ~6,500, ratio 31.87 over 30.6), and 40969532154's
 * reference read fast (148-163 ms, other runs 164-247), lifting every cell of its targets (mcp×bun 16.54 over 16.35).
 * The reference keeps one untimed warm-up per target, its first build in the job (a cold one is ~1.36x a warm one).
 * Each reference is timed as a pair, the bare one (no JS work) then the worked one, so one record set measures both
 * (bit 21 bref diagnostic: H1 and the ratio's noise for each); the cell is judged on the worked one.
 * The hang guard bounds the app builds only, not the references: a reference is honey-free, so it has no honey to hang.
 */
import { BUILD_SAMPLES } from "./build-gate.ts"

/** One timed build: its exit code, its wall time in ms and its output. */
export type Timed = { code: number; ms: number; output: string }

/**
 * A cell's samples: its app builds' ms, the honey-free reference builds' ms timed around them, and the bare
 * reference's (no JS work) timed beside each of those.
 */
export type CellWindow = { bare: number[]; builds: number[]; references: number[] }

/** Times one cell: its window, or the first app build that failed. */
export type CellMeter = (target: string, build: () => Promise<Timed>) => Promise<CellWindow | { failed: Timed }>

/** Times one honey-free reference build for a target, its ms (and throws if it fails). */
type Reference = (target: string) => Promise<number>

/**
 * A meter over `reference` and `bare` (bit 21 bref diagnostic: both candidates in one record set): each cell's
 * BUILD_SAMPLES app builds, each between two bare-then-worked reference pairs, R0 R15 B R0 R15 B R0 R15 B R0 R15.
 */
export function cellMeter(reference: Reference, bare: Reference): CellMeter {
	const warmed = new Set<string>()
	return async (target, build) => {
		if (!warmed.has(target)) {
			await bare(target)
			await reference(target)
			warmed.add(target)
		}
		const window: CellWindow = { bare: [], builds: [], references: [] }
		const pair = async () => {
			window.bare.push(await bare(target))
			window.references.push(await reference(target))
		}
		await pair()
		for (let sample = 0; sample < BUILD_SAMPLES; sample++) {
			const built = await build()
			if (built.code !== 0) return { failed: built }
			window.builds.push(built.ms)
			await pair()
		}
		return window
	}
}
