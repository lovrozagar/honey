/**
 * The generators as a consumer reaches them: `@lovrozagar/honey-clients`'s own entry, typed, with no cast and no
 * deep path. A consumer that writes the files itself (a flat layout, or a document patched in memory) needs this —
 * the bin always writes `<out>/<target>/` — and the leg is here so the names cannot quietly drop off the entry.
 */
import {
	generated,
	type GenerateRun,
	MANIFEST,
	type Options,
	type Target,
	writeGenerated,
	type Written,
	writeTarget,
} from "@lovrozagar/honey-clients"

const document: Record<string, unknown> = {
	info: { title: "Strict", version: "1.0.0" },
	openapi: "3.1.0",
	paths: { "/ping": { get: { responses: { "200": { description: "ok" } } } } },
}

const target: Target = "ts"
const options: Options = { name: "Strict", stem: "strict" }
const run: GenerateRun = { options: { ts: options }, targets: [target] }

export async function emit(): Promise<readonly string[]> {
	const files = await generated(run, document, { env: {}, report: () => undefined })
	return Object.keys(files.ts?.files ?? {})
}

export async function write(out: string): Promise<number> {
	return writeGenerated({ ...run, out }, document, { err: () => undefined, out: () => undefined }, {})
}

export async function place(dir: string): Promise<{ readonly manifest: string; readonly written: Written }> {
	const { ts } = await generated(run, document, { env: {}, report: () => undefined })
	return { manifest: MANIFEST, written: writeTarget(dir, ts?.files ?? {}, ts?.packages) }
}
