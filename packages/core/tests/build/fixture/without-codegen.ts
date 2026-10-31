/**
 * Core's plugin where honey-clients cannot resolve (bit 19 h2, Q2): run as a script in a copy of core's source whose
 * project has only jiti and zod installed. It imports the plugin, which must load, then prints what each step did
 * as one JSON line: a plugin asked for nothing, a virtual OpenAPI module, and a generation, which needs honey-clients;
 * or, should the plugin not load, why.
 */
import { join } from "node:path"

const [core, dir] = process.argv.slice(2) as [string, string]
const step = async (run: () => Promise<unknown>) =>
	run().then(
		(value) => ({ ok: typeof value === "object" && value !== null ? Object.keys(value).sort() : (value ?? null) }),
		(error: Error) => ({ error: error.message }),
	)
type Plugin = Record<string, (...args: unknown[]) => Promise<unknown> | unknown>
const loaded = await import(join(core, "src", ["bui", "ld"].join(""), "plugin.ts")).then(
	(mod: { honey: (config: object) => [Plugin] }) => mod,
	(error: Error) => error,
)
if (loaded instanceof Error) {
	process.stdout.write(`${JSON.stringify({ load: loaded.message.split("\n")[0] })}\n`)
	process.exit(0)
}
const { honey } = loaded
const plugin = (config: object) => {
	const [made] = honey(config)
	made.configResolved?.({ root: dir })
	return made
}
const off = await step(async () => plugin({ app: "src/app.ts", codegen: { tree: false } }).buildStart?.())
const openApi = await step(async () =>
	plugin({ app: "src/app.ts", codegen: { openApi: { title: "T", version: "1" } } }).load?.("\0virtual:honey/openapi"),
)
const generation = await step(async () => plugin({ app: "src/app.ts" }).buildStart?.())
process.stdout.write(`${JSON.stringify({ generation, off, openApi })}\n`)
