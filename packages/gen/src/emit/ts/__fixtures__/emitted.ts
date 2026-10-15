/**
 * The emitted TS client, executed: the files an emitter writes land under
 * `$HOME/.cache/honey-tmp/gen-ts/<content hash>/` (never /tmp, 00-rules) and are imported from
 * there, so a behavior test drives exactly the text an SDK ships, `runtimeSource()` included: a
 * mutant of the runtime reaches every behavior test. Driven by an injected recording `fetch`.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { generateAppClient } from "../app-client.ts"
import { generateSdk, type SdkOptions } from "../sdk.ts"

/** Where emitted files land: under the toolchain cache, never /tmp. */
const root = () => join(process.env.HOME ?? homedir(), ".cache/honey-tmp/gen-ts")

/** Write `files` once per content and import `entry` from them. */
async function load(files: Readonly<Record<string, string>>, entry: string): Promise<Record<string, unknown>> {
	const ordered = Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	const hash = createHash("sha256").update(JSON.stringify(ordered)).digest("hex").slice(0, 20)
	const dir = join(root(), hash)
	if (!existsSync(join(dir, entry))) {
		mkdirSync(dir, { recursive: true })
		/* write each file beside its final name, then rename: a parallel worker never reads half a file */
		for (const [name, text] of ordered) {
			const partial = join(dir, `${name}.${process.pid}.partial`)
			writeFileSync(partial, text)
			renameSync(partial, join(dir, name))
		}
	}
	return (await import(join(dir, entry))) as Record<string, unknown>
}

/** The SDK `generateSdk` emits for `document`, imported from its index file. */
export async function emittedSdk(
	document: Record<string, unknown>,
	options: SdkOptions = { name: "TestSDK" },
): Promise<Record<string, unknown> & { files: Readonly<Record<string, string>> }> {
	const { files, stem } = generateSdk(document, options)
	return { ...(await load(files, `${stem}.index.gen.ts`)), files }
}

/** The app-typed client (`createClient`) as an app's `_gen/client.gen.ts` vendors it. */
export async function emittedApp(): Promise<Record<string, unknown> & { files: Readonly<Record<string, string>> }> {
	const { files } = generateAppClient()
	return { ...(await load(files, "client.gen.ts")), files }
}

/** A `fetch` that records each request and answers with `answer`. */
export function recordingFetch(answer: (request: Request) => Response | Promise<Response> = () => Response.json({})): {
	readonly calls: Request[]
	readonly fetch: typeof fetch
} {
	const calls: Request[] = []
	const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init)
		calls.push(request.clone())
		return answer(request)
	}) as typeof globalThis.fetch
	return { calls, fetch }
}
