/**
 * The conformance harness (bit 11): spawns core's reference app on bun and drives it over HTTP
 * alone. gen never imports core (H2): the app's path is a process argument. The child prints one
 * readiness line `{"url","alt"}` once both its listeners are up; it stops on SIGTERM or when its
 * stdin closes, so a killed vitest worker never orphans it. Opt-in: `vitest run --mode harness`.
 */
import { type ChildProcess, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { BUILT_INS } from "../../../src/emit/cli/commands.ts"
import { recordCell } from "./gate.ts"
import { type Cell, cellsFor, compareCell, type Observed, type Target, type WireHop } from "./matrix.ts"
/* the bound of a hook or leg that starts the reference app or compiles an SDK: the shared spawn scale */
export { SPAWN_TIMEOUT } from "../../../src/gen/__fixtures__/spawn-timeout.ts"

export type ReferenceApp = {
	/** same app, second listener: another origin */
	readonly alt: string
	/** GET {url}/v1/openapi.json at start */
	readonly document: Record<string, unknown>
	/** the wire cursor now: `wire(mark())` holds only the requests sent after it */
	mark(): Promise<number>
	stop(): Promise<void>
	/** primary origin */
	readonly url: string
	/** the requests the app received after cursor `since`, in arrival order */
	wire(since: number): Promise<readonly WireHop[]>
}

export type TargetRunner = {
	/** the cells this client has no method for by design (Python's SDK: the streams, G2); the target's file pins which */
	readonly lacks?: (cell: Cell) => boolean
	/** build the target's client from app.document once per file */
	prepare(app: ReferenceApp): Promise<void>
	/** the file's setup hook's timeout (the app's start and `prepare`), in ms; absent: the config's hookTimeout. A cold Rust compile runs past it (Fe3) */
	readonly prepareTimeoutMs?: number
	/** one Observed per call, in order */
	run(cell: Cell, app: ReferenceApp): Promise<readonly Observed[]>
	readonly target: Target
	/** a cell's `it` is titled `<key> (<title>)` when it has one: a v0 port, a case's live leg */
	readonly titles?: Readonly<Record<string, string>>
	/** a second runner of one target, titled `conformance × <target> (<variant>)` */
	readonly variant?: string
	/** how the file's app starts, when not as startReferenceApp() does: the mounted MCP endpoint's (bit 21 e) */
	readonly start?: () => Promise<ReferenceApp>
}

const APP = fileURLToPath(new URL("../../../../core/tests/integration/conformance/app.ts", import.meta.url))
/** where each cell's observation is recorded for the release's conformance gate (gate.ts); unset, nowhere */
const RECORD = process.env.HONEY_CONFORMANCE_RECORD
const READY_MS = 15_000
const KILL_MS = 5_000
/** stderr kept for a failure message */
const TAIL = 8_192

type Origins = { readonly alt: string; readonly url: string }

/** The child's readiness line; rejects on a non-JSON line, an early exit or after 15 s, with its stderr. */
function ready(child: ChildProcess, stderr: () => string): Promise<Origins> {
	return new Promise((resolve, reject) => {
		let out = ""
		const fail = (why: string) => {
			clearTimeout(timer)
			child.kill("SIGKILL")
			reject(new Error(`reference app ${why}; stderr:\n${stderr()}`))
		}
		const timer = setTimeout(() => fail(`printed no readiness line within ${READY_MS} ms`), READY_MS)
		const onData = (chunk: Buffer) => {
			out += chunk.toString()
			const newline = out.indexOf("\n")
			if (newline === -1) return
			child.stdout?.off("data", onData).resume()
			child.off("exit", onExit)
			clearTimeout(timer)
			try {
				const line = JSON.parse(out.slice(0, newline)) as Partial<Origins>
				if (typeof line.url !== "string" || typeof line.alt !== "string") throw new Error("no url and alt")
				resolve({ alt: line.alt, url: line.url })
			} catch {
				fail(`printed a readiness line that is not {"url","alt"}: ${JSON.stringify(out.slice(0, newline))}`)
			}
		}
		const onExit = (code: number | null, signal: string | null) => fail(`exited early (code ${code}, signal ${signal})`)
		child.stdout?.on("data", onData)
		child.once("exit", onExit)
		child.once("error", (e) => fail(`could not spawn: ${e.message}`))
	})
}

/** Stop the child: SIGTERM, then SIGKILL after 5 s; resolves once it exited. */
function stopper(child: ChildProcess, onExit: () => void): () => Promise<void> {
	return () => {
		process.off("exit", onExit)
		if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
		return new Promise((resolve) => {
			const timer = setTimeout(() => child.kill("SIGKILL"), KILL_MS)
			child.once("exit", () => {
				clearTimeout(timer)
				resolve()
			})
			child.kill("SIGTERM")
		})
	}
}

/** `url` fetched as JSON; a non-2xx answer throws with its body. */
async function json<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetch(url, init)
	if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} → ${res.status}: ${await res.text()}`)
	return (await res.json()) as T
}

/** Spawn the reference app, `env` beside this process's, wait for both listeners, and fetch its document. */
export async function startReferenceApp(env: Readonly<Record<string, string>> = {}): Promise<ReferenceApp> {
	const child = spawn("bun", [APP], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] })
	let err = ""
	child.stderr.on("data", (chunk: Buffer) => {
		err = (err + chunk.toString()).slice(-TAIL)
	})
	const kill = () => child.kill("SIGKILL")
	process.once("exit", kill)
	const stop = stopper(child, kill)
	try {
		const { alt, url } = await ready(child, () => err)
		const document = await json<Record<string, unknown>>(`${url}/v1/openapi.json`)
		return {
			alt,
			document,
			mark: async () => (await json<{ since: number }>(`${url}/v1/__conformance/mark`, { method: "POST" })).since,
			stop,
			url,
			wire: (since) => json<WireHop[]>(`${url}/v1/__conformance/wire?since=${since}`),
		}
	} catch (e) {
		await stop()
		throw e
	}
}

/** The CLI's local commands, and cobra's completion entry: a CLI-only call running one reaches no operation. */
const LOCAL_COMMANDS = [...BUILT_INS, "__complete"]

/**
 * The operationIds `cells` call that `document` does not name. An empty operation is a CLI local command's or an MCP-only
 * read of the server's tools alone: any other with one throws, so no API call hides from this check.
 */
export function unknownOperations(cells: readonly Cell[], document: Record<string, unknown>): string[] {
	const paths = (document.paths ?? {}) as Record<string, Record<string, { operationId?: unknown }>>
	const named = new Set(Object.values(paths).flatMap((item) => Object.values(item).map((op) => op?.operationId)))
	const reached = cells.flatMap((cell) =>
		cell.calls.filter((call) => {
			if (call.operation !== "") return true
			if (call.argv !== undefined && LOCAL_COMMANDS.includes(call.argv[0] ?? "")) return false
			/* an MCP-only read of the server's tools reaches no operation */
			if (call.mcp !== undefined && call.argv === undefined) return false
			throw new Error(`${cell.key}: an empty operation is a CLI local command's, not ${JSON.stringify(call.argv?.[0])}`)
		}),
	)
	return [...new Set(reached.map((call) => call.operation))].filter((op) => !named.has(op))
}

