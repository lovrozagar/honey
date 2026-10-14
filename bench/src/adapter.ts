/**
 * Adapter-overhead gate (bit 04 budget): what the node:http bridge adds per request, which the
 * in-process hotpath never sees. Each scenario is served three ways on loopback: a bare node:http
 * handler writing the same bytes (raw), v0's Node adapter, and v1's. A client pipelines a batch of
 * requests on one keep-alive connection, so the server's work dominates the time.
 *
 *     node --conditions=honey-source bench/src/adapter.ts
 *
 * Until the cutover (H21) v1's bridge is gated against v0's in the same process, as finalize.ts
 * does: the gate fails (exit 1) when v1's median per-request time is more than
 * `ADAPTER_THRESHOLD` (default 0.10) over v0's AND outside the band of its own samples. A ratio,
 * so no baseline file and no dependence on the machine. Overhead over raw is reported per scenario.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { connect, type AddressInfo } from "node:net"
import { honey } from "@lovrozagar/honey"
import { serve as serveV0 } from "@lovrozagar/honey/node"
import { serve as serveV1 } from "../../packages/core/src/adapters/node/serve.ts"
import { honey as honeyV1 } from "../../packages/core/src/routing/app.ts"
import { judge, median } from "./significance.ts"

const SAMPLES = Number(process.env.ADAPTER_SAMPLES ?? 15)
const BATCH = Number(process.env.ADAPTER_BATCH ?? 400)
const THRESHOLD = Number(process.env.ADAPTER_THRESHOLD ?? 0.1)

type FetchApp = { fetch(request: Request, env: {}): Response | Promise<Response> }

type Scenario = {
	/** the app both adapters serve, per version */
	apps: { v0: FetchApp; v1: FetchApp }
	name: string
	/** the bare node:http handler that writes the same answer */
	raw(req: IncomingMessage, res: ServerResponse): void
	/** one request, as the client pipelines it */
	request: string
}

const JSON_BODY = JSON.stringify({ id: "42", ok: true })
const JSON_HEADERS = { "content-length": String(Buffer.byteLength(JSON_BODY)), "content-type": "application/json" }

/** The same JSON from a native Response, for either adapter: the bridge alone, no framework. */
const nativeJson: FetchApp = { fetch: () => new Response(JSON_BODY, { headers: JSON_HEADERS }) }

/** A route answering ctx.res.json, so each adapter takes its HoneyResponse fast path. */
function routed(app: { get(path: string): { handler(fn: (ctx: never) => Response): unknown } }): FetchApp {
	app
		.get("/items/:id")
		.handler(((ctx: { params: { id: string }; res: { json(k: string, b: object): Response } }) =>
			ctx.res.json("ok", { id: ctx.params.id, ok: true })) as never)
	return app as unknown as FetchApp
}

/** Reads the body as text, then answers its length. */
const echoLength: FetchApp = {
	fetch: async (request) => {
		const body = String((await request.text()).length)
		return new Response(body, { headers: { "content-length": String(body.length) } })
	},
}

const POST_BODY = "x".repeat(1024)

const SCENARIOS: readonly Scenario[] = [
	{
		apps: { v0: nativeJson, v1: nativeJson },
		name: "native-json",
		raw: (_req, res) => {
			res.writeHead(200, JSON_HEADERS)
			res.end(JSON_BODY)
		},
		request: "GET /items/42 HTTP/1.1\r\nHost: bench\r\n\r\n",
	},
	{
		apps: { v0: routed(honey() as never), v1: routed(honeyV1<{}>() as never) },
		name: "routed-json",
		raw: (_req, res) => {
			res.writeHead(200, JSON_HEADERS)
			res.end(JSON_BODY)
		},
		request: "GET /items/42 HTTP/1.1\r\nHost: bench\r\n\r\n",
	},
	{
		apps: { v0: echoLength, v1: echoLength },
		name: "post-1kib",
		raw: (req, res) => {
			let length = 0
			req.on("data", (chunk: Buffer) => (length += chunk.byteLength))
			req.on("end", () => {
				const body = String(length)
				res.writeHead(200, { "content-length": String(body.length) })
				res.end(body)
			})
		},
		request: `POST /echo HTTP/1.1\r\nHost: bench\r\nContent-Length: ${POST_BODY.length}\r\n\r\n${POST_BODY}`,
	},
]

