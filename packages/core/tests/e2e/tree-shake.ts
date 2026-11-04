/**
 * The tree-shake gate (plan 39 6.1.1), over the tarball installed in the packaging tier's consumer. Each subpath
 * imported and nothing used bundles to 0 B three ways: under esbuild (the version wrangler pins) and rolldown (vite's
 * bundler) as a consumer runs them, with the package's `sideEffects: false`, and under rolldown with every module of
 * the package held to have side effects, so only a top-level statement that has one is kept. The third is the one a
 * side effect landing at a module's top level reds, naming the subpath and the code that stayed. esbuild cannot run
 * that third way: it keeps every `Object.freeze()` or `new Set()` at a module's top level, effects or not.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { builtinModules, createRequire } from "node:module"
import { join } from "node:path"

/** What the dist imports and a consumer provides itself: runtimes, optional peers, the clients package. */
const PROVIDED = ["bun", "ws", "vite", "jiti", "typescript", "@lovrozagar/honey-clients"]
const provided = (id: string) =>
	id.startsWith("node:") ||
	id.startsWith("cloudflare:") ||
	builtinModules.includes(id) ||
	PROVIDED.some((name) => id === name || id.startsWith(`${name}/`))

type Esbuild = typeof import("esbuild")
type Rolldown = typeof import("rolldown")

/** The bundlers as the consumer installed them: esbuild its own, rolldown vite's. */
function bundlers(consumer: string): { esbuild: Esbuild; rolldown: Rolldown } {
	const require = createRequire(join(consumer, "package.json"))
	const fromVite = createRequire(require.resolve("vite/package.json"))
	return { esbuild: require("esbuild") as Esbuild, rolldown: fromVite("rolldown") as Rolldown }
}

/** Every subpath of the package installed in `consumer`, as a consumer imports it. */
function subpaths(consumer: string): string[] {
	const manifest = JSON.parse(readFileSync(join(consumer, "node_modules/@lovrozagar/honey/package.json"), "utf8")) as {
		exports: Record<string, { default?: string } | string>
	}
	return Object.entries(manifest.exports)
		.filter(([, target]) => typeof target === "object" && target.default !== undefined)
		.map(([subpath]) => (subpath === "." ? "@lovrozagar/honey" : `@lovrozagar/honey/${subpath.slice(2)}`))
}

/**
 * Every shake failure of the honey installed in `consumer`, one line each naming the subpath, the bundler and what it
 * kept; [] when every subpath, imported and unused, bundles to nothing.
 */
export async function treeShake(consumer: string): Promise<string[]> {
	const { esbuild, rolldown } = bundlers(consumer)
	const entries = join(consumer, "shake")
	mkdirSync(entries, { recursive: true })
	/** The minified bundle of `entry` under rolldown; `effects` holds every package module to have side effects. */
	const viaRolldown = async (entry: string, effects: boolean): Promise<string> => {
		const bundle = await rolldown.rolldown({
			cwd: consumer,
			external: provided,
			input: entry,
			logLevel: "silent",
			...(effects ? { treeshake: { moduleSideEffects: (_id: string, external: boolean) => !external } } : {}),
		})
		const { output } = await bundle.generate({ format: "esm", minify: true })
		await bundle.close()
		return output.map((chunk) => ("code" in chunk ? chunk.code : "")).join("")
	}
	const failures: string[] = []
	for (const [index, specifier] of subpaths(consumer).entries()) {
		const entry = join(entries, `e${index}.mjs`)
		writeFileSync(entry, `import ${JSON.stringify(specifier)}\n`)
		const built = await esbuild.build({
			absWorkingDir: consumer,
			bundle: true,
			entryPoints: [entry],
			external: ["node:*", "cloudflare:*", ...builtinModules, ...PROVIDED.flatMap((name) => [name, `${name}/*`])],
			format: "esm",
			logLevel: "silent",
			minify: true,
			platform: "neutral",
			write: false,
		})
		const kept = {
			esbuild: built.outputFiles[0]?.text ?? "",
			rolldown: await viaRolldown(entry, false),
			"rolldown, every module with side effects": await viaRolldown(entry, true),
		}
		for (const [how, code] of Object.entries(kept))
			if (code.length > 0) failures.push(`${specifier} under ${how}: ${code.length} B, ${code.slice(0, 160)}`)
	}
	return failures
}
