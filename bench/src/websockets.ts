/**
 * WebSocket and realtime gate (bit 06 budget): honey's own per-connection and per-message work,
 * through app.fetch in process with a fake adapter, so no socket or kernel time is measured:
 *
 * - upgrade-1k: 1000 handshakes to a ws route behind one chain middleware, Origin checked;
 * - message-100k: 100 000 messages into one connection whose onMessage echoes (lane, containment, send);
 * - realtime-fanout: 100 joined connections, 1000 REST publishes, 100 000 frames out;
 * - realtime-inbound-10k: 10 000 JSON frames into one realtime connection (both lanes, parse, drain).
 *
 *     bun bench/src/websockets.ts   # judged against blueprint/baselines/bench.json
 *
 * Each scenario is a ratio to a raw twin doing the same socket work by hand on the same counting
 * sockets: an Origin-checked upgrade that opens one, an echo, one JSON frame per publish sent to
 * every joined socket, a JSON parse per inbound frame (gate.ts). Until bit 20 e it was gated
 * against v0.
 *
 * The two feeds reach steady state late (bit 21 k-pass): v1's per-frame cost kept falling for tens of
 * millions of frames, and the echo twin, ~2 ns a frame, moved between JIT states pass to pass, so k=1's
 * 15 samples of 10 000 frames sat inside a transient and k=3 read further into it (message-10k's pass
 * medians 3.43, 6.16, 7.92 in one process). Each now runs STEADY throwaway pairs before its first pass
 * (30 left them drifting, 300 held their pass medians within 0.07), and the echo times 100 000 frames
 * a sample, where its runs agreed (6.3-6.9 against 7.9-10.5 at 10 000 frames).
 */
import { createMiddleware } from "../../packages/core/src/middleware/middleware.ts"
import { realtime } from "../../packages/core/src/realtime/realtime.ts"
import { honey } from "../../packages/core/src/routing/app.ts"
import { WSContextImpl } from "../../packages/core/src/ws/contract.ts"
import { ws } from "../../packages/core/src/ws/route.ts"
import { gate } from "./gate.ts"

/* the ws lane closes a connection 1008 past 1024 waiting messages, in both versions */
const BATCH = 512
const MESSAGES = 10_000
/* frames per message-100k sample: the echo twin's ~2 ns a frame needs this many to time steadily */
const ECHOES = 100_000
/* throwaway v1 + raw pairs before a feed scenario's first pass, to reach steady state (the header says why) */
const STEADY = 300
const SUBSCRIBERS = 100
const PUBLISHES = 1000

type FetchApp = { fetch(request: Request, env: {}): Response | Promise<Response> }
type Socket = { readonly raw: unknown }
type Handler = {
	onClose?(ctx: unknown, ws: Socket, code: number, reason: string): unknown
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
			const wsContext = new Impl({ bufferedAmount: 0, close() {}, readyState: 1, send: () => sent.bump() } as never)
			conns.push({ handler, ws: wsContext })
			handler.onOpen?.(undefined, wsContext)
			const response = new Response(null)
			Object.defineProperty(response, "status", { value: 101 })
			return { response, socket: wsContext }
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
	wsAdapter(adapter: unknown): Builder
}
/** Registers a realtime route; what it returns publishes from a REST handler's ctx. */
type RealtimeRoute = (path: string, opts: object) => (ctx: unknown, topic: string, data: unknown) => void
/** Starts a ws route on a handle: `ws(app, path)`. */
type SocketRoute = (handle: Builder, path: string) => { handler(h: object): unknown }