/**
 * One `it` per cell of `runner.target` against one app for the file: mark the wire, run the cell,
 * read the wire, compare. Nothing is skippable: a runner that cannot express a cell throws, and only
 * the cells it `lacks` by design are left out. Each cell's observation, and each cell lacked, is recorded for the
 * release's conformance gate. Returns the file's app, for a target's extra cases.
 */
export function targetSuite(runner: TargetRunner): () => ReferenceApp {
	const { target } = runner
	const all = cellsFor(target)
	const lacked = all.filter((cell) => runner.lacks?.(cell))
	const cells = all.filter((cell) => !lacked.includes(cell))
	const variant = runner.variant === undefined ? "" : ` (${runner.variant})`
	let app: ReferenceApp | undefined
	const current = (): ReferenceApp => {
		if (app === undefined) throw new Error("the reference app is not started: read it inside a test")
		return app
	}
	describe(`conformance × ${runner.target}${variant}`, () => {
		beforeAll(async () => {
			app = await (runner.start ?? startReferenceApp)()
			await runner.prepare(app)
			expect(unknownOperations(cells, app.document), "operations the grid calls but the document lacks").toEqual([])
			for (const { key } of lacked) recordCell(RECORD, { key, lacks: true, target })
		}, runner.prepareTimeoutMs)
		afterAll(() => app?.stop())
		for (const cell of cells) {
			const title = runner.titles?.[cell.key]
			it(title === undefined ? cell.key : `${cell.key} (${title})`, async () => {
				const live = current()
				const since = await live.mark()
				const observed = await runner.run(cell, live)
				const wire = await live.wire(since)
				recordCell(RECORD, { key: cell.key, observed, target, wire })
				expect(compareCell(cell, observed, wire)).toEqual([])
			})
		}
	})
	return current
}
