import { createBuildPlugin } from "@lovrozagar/honey/build"
import base from "./vite.config.ts"

/** Deploy target, set by e2e/run-build.ts. Defaults to node for a bare `vite build`. */
const target = (process.env.HONEY_BUILD_TARGET ?? "node") as "bun" | "cloudflare" | "deno" | "node"

/* the app's own config supplies honey() codegen — the build goes through the real path */
export default {
	...base,
	logLevel: "error",
	plugins: [
		...(base.plugins ?? []),
		createBuildPlugin({ minify: true, outDir: `dist/${target}`, target }, { entry: "src/gen-app.ts", export: "app" }),
	],
}