/** One version's app: every scenario's routes, its counters, and its open connections. */
function build(
	app: Builder,
	Impl: new (raw: never) => Socket,
	chainMw: unknown,
	routes: { realtime: RealtimeRoute; socket: SocketRoute },
) {
	const route = routes.realtime
	const sent = counter()
	const handled = counter()
	const { adapter, conns } = fakeAdapter(Impl, sent)
	app.wsAdapter(adapter)
	routes
		.socket(app.use(chainMw), "/live")
		.handler({ onMessage: (_ctx: unknown, socket: { send(d: string): void }, data: string) => socket.send(data) })
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

const app = honey<{}>()
const v1 = build(
	app as unknown as Builder,
	WSContextImpl as never,
	createMiddleware((_ctx, next) => next()),
	{
		realtime: (path, opts) => {
			const publisher = realtime(app, path, opts as never)
			return (_ctx, topic, data) => publisher.publish(topic, data)
		},
		socket: (handle, path) => ws(handle as unknown as typeof app, path) as never,
	},
)

/** The same work by hand: an Origin-checked upgrade, an echo, a fanout of one frame, a parse per frame. */
function rawSide() {
	const sent = counter()
	const handled = counter()
	const conns: Conn[] = []
	const joined: { send(data: string): void }[] = []
	const open = (onMessage: Handler["onMessage"]) => {
		const socket = { raw: null, send: (_data: string) => sent.bump() }
		conns.push({ handler: { onMessage }, ws: socket })
		return socket
	}
	const answer = new Response(null)
	Object.defineProperty(answer, "status", { value: 101 })
	const fetch = (request: Request): Response => {
		const path = new URL(request.url).pathname
		if (path === "/pub") {
			const frame = JSON.stringify({ data: { n: 1 }, topic: "room" })
			for (const socket of joined) socket.send(frame)
			return Response.json({})
		}
		if (request.headers.get("upgrade") !== "websocket" || request.headers.get("origin") !== "http://bench") {
			return new Response(null, { status: 403 })
		}
		if (path === "/live") open((_ctx, socket, data) => (socket as unknown as { send(d: string): void }).send(data))
		if (path === "/rt") joined.push(open(undefined))
		if (path === "/in")
			open((_ctx, _socket, data) => {
				JSON.parse(data)
				handled.bump()
			})
		return answer
	}
	return { app: { fetch } as FetchApp, conns, handled, sent }
}

const raw = rawSide()
type Side = typeof v1

/** Open one connection on `path` and return it. */
async function connect(side: Side, path: string): Promise<Conn> {
	await side.app.fetch(handshake(path), {})
	await settle()
	return side.conns.at(-1) as Conn
}

/**
 * Closes a feed sample's connection and drops it from its side, outside the timed span: kept open, every earlier
 * sample's connection stayed live on the v1 side, whose cost then rose pass over pass (message-100k's v1 ~1700 us a
 * sample in pass 1, ~1900-2200 us by pass 3, with the raw twin flat).
 */
async function close(side: Side, conn: Conn): Promise<void> {
	await conn.handler.onClose?.(undefined, conn.ws, 1000, "sample done")
	side.conns.splice(side.conns.indexOf(conn), 1)
}

/*
 * Each feed scenario has its own loop, twice the same text on purpose: one shared loop's call site saw all four
 * handlers (two scenarios, two sides), and the echo twin's ~2 ns a frame then swung with whether the JIT inlined its
 * handler there, which the other scenario's passes kept changing (message-100k's raw 229-1177 us a sample, its pass
 * medians 3.58, 4.72, 10.47 in one run). Its own loop sees only its own two handlers, as it does run alone.
 */

/** Feed `ECHOES` frames to an echo connection in batches, each awaited through `done`. */
async function feedEchoes(conn: Conn, done: ReturnType<typeof counter>) {
	const start = done.value
	for (let sent = 0; sent < ECHOES; sent += BATCH) {
		const batch = Math.min(BATCH, ECHOES - sent)
		for (let i = 0; i < batch; i++) conn.handler.onMessage?.(undefined, conn.ws, "m")
		await done.reach(start + sent + batch)
	}
}

/** Feed `MESSAGES` JSON frames to an inbound connection in batches, each awaited through `done`. */
async function feedInbound(conn: Conn, done: ReturnType<typeof counter>) {
	const start = done.value
	for (let sent = 0; sent < MESSAGES; sent += BATCH) {
		const batch = Math.min(BATCH, MESSAGES - sent)
		for (let i = 0; i < batch; i++) conn.handler.onMessage?.(undefined, conn.ws, '{"n":1}')
		await done.reach(start + sent + batch)
	}
}

const subscribers = new Map<Side, number>()

const SCENARIOS: ReadonlyArray<{ name: string; run(side: Side): Promise<number>; warmup?: number }> = [
	{
		name: "upgrade-1k",
		run: async (side) => {
			const start = performance.now()
			for (let i = 0; i < 1000; i++) await side.app.fetch(handshake("/live"), {})
			const us = (performance.now() - start) * 1000
			side.conns.length = 0
			return us
		},
	},
	{
		name: "message-100k",
		run: async (side) => {
			const conn = await connect(side, "/live")
			const start = performance.now()
			await feedEchoes(conn, side.sent)
			const us = (performance.now() - start) * 1000
			await close(side, conn)
			return us
		},
		warmup: STEADY,
	},
	{
		name: "realtime-fanout",
		run: async (side) => {
			for (let n = subscribers.get(side) ?? 0; n < SUBSCRIBERS; n++) await connect(side, "/rt")
			subscribers.set(side, SUBSCRIBERS)
			const target = side.sent.value + SUBSCRIBERS * PUBLISHES
			const start = performance.now()
			for (let i = 0; i < PUBLISHES; i++) await side.app.fetch(new Request("http://bench/pub", { method: "POST" }), {})
			await side.sent.reach(target)
			return (performance.now() - start) * 1000
		},
	},
	{
		name: "realtime-inbound-10k",
		run: async (side) => {
			const conn = await connect(side, "/in")
			const start = performance.now()
			await feedInbound(conn, side.handled)
			const us = (performance.now() - start) * 1000
			await close(side, conn)
			return us
		},
		warmup: STEADY,
	},
]

await gate(
	"websockets",
	SCENARIOS.map(({ name, run, warmup }) => ({ name, raw: () => run(raw), v1: () => run(v1), warmup })),
	{
		samples: Number(process.env.WS_SAMPLES ?? 15),
	},
)
