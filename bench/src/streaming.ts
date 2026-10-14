/**
 * Streaming gate (bit 05 budget: throughput + abort latency). The hotpath measures one buffered
 * answer; this measures bodies that stream, through app.fetch in process:
 *
 * - sse-1k: 1000 SSE events sent and read; generate-10k: 10 000 generated chunks read;
 *   stream-1mb: 1 MB written in 16 KB chunks and read;
 * - cancel-release: 200 live SSE streams, each read once and cancelled, timed until the producer
 *   sees its signal abort.
 *
 *     bun bench/src/streaming.ts
 *
 * Until the cutover (H21) v1 is gated against v0 in the same process, as finalize.ts does: per
 * scenario, interleaved samples of each; the gate fails (exit 1) when v1's median is more than
 * `STREAMING_THRESHOLD` (default 0.10) over v0's AND outside the band of its own samples. A
 * ratio, so no baseline file and no dependence on the machine.
 */
import { honey } from "@lovrozagar/honey"
import { honey as honeyV1 } from "../../packages/core/src/routing/app.ts"
import { judge, median } from "./significance.ts"

const SAMPLES = Number(process.env.STREAMING_SAMPLES ?? 15)
const THRESHOLD = Number(process.env.STREAMING_THRESHOLD ?? 0.1)
const RELEASES = 200
/* each throughput sample times this many reads, so one sample is long enough to measure */
const REPEAT = 10

type FetchApp = { fetch(request: Request, env: {}): Response | Promise<Response> }

/* the two versions share these route shapes; each is built with its own honey() */
type Ctx = {
	req: Request
	res: {
		generate(g: Generator<string>, o?: object): Response
		sse(cb: (s: SSEStream) => Promise<void>): Response
		stream(cb: (w: WritableStream) => Promise<void>): Response
	}
}
type SSEStream = { send(e: { data: string; event: string }): Promise<void>; signal: AbortSignal }
type Builder = { get(path: string): { handler(fn: (ctx: Ctx) => Response): unknown } }

const CHUNK = new Uint8Array(16 * 1024).fill(97)

/** Every scenario's route on one app; `released` settles each live stream's abort. */
function build(app: Builder, released: (() => void)[]): FetchApp {
	app.get("/sse").handler((ctx) =>
		ctx.res.sse(async (stream) => {
			for (let i = 0; i < 1000; i++) await stream.send({ data: "tick", event: "m" })
		}),
	)
	app.get("/generate").handler((ctx) =>
		ctx.res.generate(
			(function* () {
				for (let i = 0; i < 10_000; i++) yield "x"
			})(),
		),
	)
	app.get("/stream").handler((ctx) =>
		ctx.res.stream(async (writable) => {
			const writer = writable.getWriter()
			for (let i = 0; i < 64; i++) await writer.write(CHUNK)
			await writer.close()
		}),
	)
	app.get("/live").handler((ctx) =>
		ctx.res.sse(async (stream) => {
			/* listening first: the send below waits for a read that never comes once the reader cancels */
			const aborted = new Promise<void>((resolve) => stream.signal.addEventListener("abort", () => resolve()))
			stream.send({ data: "ready", event: "m" }).catch(() => {})
			await aborted
			released.shift()?.()
		}),
	)
	return app as unknown as FetchApp
}

const released = { v0: [] as (() => void)[], v1: [] as (() => void)[] }
const apps = {
	v0: build(honey() as unknown as Builder, released.v0),
	v1: build(honeyV1<{}>() as unknown as Builder, released.v1),
}

async function readAll(app: FetchApp, path: string): Promise<void> {
	await (await app.fetch(new Request(`http://bench${path}`), {})).arrayBuffer()
}

/** Microseconds for `RELEASES` live streams to be read once, cancelled, and seen aborted. */
async function cancelRelease(app: FetchApp, queue: (() => void)[]): Promise<number> {
	let total = 0
	for (let i = 0; i < RELEASES; i++) {
		const reader = ((await app.fetch(new Request("http://bench/live"), {})).body as ReadableStream).getReader()
		await reader.read()
		const seen = new Promise<void>((resolve) => queue.push(resolve))
		const start = performance.now()
		await reader.cancel()
		await seen
		total += performance.now() - start
	}
	return total * 1000
}

type Version = "v0" | "v1"

const SCENARIOS: ReadonlyArray<{ name: string; run(v: Version): Promise<number> }> = [
	...(["/sse", "/generate", "/stream"] as const).map((path) => ({
		name: { "/generate": "generate-10k", "/sse": "sse-1k", "/stream": "stream-1mb" }[path],
		run: async (v: Version) => {
			const start = performance.now()
			for (let r = 0; r < REPEAT; r++) await readAll(apps[v], path)
			return ((performance.now() - start) * 1000) / REPEAT
		},
	})),
	{ name: "cancel-release", run: (v: Version) => cancelRelease(apps[v], released[v]) },
]

/** Interleaved samples after one throwaway run of each, so both JITs have settled. */
async function measure(run: (v: Version) => Promise<number>) {
	await run("v0")
	await run("v1")
	const v0: number[] = []
	const v1: number[] = []
	const ratios: number[] = []
	for (let s = 0; s < SAMPLES; s++) {
		const a = await run("v0")
		const b = await run("v1")
		v0.push(a)
		v1.push(b)
		ratios.push(b / a)
	}
	return { ratios, v0: median(v0), v1: median(v1) }
}

const rows = []
for (const scenario of SCENARIOS) {
	const point = await measure(scenario.run)
	const verdict = judge(point.ratios, 1, THRESHOLD)
	rows.push({
		band: `±${verdict.halfWidth.toFixed(2)}`,
		scenario: scenario.name,
		status: verdict.status === "regressed" ? "REGRESSED" : verdict.status,
		v0_us: Number(point.v0.toFixed(1)),
		v1_over_v0: Number(verdict.ratio.toFixed(2)),
		v1_us: Number(point.v1.toFixed(1)),
	})
}
const version = typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`
console.log(
	`streaming v1 vs v0 on ${version}, median of ${SAMPLES} interleaved samples, threshold +${THRESHOLD * 100}%`,
)
console.table(rows)
if (rows.some((r) => r.status === "REGRESSED")) {
	console.error("streaming: v1 streams slower than v0 past the threshold.")
	process.exit(1)
}
