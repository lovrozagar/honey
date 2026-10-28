import { createBuildPlugin } from "@lovrozagar/honey/build"
import { defaultClientConditions, defaultServerConditions } from "vite"
import base from "./vite.config.ts"

/** Deploy target, set by packages/core/tests/e2e/run-build.ts. Defaults to node for a bare `vite build`. */
const target = (process.env.HONEY_BUILD_TARGET ?? "node") as "bun" | "cloudflare" | "node"

/* the app's own config supplies honey() codegen — the build goes through the real path */
export default {
	...base,
	logLevel: "error",
	/* in this checkout core is read as source: honey-source, as every repo consumer resolves it (R3) */
	resolve: { conditions: ["honey-source", ...defaultClientConditions] },
	ssr: { resolve: { conditions: ["honey-source", ...defaultServerConditions] } },
	plugins: [
		...(base.plugins ?? []),
		createBuildPlugin(
			/* a Worker's own module (uploads-store.cloudflare.ts reads its bindings there), provided at run time */
			{
				external: target === "cloudflare" ? ["cloudflare:workers"] : [],
				minify: true,
				outDir: `dist/${target}`,
				target,
			},
			{ entry: `src/serve-entry.${target}.ts`, export: "app" },
		),
	],
}
