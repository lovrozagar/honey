/**
 * WebSockets through the emitted client: the typed socket, the URL each front opens, an SDK
 * operation's per-call options and `x-invalidate`, and its types as a consumer sees them. A scripted
 * `WebSocket` stands in for the browser's; no socket ever reaches the network.
 */
import { Project, ts } from "ts-morph"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { emittedApp, emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"
import { generateSdk } from "./sdk.ts"

type Json = Record<string, unknown>
type Handler = (...args: never[]) => void

/** The typed socket as these tests drive it. */
type Socket = {
	close(code?: number, reason?: string): void
	on(event: string, handler: Handler): void
	readonly readyState: number
	send(data: unknown): void
}

type Sdk = Record<string, Record<string, (input?: Json) => Socket>>

/** A browser WebSocket the test scripts: it records its URL, protocols and frames; the test opens, feeds and closes it. */
class FakeSocket extends EventTarget {
	static sockets: FakeSocket[] = []
	binaryType = "blob"
	readyState = 0
	readonly protocols: string | string[] | undefined
	readonly sent: unknown[] = []
	readonly url: string

	constructor(url: string | URL, protocols?: string | string[]) {
		super()
		this.url = String(url)
		this.protocols = protocols
		FakeSocket.sockets.push(this)
	}

	/** The handshake completes. */
	accept(): void {
		this.readyState = 1
		this.dispatchEvent(new Event("open"))
	}

	/** A frame from the server. */
	receive(data: unknown): void {
		this.dispatchEvent(new MessageEvent("message", { data }))
	}

	send(data: unknown): void {
		this.sent.push(data)
	}

	close(code = 1005, reason = ""): void {
		this.readyState = 3
		this.dispatchEvent(Object.assign(new Event("close"), { code, reason }))
	}
}

/** The reference app's `/api/echo-ws`: greets with "connected" on open, then echoes each frame. */
class EchoServer extends FakeSocket {
	override accept(): void {
		super.accept()
		this.receive("connected")
	}

	override send(data: unknown): void {
		super.send(data)
		queueMicrotask(() => this.receive(data))
	}
}

/** The socket the client opened last. */
const last = (): FakeSocket => FakeSocket.sockets.at(-1) as FakeSocket

/** Let queued microtasks and timers run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** An OpenAPI 3.1 document of `paths`. */
const doc = (paths: Json): Json => ({ info: { title: "T", version: "1" }, openapi: "3.1.0", paths })

/** A required string path parameter. */
const param = (name: string) => ({ in: "path", name, required: true, schema: { type: "string" } })

/** A WebSocket operation (`x-websocket`), with `extra` fields. */
const socketOp = (operationId: string, extra: Json = {}) => ({
	get: { operationId, responses: {}, "x-websocket": true, ...extra },
})

const OK = { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }

const WS = doc({
	"/api/echo-ws": socketOp("echo.connect"),
	"/rooms/{room}/live": socketOp("rooms.live", {
		parameters: [param("room")],
		"x-invalidate": ["GET /rooms/:room/messages"],
	}),
	"/rooms/{room}/messages": { get: { operationId: "rooms.messages", parameters: [param("room")], responses: OK } },
	"/ws/chat/{channelId}": socketOp("ws.chat", { parameters: [param("channelId")] }),
	"/ws/echo": socketOp("ws.echo"),
})

/** A `TestSDK` over the WS document, its fetch recording. */
async function sdkOf(config: Json = {}): Promise<Sdk> {
	const { TestSDK } = (await emittedSdk(WS)) as unknown as { TestSDK: new (config: Json) => Sdk }
	return new TestSDK({ baseURL: "https://api.example.com", fetch: recordingFetch().fetch, ...config })
}

/** The app front's `api.ws` over `baseURL`. */
async function appWs(baseURL: string): Promise<(path: string, input?: Json) => Socket> {
	const { createClient } = (await emittedApp()) as unknown as {
		createClient: (config: Json) => { ws: (path: string, input?: Json) => Socket }
	}
	const api = createClient({ baseURL, fetch: recordingFetch().fetch })
	return (path, input) => api.ws(path, input)
}

/** A typed socket over a scripted one, as `createTypedWebSocket(url, opts, impl)` builds it. */
async function typed(): Promise<{ raw: FakeSocket; socket: Socket }> {
	const { createTypedWebSocket } = (await emittedApp()) as unknown as {
		createTypedWebSocket: (url: string, opts: undefined, impl: typeof FakeSocket) => Socket
	}
	const socket = createTypedWebSocket("ws://test/echo", undefined, FakeSocket)
	return { raw: last(), socket }
}

beforeEach(() => {
	FakeSocket.sockets = []
	vi.stubGlobal("WebSocket", FakeSocket)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("the typed WebSocket: lifecycle", () => {
	// v0: 9e89eb291f
	it("exposes send, on and close", async () => {
		const { socket } = await typed()
		expect([typeof socket.send, typeof socket.on, typeof socket.close]).toEqual(["function", "function", "function"])
	})

	// v0: 9f7e7fa079
	it("fires open once when the handshake completes", async () => {
		const { raw, socket } = await typed()
		const opened = vi.fn()
		socket.on("open", opened)
		raw.accept()
		expect(opened).toHaveBeenCalledOnce()
	})

	// v0: 035b6c6243
	it("fires close with the code and reason", async () => {
		const { socket } = await typed()
		const closed = vi.fn()
		socket.on("close", closed)
		socket.close(1000, "done")
		expect(closed.mock.calls).toEqual([[1000, "done"]])
	})

	// v0: c60d52f9c0
	it("reads the socket's readyState as it connects, opens and closes", async () => {
		const { raw, socket } = await typed()
		const states = [socket.readyState]
		raw.accept()
		states.push(socket.readyState)
		socket.close()
		states.push(socket.readyState)
		expect(states).toEqual([0, 1, 3])
	})
})

describe("the typed WebSocket: frames", () => {
	// v0: 4811424bad
	it("sends a string as it is", async () => {
		const { raw, socket } = await typed()
		raw.accept()
		socket.send("hello")
		expect(raw.sent).toEqual(["hello"])
	})

	// v0: f14ea9c758
	it("sends an object as JSON", async () => {
		const { raw, socket } = await typed()
		raw.accept()
		socket.send({ msg: "hi" })
		expect(raw.sent).toEqual([JSON.stringify({ msg: "hi" })])
	})

	// v0: cf27fed71e
	it('delivers a text frame to on("message")', async () => {
		const { raw, socket } = await typed()
		const messages: unknown[] = []
		socket.on("message", (data: string) => messages.push(data))
		raw.receive("world")
		expect(messages).toEqual(["world"])
	})

	// v0: bd7ce54cab
	it("never surfaces ping or pong control events to the socket's handlers", async () => {
		const { raw, socket } = await typed()
		const seen: unknown[][] = []
		for (const event of ["binary", "close", "error", "message", "open", "ping", "pong"])
			socket.on(event, (...args: never[]) => seen.push([event, ...args]))
		raw.accept()
		raw.dispatchEvent(new Event("ping"))
		raw.dispatchEvent(new Event("pong"))
		raw.receive("hi")
		expect(seen).toEqual([["open"], ["message", "hi"]])
	})
})

type UrlRow = { base: string; expected: string; input?: Json; path: string }

const APP_URLS: UrlRow[] = [
	// v0: 1b990d605e
	// v0: b20ae7ec5c
	// v0: 435d65c355
	{ base: "https://api.example.com", expected: "wss://api.example.com/chat", path: "/chat" },
	// v0: f7c69ed6bf
	// v0: 76bfcfab4a
	{ base: "http://localhost:3000", expected: "ws://localhost:3000/echo-ws", path: "/echo-ws" },
	// v0: cc8897928e
	// v0: 2d38739694
	// v0: 2e3d9a2e08
	{
		base: "https://api.example.com",
		expected: "wss://api.example.com/rooms/42",
		input: { params: { roomId: "42" } },
		path: "/rooms/:roomId",
	},
	// v0: cd6f470014
	{ base: "http://httpbin.org", expected: "ws://httpbin.org/ws", path: "/ws" },
	// v0: e6512bfbcb
	{
		base: "http://localhost:3000",
		expected: "ws://localhost:3000/ws?token=abc",
		input: { search: { token: "abc" } },
		path: "/ws",
	},
	// v0: 52afb5fe68
	{
		base: "https://api.example.com",
		expected: "wss://api.example.com/chat?reconnect_token=abc",
		input: { reconnectToken: "abc" },
		path: "/chat",
	},
	// v0: cbf9f4ad31
	{
		base: "https://api.example.com",
		expected: "wss://api.example.com/chat?x=1&reconnect_token=abc",
		input: { reconnectToken: "abc", search: { x: "1" } },
		path: "/chat",
	},
]

describe("api.ws: the socket the app front opens", () => {
	it.each(APP_URLS)("opens $expected for $base and $path", async ({ base, expected, input, path }) => {
		const ws = await appWs(base)
		ws(path, input)
		expect(FakeSocket.sockets.map((socket) => socket.url)).toEqual([expected])
	})

	// v0: 26fd0180f0
	it("resolves a path-only baseURL against location.origin and swaps its scheme to wss", async () => {
		vi.stubGlobal("location", { origin: "https://app.example.com" })
		const ws = await appWs("/api")
		ws("/echo-ws")
		expect(last().url).toBe("wss://app.example.com/api/echo-ws")
	})

	// v0: 2489bbdc31
	it("passes the subprotocols to the WebSocket", async () => {
		const ws = await appWs("https://api.example.com")
		ws("/chat", { protocols: ["v1", "v2"] })
		expect(last().protocols).toEqual(["v1", "v2"])
	})
})

const SDK_URLS: (UrlRow & { member: [string, string] })[] = [
	// v0: 23d624f79e
	{
		base: "https://api.example.com",
		expected: "wss://api.example.com/ws/echo",
		member: ["ws", "echo"],
		path: "/ws/echo",
	},
	// v0: b1b928eb24
	// v0: 44e305fc5f
	{
		base: "http://localhost:3000",
		expected: "ws://localhost:3000/ws/chat/general",
		input: { params: { channelId: "general" } },
		member: ["ws", "chat"],
		path: "/ws/chat/{channelId}",
	},
	// v0: 1665940631
	{
		base: "https://api.example.com",
		expected: "wss://api.example.com/ws/echo?reconnect_token=t%2F1",
		input: { reconnectToken: "t/1" },
		member: ["ws", "echo"],
		path: "/ws/echo",
	},
]

describe("an SDK WebSocket operation", () => {
	it.each(SDK_URLS)("opens $expected for $path on $base", async ({ base, expected, input, member: [ns, op] }) => {
		const sdk = await sdkOf({ baseURL: base })
		sdk[ns]?.[op]?.(input)
		expect(FakeSocket.sockets.map((socket) => socket.url)).toEqual([expected])
	})

	// v0: 3450098f69
	it("returns a socket with send, close and on", async () => {
		const sdk = await sdkOf()
		const socket = sdk.ws?.echo?.() as Socket
		expect([typeof socket.send, typeof socket.close, typeof socket.on]).toEqual(["function", "function", "function"])
	})

	// v0: 28b159765f
	it("passes the per-call protocols, a string or a list, to the WebSocket", async () => {
		const sdk = await sdkOf()
		sdk.ws?.echo?.({ protocols: "v1" })
		sdk.ws?.echo?.({ protocols: ["v1", "v2"] })
		expect(FakeSocket.sockets.map((socket) => socket.protocols)).toEqual(["v1", ["v1", "v2"]])
	})

	// v0: 66fed1a886
	it("marks its x-invalidate targets stale once the socket opens", async () => {
		const views: Json[] = []
		const onRequest = [(ctx: Json) => void views.push({ invalidatedBy: ctx.invalidatedBy, isStale: ctx.isStale })]
		const sdk = await sdkOf({ invalidation: { staleTime: 5_000 }, onRequest })
		const read = () => sdk.rooms?.messages?.({ params: { room: "r1" } }) as unknown as Promise<unknown>
		sdk.rooms?.live?.({ params: { room: "r1" } })
		await read()
		last().accept()
		await read()
		expect(views).toEqual([
			{ invalidatedBy: [], isStale: false },
			{ invalidatedBy: ["WS /rooms/r1/live"], isStale: true },
		])
	})
})

describe("an SDK WebSocket against the reference echo server (scripted)", () => {
	// v0: 44a9953b6f
	it("receives the server's greeting, then the echo of a sent frame", async () => {
		vi.stubGlobal("WebSocket", EchoServer)
		const socket = (await sdkOf()).echo?.connect?.() as Socket
		const messages: unknown[] = []
		socket.on("message", (data: string) => messages.push(data))
		socket.on("open", () => socket.send("ping"))
		last().accept()
		await settle()
		expect(messages).toEqual(["connected", "ping"])
	})

	// v0: 12965fcd5d
	it("echoes rapid sends back in order", async () => {
		vi.stubGlobal("WebSocket", EchoServer)
		const socket = (await sdkOf()).echo?.connect?.() as Socket
		const messages: unknown[] = []
		socket.on("message", (data: string) => messages.push(data))
		socket.on("open", () => {
			for (let i = 0; i < 5; i++) socket.send(`msg-${i}`)
		})
		last().accept()
		await settle()
		expect(messages).toEqual(["connected", "msg-0", "msg-1", "msg-2", "msg-3", "msg-4"])
	})
})

/* one project for the file: the lib files parse once, each check swaps the SDK and the consumer */
const project = new Project({
	compilerOptions: {
		allowImportingTsExtensions: true,
		lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		noEmit: true,
		skipLibCheck: true,
		strict: true,
		target: ts.ScriptTarget.ES2022,
	},
	useInMemoryFileSystem: true,
})

/** What every consumer starts with: the SDK, an instance, and the assertion helpers. */
const prelude = (stem: string) => `import { TestSDK, type TypedWebSocket } from "./${stem}.index.gen.ts"
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
declare function expectType<T extends true>(): void
type Input<F extends (...args: never[]) => unknown> = NonNullable<Parameters<F>[0]>
const sdk = new TestSDK({ baseURL: "https://api.example.com" })
`

/** Each diagnostic of `consumer` beside the SDK of the WS document. */
function check(consumer: string): string[] {
	for (const file of project.getSourceFiles()) project.removeSourceFile(file)
	const { files, stem } = generateSdk(WS, { name: "TestSDK" })
	for (const [name, text] of Object.entries(files)) project.createSourceFile(`/sdk/${name}`, text)
	const main = project.createSourceFile("/sdk/consumer.ts", `${prelude(stem)}${consumer}\n`)
	return main.getPreEmitDiagnostics().map((d) => {
		const text = d.getMessageText()
		return `${d.getLineNumber()}: ${typeof text === "string" ? text : text.getMessageText()}`
	})
}

describe("an SDK WebSocket operation's types", () => {
	// v0: 52a5219983
	it("takes an optional input and returns a TypedWebSocket", () => {
		const consumer = `const socket = sdk.ws.echo()
expectType<Equal<typeof socket, TypedWebSocket>>()`
		expect(check(consumer)).toEqual([])
	})

	// v0: 97cf971ee1
	it("requires its path params, typed", () => {
		const consumer = `expectType<Same<Input<typeof sdk.ws.chat>["params"], { channelId: string }>>()
// @ts-expect-error the channelId path param is required
void sdk.ws.chat()`
		expect(check(consumer)).toEqual([])
	})

	// v0: 31b9ef1230
	it("accepts protocols as a string or a string array", () => {
		const consumer = `expectType<Same<Input<typeof sdk.ws.echo>["protocols"], string | string[] | undefined>>()
void sdk.ws.echo({ protocols: "v1" })
void sdk.ws.echo({ protocols: ["v1", "v2"] })`
		expect(check(consumer)).toEqual([])
	})

	// v0: 65abbd0e4d
	it("offers no headers, which a browser socket cannot send", () => {
		const consumer = `expectType<"headers" extends keyof Input<typeof sdk.ws.echo> ? false : true>()
// @ts-expect-error a WebSocket call takes no headers
void sdk.ws.echo({ headers: { authorization: "Bearer t" } })`
		expect(check(consumer)).toEqual([])
	})
})