const STATUS_LINE = "HTTP/1.1 "

/** Nanoseconds per request: `count` requests pipelined on one connection, timed until the last answer. */
function batch(port: number, request: string, count: number): Promise<number> {
	return new Promise((resolve, reject) => {
		const socket = connect(port, "127.0.0.1")
		socket.setNoDelay(true)
		let answers = 0
		/* shorter than the status line, so no answer is counted twice across chunks */
		let tail = ""
		const start = performance.now()
		socket.on("error", reject)
		socket.on("data", (chunk: Buffer) => {
			const text = tail + chunk.toString("latin1")
			answers += text.split(STATUS_LINE).length - 1
			tail = text.slice(-(STATUS_LINE.length - 1))
			if (answers < count) return
			const ns = ((performance.now() - start) * 1e6) / count
			socket.destroy()
			resolve(ns)
		})
		socket.write(request.repeat(count))
	})
}

async function listening(server: Server): Promise<{ port: number; server: Server }> {
	await new Promise((resolve) => server.once("listening", resolve))
	return { port: (server.address() as AddressInfo).port, server }
}

/** The three servers of one scenario, bound. */
async function serversFor(scenario: Scenario) {
	const raw = createServer(scenario.raw).listen(0, "127.0.0.1")
	const v0 = serveV0(scenario.apps.v0 as never, { env: {}, hostname: "127.0.0.1", port: 0 })
	const v1 = serveV1(scenario.apps.v1, { env: {}, hostname: "127.0.0.1", port: 0 })
	/* subscribed at once: a server bound while another is awaited would already have said so */
	const [rawBound, v0Bound, v1Bound] = await Promise.all([listening(raw), listening(v0), listening(v1)])
	return { raw: rawBound, v0: v0Bound, v1: v1Bound }
}

type Point = { raw: number; ratios: number[]; v0: number; v1: number }

/** Interleaved samples after a throwaway batch on each server, so every JIT has settled. */
async function measure(scenario: Scenario): Promise<Point> {
	const servers = await serversFor(scenario)
	const order = [servers.raw, servers.v0, servers.v1] as const
	for (const { port } of order) await batch(port, scenario.request, BATCH)
	const times = { raw: [] as number[], v0: [] as number[], v1: [] as number[] }
	const ratios: number[] = []
	for (let s = 0; s < SAMPLES; s++) {
		const raw = await batch(servers.raw.port, scenario.request, BATCH)
		const v0 = await batch(servers.v0.port, scenario.request, BATCH)
		const v1 = await batch(servers.v1.port, scenario.request, BATCH)
		times.raw.push(raw)
		times.v0.push(v0)
		times.v1.push(v1)
		ratios.push(v1 / v0)
	}
	for (const { server } of order) server.closeAllConnections()
	await Promise.all(order.map(({ server }) => new Promise((resolve) => server.close(resolve))))
	return { raw: median(times.raw), ratios, v0: median(times.v0), v1: median(times.v1) }
}

const rows = []
for (const scenario of SCENARIOS) {
	const point = await measure(scenario)
	const verdict = judge(point.ratios, 1, THRESHOLD)
	rows.push({
		band: `±${verdict.halfWidth.toFixed(2)}`,
		raw_ns: Math.round(point.raw),
		scenario: scenario.name,
		status: verdict.status === "regressed" ? "REGRESSED" : verdict.status,
		v0_ns: Math.round(point.v0),
		v1_ns: Math.round(point.v1),
		v1_over_raw: Number((point.v1 / point.raw).toFixed(2)),
		v1_over_v0: Number(verdict.ratio.toFixed(2)),
	})
}
console.log(
	`adapter v1 vs v0 on node ${process.version}, median of ${SAMPLES} batches of ${BATCH} pipelined requests, threshold +${THRESHOLD * 100}%`,
)
console.table(rows)
if (rows.some((r) => r.status === "REGRESSED")) {
	console.error("adapter: v1's node bridge is slower than v0's past the threshold.")
	process.exit(1)
}
