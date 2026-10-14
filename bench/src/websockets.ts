/**
 * WebSocket and realtime gate (bit 06 budget): honey's own per-connection and per-message work,
 * through app.fetch in process with a fake adapter, so no socket or kernel time is measured:
 *
 * - upgrade-1k: 1000 handshakes to a ws route behind one chain middleware, Origin checked;
 * - message-10k: 10 000 messages into one connection whose onMessage echoes (lane, containment, send);
 * - realtime-fanout: 100 joined connections, 1000 REST publishes, 100 000 frames out;
 * - realtime-inbound-10k: 10 000 JSON frames into one realtime connection (both lanes, parse, drain).
 *
 *     bun bench/src/websockets.ts
 *
 * Until the cutover (H21) v1 is gated against v0 in the same process, as streaming.ts does: per
 * scenario, interleaved samples of each; the gate fails (exit 1) when v1's median is more than
 * `WS_THRESHOLD` (default 0.10) over v0's AND outside the band of its own samples. Each version
 * runs on its own WSContextImpl, so a send costs what that version's send costs.
 */
import { createMiddleware, honey } from "@lovrozagar/honey"
import "@lovrozagar/honey/realtime"
import { WSContextImpl } from "@lovrozagar/honey/ws/cloudflare"
import { createMiddleware as createMiddlewareV1 } from "../../packages/core/src/middleware/middleware.ts"
import { realtime } from "../../packages/core/src/realtime/realtime.ts"
import { honey as honeyV1 } from "../../packages/core/src/routing/app.ts"
import { WSContextImpl as WSContextImplV1 } from "../../packages/core/src/ws/contract.ts"
import { judge, median } from "./significance.ts"

const SAMPLES = Number(process.env.WS_SAMPLES ?? 15)
const THRESHOLD = Number(process.env.WS_THRESHOLD ?? 0.1)
/* the ws lane closes a connection 1008 past 1024 waiting messages, in both versions */
const BATCH = 512
const MESSAGES = 10_000
const SUBSCRIBERS = 100
const PUBLISHES = 1000

type Version = "v0" | "v1"
type FetchApp = { fetch(request: Request, env: {}): Response | Promise<Response> }
type Socket = { readonly raw: unknown }
type Handler = {
	onMessage?(ctx: unknown, ws: Socket, data: string): unknown
	onOpen?(ctx: unknown, ws: Socket): unknown
}
type Conn = { handler: Handler; ws: Socket }

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function noop(): void {}

/** Counts every send; `reach(n)` settles once n were sent. */
function counter() {
	let count = 0
	let wanted = Number.POSITIVE_INFINITY
	let arrived = noop
	return {
		bump() {
			if (++count >= wanted) arrived()
		},
		reach(n: number) {
			wanted = n
			return count >= n ? Promise.resolve() : new Promise<void>((resolve) => (arrived = resolve))
		},
		get value() {
			return count
		},
	}
}

/** An adapter that opens each upgrade at once over a socket that counts what it sends. */
function fakeAdapter(Impl: new (raw: never) => Socket, sent: ReturnType<typeof counter>) {
	const conns: Conn[] = []
	const adapter = {
		upgrade(_req: Request, _env: unknown, handler: Handler) {
			const ws = new Impl({ bufferedAmount: 0, close() {}, readyState: 1, send: () => sent.bump() } as never)
			conns.push({ handler, ws })
			handler.onOpen?.(undefined, ws)
			const response = new Response(null)
			Object.defineProperty(response, "status", { value: 101 })
			return { response, socket: ws }
		},
	}
	return { adapter, conns }
}

const handshake = (path: string) =>
	new Request(`http://bench${path}`, {
		headers: { connection: "Upgrade", cookie: "sid=1", origin: "http://bench", upgrade: "websocket" },
	})

type Builder = {
	post(path: string): { handler(fn: (ctx: { res: { json(s: string, b: object): Response } }) => Response): unknown }
	use(mw: unknown): Builder
	ws(path: string): { handler(h: object): unknown }
	wsAdapter(adapter: unknown): Builder
}
/** Registers a realtime route; what it returns publishes from a REST handler's ctx. */
type RealtimeRoute = (path: string, opts: object) => (ctx: unknown, topic: string, data: unknown) => void

