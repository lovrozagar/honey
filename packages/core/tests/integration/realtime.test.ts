/**
 * Realtime end to end on a real node:http server: fan-out, namespaces and a slow consumer through
 * realtime(), and resume through the reference server (H8), on the two public hooks alone, SSE
 * `Last-Event-ID` and the WebSocket `reconnect_token`.
 */
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { WebSocket as WsClient } from "ws"
import { type HoneyServer, serve } from "../../src/adapters/node/serve.ts"
import { createBus } from "../../src/realtime/bus.ts"
import { realtime } from "../../src/realtime/realtime.ts"
import type { ConnContext } from "../../src/realtime/route.ts"
import { type Honey, honey } from "../../src/routing/app.ts"
import { createReferenceServer } from "./conformance/reference-server.ts"

const servers: HoneyServer[] = []

const quiet = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.shutdown(0)))
})

/** The reference server on a free loopback port, with `count` events already logged. */
async function reference(count: number) {
	const ref = createReferenceServer()
	for (let n = 1; n <= count; n++) ref.append({ n })
	const server = serve(ref.app, { env: {}, hostname: "127.0.0.1", port: 0 })
	servers.push(server)
	await new Promise((resolve) => server.once("listening", resolve))
	const { port } = server.address() as AddressInfo
	return { ...ref, base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}` }
}

/** The first `count` frames a WebSocket client receives, parsed; the client then closes. */
function frames(url: string, count: number, onOpen?: () => void): Promise<unknown[]> {
	return new Promise((resolve, reject) => {
		const client = new WsClient(url)
		const got: unknown[] = []
		client.on("open", () => onOpen?.())
		client.on("message", (data) => {
			got.push(JSON.parse(String(data)))
			if (got.length === count) {
				client.close()
				resolve(got)
			}
		})
		client.on("error", reject)
	})
}

/** The first `count` SSE events a client receives as `[id, data]`; the client then leaves. */
async function sseEvents(url: string, count: number, headers: Record<string, string> = {}, onOpen?: () => void) {
	const abort = new AbortController()
	const res = await fetch(url, { headers, signal: abort.signal })
	onOpen?.()
	const reader = (res.body as ReadableStream<Uint8Array>).getReader()
	const decoder = new TextDecoder()
	const events: [string, unknown][] = []
	let text = ""
	while (events.length < count) {
		const { value } = await reader.read()
		text += decoder.decode(value, { stream: true })
		const blocks = text.split("\n\n")
		text = blocks.pop() as string
		for (const block of blocks) {
			const fields = Object.fromEntries(block.split("\n").map((line) => line.split(": ", 2) as [string, string]))
			if (fields.id !== undefined) events.push([fields.id, JSON.parse(fields.data as string)])
		}
	}
	abort.abort()
	return [res.headers.get("content-type"), events.slice(0, count)] as const
}

/** `app` served on a free loopback port; the ws:// base. */
async function listen(app: Honey<{}>) {
	const server = serve(app, { env: {}, hostname: "127.0.0.1", port: 0 })
	servers.push(server)
	await new Promise((resolve) => server.once("listening", resolve))
	return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** A client on `url`, open, with every frame it receives parsed into `got`. */
async function socketTo(url: string) {
	const ws = new WsClient(url)
	const got: unknown[] = []
	ws.on("message", (data) => void got.push(JSON.parse(String(data))))
	await new Promise((resolve, reject) => {
		ws.once("open", resolve)
		ws.once("error", reject)
	})
	return { got, ws }
}

/** Join `events`, and echo each frame to it. */
const join = (_ctx: unknown, conn: ConnContext) => {
	conn.join("events")
	conn.on("message", (payload) => conn.publish("events", payload))
}

/** Until `check` holds, or 2 s pass. */
async function until(check: () => boolean) {
	for (let waited = 0; !check() && waited < 2_000; waited += 10) await quiet(10)
}

describe("realtime() on real sockets", () => {
	it("fans a REST publish and a connection's publish out to every joined client, in order", async () => {
		const app = honey<{}>()
		const live = realtime(app, "/rt", {
			handler: (_ctx, conn) => {
				conn.join("room")
				conn.on("message", (payload) => conn.publish("room", payload))
			},
		})
		app.post("/say").handler(async (ctx) => {
			live.publish("room", await ctx.req.json())
			return ctx.res.text("ok", "sent")
		})
		const base = await listen(app)
		const clients = await Promise.all([1, 2, 3].map(() => socketTo(`${base}/rt`)))
		await quiet(20)
		clients[0]?.ws.send(JSON.stringify("hello"))
		await until(() => clients.every((c) => c.got.length === 1))
		await fetch(`${base.replace("ws", "http")}/say`, { body: JSON.stringify({ n: 2 }), method: "POST" })
		await until(() => clients.every((c) => c.got.length === 2))
		for (const c of clients) c.ws.close()
		expect(clients.map((c) => c.got)).toEqual([1, 2, 3].map(() => ["hello", { n: 2 }]))
	})

	// v0: d8d9f8fecf
	// v0: 18acc29391
	it("two routes keep a topic name apart; routes that share a bus and name one namespace share it", async () => {
		const app = honey<{}>()
		const bus = createBus()
		realtime(app, "/public", { handler: join })
		realtime(app, "/admin", { handler: join })
		realtime(app, "/a", { bus, handler: join, namespace: "chat" })
		realtime(app, "/b", { bus, handler: join, namespace: "chat" })
		const base = await listen(app)
		const [pub, admin, a, b] = await Promise.all(["/public", "/admin", "/a", "/b"].map((path) => socketTo(base + path)))
		await quiet(20)
		pub?.ws.send(JSON.stringify("public"))
		a?.ws.send(JSON.stringify("chat"))
		await until(() => b?.got.length === 1)
		await quiet(20)
		for (const c of [pub, admin, a, b]) c?.ws.close()
		expect([pub?.got, admin?.got, a?.got, b?.got]).toEqual([["public"], [], ["chat"], ["chat"]])
	})
})

describe("realtime() with a slow consumer", () => {
	it("a client that stops reading is closed 1013 once its backlog passes maxBufferedBytes", async () => {
		const app = honey<{}>()
		const live = realtime(app, "/rt", {
			handler: (_ctx, conn) => conn.join("feed"),
			limits: { maxBufferedBytes: 64 * 1024 },
		})
		const base = await listen(app)
		const slow = await socketTo(`${base}/rt`)
		const closed = new Promise<number>((resolve) => slow.ws.on("close", (code) => resolve(code)))
		await quiet(20)
		slow.ws.pause()
		const chunk = "x".repeat(64 * 1024)
		for (let i = 0; i < 400; i++) live.publish("feed", chunk)
		slow.ws.resume()
		expect(await closed).toBe(1013)
	})
})

describe("the reference server: WebSocket resume through onReconnect", () => {
	it("a fresh socket gets the whole log, then live events", async () => {
		const ref = await reference(2)
		const got = await frames(`${ref.ws}/events/ws`, 3, () => setTimeout(() => ref.append({ n: 3 }), 20))
		expect(got).toEqual([
			{ data: { n: 1 }, id: 1 },
			{ data: { n: 2 }, id: 2 },
			{ data: { n: 3 }, id: 3 },
		])
	})

	it("a reconnect_token resumes after that id, never replaying what the client already had", async () => {
		const ref = await reference(4)
		const got = await frames(`${ref.ws}/events/ws?reconnect_token=2`, 3, () =>
			setTimeout(() => ref.append({ n: 5 }), 20),
		)
		expect(got).toEqual([
			{ data: { n: 3 }, id: 3 },
			{ data: { n: 4 }, id: 4 },
			{ data: { n: 5 }, id: 5 },
		])
	})

	it.each([
		["not a whole number replays the whole log", "abc", [1, 2, "live"]],
		["past the head replays nothing", "99", ["live"]],
	])("a forged token is only data: one %s", async (_name, token, expected) => {
		const ref = await reference(2)
		const got = await frames(`${ref.ws}/events/ws?reconnect_token=${token}`, expected.length, () =>
			setTimeout(() => ref.append("live"), 20),
		)
		expect(got.map((frame) => (frame as { data: unknown; id: number }).data)).toEqual(
			expected.map((n) => (n === "live" ? "live" : { n })),
		)
	})

	it("a closed socket or a stream the client left stops following the log", async () => {
		const ref = await reference(1)
		let socketOpen = -1
		let streamOpen = -1
		await frames(`${ref.ws}/events/ws`, 1, () => (socketOpen = ref.following()))
		await quiet()
		const afterSocket = ref.following()
		await sseEvents(`${ref.base}/events`, 1, {}, () => (streamOpen = ref.following()))
		await quiet()
		expect([socketOpen, afterSocket, streamOpen, ref.following()]).toEqual([1, 0, 1, 0])
	})
})

describe("the reference server: SSE resume through Last-Event-ID", () => {
	it("posts append to the log; a fresh stream gets it all, then live events", async () => {
		const ref = await reference(0)
		const posted = await fetch(`${ref.base}/events`, { body: JSON.stringify({ n: 1 }), method: "POST" })
		const stream = await sseEvents(`${ref.base}/events`, 2, {}, () => setTimeout(() => ref.append({ n: 2 }), 20))
		expect([await posted.json(), stream]).toEqual([
			{ data: { n: 1 }, id: 1 },
			[
				"text/event-stream",
				[
					["1", { n: 1 }],
					["2", { n: 2 }],
				],
			],
		])
	})

	it("Last-Event-ID resumes after that id", async () => {
		const ref = await reference(3)
		const [, events] = await sseEvents(`${ref.base}/events`, 2, { "last-event-id": "1" })
		expect(events).toEqual([
			["2", { n: 2 }],
			["3", { n: 3 }],
		])
	})
})
