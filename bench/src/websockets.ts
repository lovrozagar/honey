/**
 * WebSocket and realtime gate (bit 06 budget): honey's own per-connection and per-message work,
 * through app.fetch in process with a fake adapter, so no socket or kernel time is measured:
 *
 * - upgrade-1k: 1000 handshakes to a ws route behind one chain middleware, Origin checked;
 * - message-10k: 10 000 messages into one connection whose onMessage echoes (lane, containment, send);
 * - realtime-fanout: 100 joined connections, 1000 REST publishes, 100 000 frames out;
 * - realtime-inbound-10k: 10 000 JSON frames into one realtime connection (both lanes, parse, drain).
 *
 *     bun bench/src/websockets.ts   # judged against blueprint/baselines/bench.json
 *
 * Each scenario is a ratio to a raw twin doing the same socket work by hand on the same counting
 * sockets: an Origin-checked upgrade that opens one, an echo, one JSON frame per publish sent to
 * every joined socket, a JSON parse per inbound frame (gate.ts). Until bit 20 e it was gated
 * against v0.
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
const SUBSCRIBERS = 100
const PUBLISHES = 1000

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

/** Feed `MESSAGES` frames to `conn` in batches, each awaited through `done`. */
async function feed(conn: Conn, frame: string, done: ReturnType<typeof counter>) {
	const start = done.value
	for (let sent = 0; sent < MESSAGES; sent += BATCH) {
		const batch = Math.min(BATCH, MESSAGES - sent)
		for (let i = 0; i < batch; i++) conn.handler.onMessage?.(undefined, conn.ws, frame)
		await done.reach(start + sent + batch)
	}
}

const subscribers = new Map<Side, number>()

const SCENARIOS: ReadonlyArray<{ name: string; run(side: Side): Promise<number> }> = [
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
		name: "message-10k",
		run: async (side) => {
			const conn = await connect(side, "/live")
			const start = performance.now()
			await feed(conn, "m", side.sent)
			return (performance.now() - start) * 1000
		},
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
			await feed(conn, '{"n":1}', side.handled)
			return (performance.now() - start) * 1000
		},
	},
]

await gate(
	"websockets",
	SCENARIOS.map(({ name, run }) => ({ name, raw: () => run(raw), v1: () => run(v1) })),
	{
		samples: Number(process.env.WS_SAMPLES ?? 15),
	},
)
