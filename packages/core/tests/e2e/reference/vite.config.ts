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
	ssr: { ...(worker ? { noExternal: true } : {}), target: worker ? "webworker" : "node" },
}
