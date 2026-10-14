/**
 * WebSockets on a real node:http server: the 'upgrade' path the Node bridge wires (NODE_UPGRADE,
 * ws writing the 101 itself, the body writer never touching an upgraded socket), the adapter
 * serve(app) uses, failures around the upgrade, and Node without shouldUpgradeCallback.
 */
import { createServer, type Server } from "node:http"
import { type AddressInfo, connect } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket as WsClient } from "ws"
import { type HoneyServer, type NodeServeOptions, serve } from "../../src/adapters/node/serve.ts"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { honey } from "../../src/routing/app.ts"
import { bunWebSocket } from "../../src/ws/bun.ts"
import { NODE_UPGRADE, type NodeUpgrade, nodeWebSocket } from "../../src/ws/node.ts"

type FetchApp = { fetch(request: Request, env: unknown): Response | Promise<Response> }

const servers: HoneyServer[] = []
/** front servers some cases put before the honey server */
const fronts: Server[] = []

afterEach(async () => {
	for (const front of fronts.splice(0)) front.closeAllConnections()
	await Promise.all(servers.splice(0).map((server) => (server.listening ? server.shutdown(0) : Promise.resolve())))
	vi.restoreAllMocks()
})

/** Serve `app` on a free loopback port. */
async function listen(app: FetchApp, options: Partial<NodeServeOptions<unknown>> = {}) {
	const server = serve(app, { env: {}, hostname: "127.0.0.1", port: 0, ...options })
	servers.push(server)
	await new Promise((resolve) => server.once("listening", resolve))
	const { port } = server.address() as AddressInfo
	return { base: `http://127.0.0.1:${port}`, port, server }
}

/** An app answering every request with `answer(request, env)`. */
const answering = (answer: FetchApp["fetch"]): FetchApp => ({ fetch: answer })

/** Raw bytes in, every byte the server wrote until it closed the connection out. */
function exchange(port: number, bytes: string): Promise<string> {
	return new Promise((resolve) => {
		const socket = connect(port, "127.0.0.1")
		let out = ""
		socket.on("data", (chunk) => (out += chunk.toString("latin1")))
		socket.on("close", () => resolve(out))
		socket.on("error", () => {})
		socket.write(bytes)
	})
}

/** A promise and the function that settles it. */
function gate<T = void>() {
	let open!: (value: T) => void
	const shut = new Promise<T>((resolve) => (open = resolve))
	return { open, shut }
}

/** The app's ws adapter, read from its settings. */
const adapterOf = (app: unknown) => (app as { settings: { wsAdapter: { runtime: string } } }).settings.wsAdapter

const HANDSHAKE = (path: string, extra = "") =>
	`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${extra}\r\n`

/** Every byte the server writes after `bytes`, up to `quiet` ms of silence; the socket stays open. */
function afterHandshake(port: number, bytes: string, quiet = 50): Promise<string> {
	return new Promise((resolve) => {
		const socket = connect(port, "127.0.0.1")
		let out = ""
		let timer: ReturnType<typeof setTimeout> | undefined
		const settle = () => {
			clearTimeout(timer)
			timer = setTimeout(() => {
				socket.destroy()
				resolve(out)
			}, quiet)
		}
		socket.on("data", (chunk) => {
			out += chunk.toString("latin1")
			settle()
		})
		socket.on("close", () => resolve(out))
		socket.on("error", () => {})
		socket.write(bytes)
		settle()
	})
}

/** A honey app with a ws route at /live and a page at /page. */
function wsApp() {
	const app = honey<{}>()
	app.ws("/live").handler({})
	app.get("/page").handler((ctx) => ctx.res.text("ok", "page"))
	return app
}

describe("WebSockets on Node: the 'upgrade' path", () => {
	it("ws writes the 101 and nothing follows it: the body writer never touches an upgraded socket", async () => {
		const { port } = await listen(wsApp() as unknown as FetchApp)
		const raw = await afterHandshake(port, HANDSHAKE("/live"))
		expect(raw).toBe(
			"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n",
		)
	})

	it("an upgrade the app refuses, or one to a path with no ws route, gets the app's answer on the socket, which then closes", async () => {
		const app = wsApp()
		app
			.use(createMiddleware(() => new Response("no", { status: 401 })))
			.ws("/locked")
			.handler({})
		const { port } = await listen(app as unknown as FetchApp)
		const [locked, page] = await Promise.all([exchange(port, HANDSHAKE("/locked")), exchange(port, HANDSHAKE("/page"))])
		/* the refusal is a native stream, so Node chunks it; the page is buffered */
		expect([
			locked.split("\r\n")[0],
			locked.endsWith("2\r\nno\r\n0\r\n\r\n"),
			page.split("\r\n")[0],
			page.endsWith("page"),
		]).toEqual(["HTTP/1.1 401 Unauthorized", true, "HTTP/1.1 200 OK", true])
	})

	it("hands the adapter the socket on the request view (NODE_UPGRADE); ctx.env stays the app's own", async () => {
		const seen: unknown[] = []
		const probe = answering((req, env) => {
			const upgrade = (req as unknown as { [NODE_UPGRADE]?: NodeUpgrade })[NODE_UPGRADE]
			seen.push([upgrade?.upgraded, Buffer.isBuffer(upgrade?.head), typeof upgrade?.socket, env])
			return new Response("seen")
		})
		const { port } = await listen(probe, { env: { db: "primary" } })
		await exchange(port, HANDSHAKE("/anything"))
		expect(seen).toEqual([[false, true, "object", { db: "primary" }]])
	})
})

