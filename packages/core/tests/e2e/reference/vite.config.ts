/**
 * The build gate's honey-free reference (bit 21 cfb): the same `vite build` an e2e app's prod build runs, on the same
 * runtime and for the same target, with no honey plugin in it. The options are createBuildPlugin's own per target
 * (src/build/targets.ts): an SSR build, minified, builtins external, webworker and everything inlined for cloudflare.
 * An app build's time over this one's is the ratio the gate judges, so the runner's speed cancels and a slower honey
 * generate, shared by every app, does not. Target set by run-build.ts.
 */
import { builtinModules } from "node:module"

const target = (process.env.HONEY_BUILD_TARGET ?? "node") as "bun" | "cloudflare" | "node"
const worker = target === "cloudflare"

/**
 * Units of honey-free, single-threaded JS work the reference does at buildStart (bit 21 bref), as an app build's
 * honey generate is JS work: a bare one-handler build is ~80 ms here, mostly process start, and its spread within a
 * cell's window was twice the app builds' (here 7.0% node, 6.3% bun, the median over 72 windows of three samples'
 * (max-min)/median, against the builds' 3.6% and 3.1%; on CI 5.6% and 3.8% against 2.0% and 2.2%). 15,000 is the
 * smallest size measured whose spread is no wider than the builds' on both runtimes, 2.1% node and 1.9% bun against
 * 3.3% and 3.2% (36 windows each); 10,000 still lost on bun (3.3% against 3.1%, 72 windows). It costs ~1.3 s node and
 * ~1.8 s bun a reference here, four a cell. Bundling work does not do it: 8,000 generated modules (~800 ms) spread
 * 7.5% node and 6.9% bun, as wide as none. e2e-build-window.test.ts holds the measurement.
 */
export const REFERENCE_WORK = 15_000

/** One unit: codegen-shaped work, records built, serialized to text, parsed back, sorted and printed as source. */
function work(units: number): number {
	let total = 0
	for (let unit = 0; unit < units; unit++) {
		const rows = Array.from({ length: 200 }, (_, at) => ({
			id: `op-${unit}-${at}`,
			path: `/r/${unit}/${at}/{id}`,
			tags: [`t${at % 7}`, `t${at % 11}`],
		}))
		const text = JSON.stringify(rows)
		const back = JSON.parse(text) as { id: string; path: string }[]
		back.sort((a, b) => (a.path < b.path ? 1 : -1))
		const source = back.map((row) => `export const ${row.id.replaceAll("-", "_")} = "${row.path}"`).join("\n")
		total += back.length + text.length + source.length
	}
	return total
}

export default {
	build: {
		emptyOutDir: true,
		minify: true,
		outDir: `dist/${target}`,
		rolldownOptions: {
			external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
			input: "entry.ts",
			output: { entryFileNames: "index.js" },
		},
		ssr: true,
	},
	logLevel: "error",
	plugins: [{ buildStart: () => void work(REFERENCE_WORK), name: "reference-work" }],
	ssr: { ...(worker ? { noExternal: true } : {}), target: worker ? "webworker" : "node" },
}
