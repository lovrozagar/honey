/**
 * Streaming gate (bit 05 budget: throughput + abort latency). The hotpath measures one buffered
 * answer; this measures bodies that stream, through app.fetch in process:
 *
 * - sse-1k: 1000 SSE events sent and read; generate-10k: 10 000 generated chunks read;
 *   stream-1mb: 1 MB written in 16 KB chunks and read;
 * - cancel-release: 200 live SSE streams, each read once and cancelled, timed until the producer
 *   sees its signal abort.
 *
 *     bun bench/src/streaming.ts   # judged against blueprint/baselines/bench.json
 *
 * Each scenario is a ratio to a raw twin: a hand-written fetch handler whose ReadableStream yields
 * the same bytes, one chunk per pull at high-water mark 0 as honey's producer does, read the same
 * way; its cancel resolves the release (gate.ts). Until bit 20 e it was gated against v0.
 */
import { honey } from "../../packages/core/src/routing/app.ts"
import { gate } from "./gate.ts"

const RELEASES = 200
/* each throughput sample times this many reads, so one sample is long enough to measure */
const REPEAT = 10
const CHUNK = new Uint8Array(16 * 1024).fill(97)
const encoder = new TextEncoder()

type FetchApp = { fetch(request: Request, env: {}): Response | Promise<Response> }

const released: (() => void)[] = []
const app = honey<{}>()
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

/** `count` chunks, one per pull; `onCancel` runs when the reader cancels. */
function pulled(count: number, next: () => Uint8Array, onCancel?: () => void): ReadableStream<Uint8Array> {
	let sent = 0
	return new ReadableStream<Uint8Array>(
		{
			cancel: () => onCancel?.(),
			pull: (controller) => {
				if (sent++ < count) controller.enqueue(next())
				else controller.close()
			},
		},
		{ highWaterMark: 0 },
	)
}

/** The same answers with no framework: each route's bytes from a bare ReadableStream. */
const raw: FetchApp = {
	fetch: (request) => {
		const path = new URL(request.url).pathname
		if (path === "/sse") {
			const body = pulled(1000, () => encoder.encode("event: m\ndata: tick\n\n"))
			return new Response(body, { headers: { "content-type": "text/event-stream" } })
		}
		if (path === "/generate") return new Response(pulled(10_000, () => encoder.encode("x")))
		if (path === "/stream") return new Response(pulled(64, () => CHUNK))
		const body = pulled(
			Number.POSITIVE_INFINITY,
			() => encoder.encode("event: m\ndata: ready\n\n"),
			() => {
				released.shift()?.()
			},
		)
		return new Response(body, { headers: { "content-type": "text/event-stream" } })
	},
}

const v1 = app as unknown as FetchApp

async function readAll(target: FetchApp, path: string): Promise<void> {
	await (await target.fetch(new Request(`http://bench${path}`), {})).arrayBuffer()
}

/** Microseconds for `REPEAT` full reads of `path`. */
async function throughput(target: FetchApp, path: string): Promise<number> {
	const start = performance.now()
	for (let r = 0; r < REPEAT; r++) await readAll(target, path)
	return (performance.now() - start) * 1000
}

/** Microseconds for `RELEASES` live streams to be read once, cancelled, and seen released. */
async function cancelRelease(target: FetchApp): Promise<number> {
	let total = 0
	for (let i = 0; i < RELEASES; i++) {
		const reader = ((await target.fetch(new Request("http://bench/live"), {})).body as ReadableStream).getReader()
		await reader.read()
		const seen = new Promise<void>((resolve) => released.push(resolve))
		const start = performance.now()
		await reader.cancel()
		await seen
		total += performance.now() - start
	}
	return total * 1000
}

const PATHS = { "generate-10k": "/generate", "sse-1k": "/sse", "stream-1mb": "/stream" } as const

await gate(
	"streaming",
	[
		...Object.entries(PATHS).map(([name, path]) => ({
			name,
			raw: () => throughput(raw, path),
			v1: () => throughput(v1, path),
		})),
		{ name: "cancel-release", raw: () => cancelRelease(raw), v1: () => cancelRelease(v1) },
	],
	{
		samples: Number(process.env.STREAMING_SAMPLES ?? 15),
	},
)