describe("WebSockets on Node: answered on the socket", () => {
	it.each([
		[
			"a Host no URL holds",
			HANDSHAKE("/live").replace("Host: 127.0.0.1", "Host: 1.2.3.256"),
			"HTTP/1.1 400 Bad Request",
		],
	])("%s: answered on the socket before the app", async (_case, bytes, line) => {
		const { port } = await listen(wsApp() as unknown as FetchApp)
		expect((await exchange(port, bytes)).split("\r\n")[0]).toBe(line)
	})

	it("an app that throws during an upgrade: onError hears it and the socket gets a 500", async () => {
		const onError = vi.fn()
		const boom = new Error("boom")
		const { port } = await listen(
			answering(() => {
				throw boom
			}),
			{ onError },
		)
		const raw = await exchange(port, HANDSHAKE("/live"))
		expect([raw.split("\r\n")[0], onError.mock.calls]).toEqual(["HTTP/1.1 500 Internal Server Error", [[boom]]])
	})

	it("an upgrade the app never answers is cut at upgradeTimeout", async () => {
		const { port } = await listen(
			answering(() => new Promise(() => {})),
			{ upgradeTimeout: 30 },
		)
		const started = Date.now()
		expect([await exchange(port, HANDSHAKE("/live")), Date.now() - started < 2000]).toEqual(["", true])
	})
})

describe("WebSockets on Node: the adapter serve(app) uses", () => {
	it("fills nodeWebSocket() into an app without one, keeps one it was given, and refuses another runtime's", async () => {
		const bare = wsApp()
		await listen(bare as unknown as FetchApp)
		const own = wsApp()
		const given = nodeWebSocket({ maxPayload: 10 })
		own.wsAdapter(given)
		await listen(own as unknown as FetchApp)
		expect([adapterOf(bare).runtime, adapterOf(own) === given]).toEqual(["node", true])
		expect(() => serve(wsApp().wsAdapter(bunWebSocket()) as unknown as FetchApp, { env: {} })).toThrow(
			"serve() on Node needs a nodeWebSocket() adapter, but app.wsAdapter() was given another",
		)
	})

	it("shutdown closes open WebSockets with 1001, and cuts what is left at its timeout", async () => {
		const { port, server } = await listen(wsApp() as unknown as FetchApp)
		const client = new WsClient(`ws://127.0.0.1:${port}/live`)
		await new Promise((resolve) => client.once("open", resolve))
		const code = new Promise<number>((resolve) => client.once("close", resolve))
		await server.shutdown(50)
		expect(await code).toBe(1001)
	})
})

/** A front server that forwards each Upgrade to `target`'s 'upgrade' path; returns its port. */
async function frontFor(target: Server): Promise<number> {
	const front = createServer()
	front.on("upgrade", (incoming, socket, head) => target.emit("upgrade", incoming, socket, head))
	fronts.push(front)
	await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve))
	return (front.address() as AddressInfo).port
}

describe("WebSockets on Node: failures around the upgrade", () => {
	it("an onError that throws itself never escapes: the request still gets its 500 and the server keeps serving", async () => {
		const failing = answering(() => {
			throw new Error("app failed")
		})
		const { base, port } = await listen(failing, {
			onError: () => {
				throw new Error("onError failed too")
			},
		})
		const [http, upgrade] = await Promise.all([fetch(base), exchange(port, HANDSHAKE("/live"))])
		expect([http.status, upgrade.split("\r\n")[0]]).toEqual([500, "HTTP/1.1 500 Internal Server Error"])
	})

	it("a socket ws already took is never answered with a 500, though onError hears the failure", async () => {
		const onError = vi.fn()
		const taking = answering((req) => {
			const upgrade = (req as unknown as { [NODE_UPGRADE]: NodeUpgrade })[NODE_UPGRADE]
			upgrade.upgraded = true
			throw new Error("after the 101")
		})
		const { port } = await listen(taking, { onError })
		expect([await afterHandshake(port, HANDSHAKE("/live")), onError.mock.calls.length]).toEqual(["", 1])
	})
})