/** One version's app: every scenario's routes, its counters, and its open connections. */
function build(app: Builder, Impl: new (raw: never) => Socket, chainMw: unknown, route: RealtimeRoute) {
	const sent = counter()
	const handled = counter()
	const { adapter, conns } = fakeAdapter(Impl, sent)
	app.wsAdapter(adapter)
	app
		.use(chainMw)
		.ws("/live")
		.handler({ onMessage: (_ctx: unknown, ws: { send(d: string): void }, data: string) => ws.send(data) })
	const publish = route("/rt", { handler: (_ctx: unknown, conn: { join(t: string): void }) => conn.join("room") })
	app.post("/pub").handler((ctx) => {
		publish(ctx, "room", { n: 1 })
		return ctx.res.json("ok", {})
	})
	route("/in", {
		handler: (_ctx: unknown, conn: { on(e: string, fn: () => Promise<void>): void }) =>
			conn.on("message", async () => handled.bump()),
		limits: { maxPendingFrames: MESSAGES * 2 },
	})
	return { app: app as unknown as FetchApp, conns, handled, sent }
}

const v0App = honey()
const v1App = honeyV1<{}>()
const passV0 = createMiddleware((_ctx, next) => next())
const passV1 = createMiddlewareV1((_ctx, next) => next())
const apps = {
	v0: build(v0App as unknown as Builder, WSContextImpl as never, passV0, (path, opts) => {
		;(v0App as unknown as { realtime(p: string, o: object): unknown }).realtime(path, opts)
		/* v0 needs the namespace named once an app has several realtime routes */
		type Realtime = { namespace(name: string): { publish(t: string, d: unknown): void } }
		return (ctx, topic, data) => (ctx as { realtime: Realtime }).realtime.namespace(path).publish(topic, data)
	}),
	v1: build(v1App as unknown as Builder, WSContextImplV1 as never, passV1, (path, opts) => {
		const publisher = realtime(v1App, path, opts as never)
		return (_ctx, topic, data) => publisher.publish(topic, data)
	}),
}

/** Open one connection on `path` and return it. */
async function connect(v: Version, path: string): Promise<Conn> {
	await apps[v].app.fetch(handshake(path), {})
	await settle()
	return apps[v].conns.at(-1) as Conn
}

/** Feed `MESSAGES` frames to `conn` in batches, each awaited through `done`. */
async function feed(conn: Conn, frame: string, done: ReturnType<typeof counter>) {
	const start = done.value
	for (let sent = 0; sent < MESSAGES; sent += BATCH) {
		const batch = Math.min(BATCH, MESSAGES - sent)
		for (let i = 0; i < batch; i++) conn.handler.onMessage?.(undefined, conn.ws, frame)
		await done.reach(start + sent + batch)
	}
}

const subscribers = { v0: 0, v1: 0 }

const SCENARIOS: ReadonlyArray<{ name: string; run(v: Version): Promise<number> }> = [
	{
		name: "upgrade-1k",
		run: async (v) => {
			const start = performance.now()
			for (let i = 0; i < 1000; i++) await apps[v].app.fetch(handshake("/live"), {})
			const us = (performance.now() - start) * 1000
			apps[v].conns.length = 0
			return us
		},
	},
	{
		name: "message-10k",
		run: async (v) => {
			const conn = await connect(v, "/live")
			const start = performance.now()
			await feed(conn, "m", apps[v].sent)
			return (performance.now() - start) * 1000
		},
	},
	{
		name: "realtime-fanout",
		run: async (v) => {
			for (; subscribers[v] < SUBSCRIBERS; subscribers[v]++) await connect(v, "/rt")
			const target = apps[v].sent.value + SUBSCRIBERS * PUBLISHES
			const start = performance.now()
			for (let i = 0; i < PUBLISHES; i++)
				await apps[v].app.fetch(new Request("http://bench/pub", { method: "POST" }), {})
			await apps[v].sent.reach(target)
			return (performance.now() - start) * 1000
		},
	},
	{
		name: "realtime-inbound-10k",
		run: async (v) => {
			const conn = await connect(v, "/in")
			const start = performance.now()
			await feed(conn, '{"n":1}', apps[v].handled)
			return (performance.now() - start) * 1000
		},
	},
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
	`websockets v1 vs v0 on ${version}, median of ${SAMPLES} interleaved samples, threshold +${THRESHOLD * 100}%`,
)
console.table(rows)
if (rows.some((r) => r.status === "REGRESSED")) {
	console.error("websockets: v1 is slower than v0 past the threshold.")
	process.exit(1)
}