describe("WebSockets on Node: a client that leaves", () => {
	it("a client that leaves before the app refuses is written nothing; a reset never crashes the server", async () => {
		const release = gate()
		const app = honey<{}>()
		app
			.use(
				createMiddleware(async () => {
					await release.shut
					return new Response("late", { status: 401 })
				}),
			)
			.ws("/live")
			.handler({})
		const onError = vi.fn()
		const { base, port } = await listen(app as unknown as FetchApp, { onError })
		const socket = connect(port, "127.0.0.1")
		socket.on("error", () => {})
		socket.write(HANDSHAKE("/live"))
		await new Promise((resolve) => setTimeout(resolve, 20))
		socket.resetAndDestroy()
		await new Promise((resolve) => setTimeout(resolve, 20))
		release.open()
		await new Promise((resolve) => setTimeout(resolve, 20))
		/* the app-wide middleware answers every path, so the server still answering it proves it serves */
		expect([(await fetch(`${base}/elsewhere`)).status, onError.mock.calls.length]).toEqual([401, 0])
	})

	it("an app that fails after its client left: onError hears it, and nothing is written to the dead socket", async () => {
		const release = gate()
		const onError = vi.fn()
		const failingLate = answering(async () => {
			await release.shut
			throw new Error("too late")
		})
		const { port } = await listen(failingLate, { onError })
		const socket = connect(port, "127.0.0.1")
		socket.on("error", () => {})
		socket.write(HANDSHAKE("/live"))
		await new Promise((resolve) => setTimeout(resolve, 20))
		/* a reset, not a polite FIN: the server's socket errors and is destroyed */
		socket.resetAndDestroy()
		await new Promise((resolve) => setTimeout(resolve, 20))
		release.open()
		await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
	})
})

describe("WebSockets on Node: draining and deadlines", () => {
	it("an upgrade arriving while the server drains is answered 503 on the socket", async () => {
		const { server } = await listen(wsApp() as unknown as FetchApp)
		const port = await frontFor(server)
		void server.shutdown()
		expect((await exchange(port, HANDSHAKE("/live"))).split("\r\n")[0]).toBe("HTTP/1.1 503 Service Unavailable")
	})

	it("an upgradeTimeout of 0 sets no deadline, and the upgrade still works", async () => {
		const { port } = await listen(wsApp() as unknown as FetchApp, { upgradeTimeout: 0 })
		expect((await afterHandshake(port, HANDSHAKE("/live"))).split("\r\n")[0]).toBe("HTTP/1.1 101 Switching Protocols")
	})

	it("shutdown's timeout cuts a WebSocket whose peer never answers the close", async () => {
		const { port, server } = await listen(wsApp() as unknown as FetchApp)
		const socket = connect(port, "127.0.0.1")
		const ended = new Promise((resolve) => socket.on("close", resolve))
		socket.on("data", () => {})
		socket.write(HANDSHAKE("/live"))
		await new Promise((resolve) => setTimeout(resolve, 30))
		const started = Date.now()
		await server.shutdown(40)
		await ended
		expect(Date.now() - started).toBeLessThan(1000)
	})
})

describe("Node without shouldUpgradeCallback: an Upgrade that is not WebSocket", () => {
	/**
	 * A front server that sends every Upgrade down the 'upgrade' path, as Node before
	 * shouldUpgradeCallback does, and forwards it to the honey server; the raw answer comes back.
	 */
	async function upgradePath(bytes: string) {
		const { server } = await listen(wsApp() as unknown as FetchApp)
		return exchange(await frontFor(server), bytes)
	}

	it("a bodiless one is served as the request it is", async () => {
		const raw = await upgradePath("GET /page HTTP/1.1\r\nHost: h\r\nUpgrade: h2c\r\nConnection: Upgrade\r\n\r\n")
		expect([raw.split("\r\n")[0], raw.endsWith("page")]).toEqual(["HTTP/1.1 200 OK", true])
	})

	it("one with a body is refused: its bytes are already on the raw socket", async () => {
		const raw = await upgradePath(
			"POST /page HTTP/1.1\r\nHost: h\r\nUpgrade: h2c\r\nConnection: Upgrade\r\nContent-Length: 7\r\n\r\npayload",
		)
		expect(raw.split("\r\n")[0]).toBe("HTTP/1.1 400 Bad Request")
	})
})
