/**
 * v0's realtime runtime (C4) through the emitted client: the typed realtime errors, the keepalive loop,
 * the transport fallback chain and the resumable connection, driven by scripted transport adapters; and
 * the resume token of a WebSocket op, driven through a stubbed `globalThis.WebSocket`.
 */
import { Project, ts } from "ts-morph"
import { afterEach, describe, expect, it, vi } from "vitest"
import { emittedApp, emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"
import { generateSdk } from "./sdk.ts"

type Json = Record<string, unknown>

type Frame =
	| { data: unknown; id: number; t: "msg" }
	| { reason: string; t: "bye" }
	| { reconnectToken: string; t: "ready" }
	| { t: "pong" }
type Conn = {
	close(): void
	onClose: (reason: string) => void
	onError: (err: unknown) => void
	onFrame: (frame: Frame) => void
	send(data: string): void
}
type Opts = { headers?: Record<string, string>; lastId?: number; reconnectToken?: string; signal?: AbortSignal }
type Adapter = { connect(url: string, opts: Opts): Conn }
type ErrorClass = new (message: string, reason: string) => Error & { reason: string }
type Keepalive = { onFrame(): void; onPong(): void; start(): void; stop(): void }
type Chain = {
	connect(url: string, opts: Opts): Promise<{ conn: Conn; transport: string }>
	readonly provenTransport: string | null
}
type Resumable = AsyncIterable<unknown> & {
	close(reason?: string): void
	readonly provenTransport: string | null
	send(data: unknown): void
	readonly state: string
}
type Realtime = {
	createFallbackChain(opts: { timeout?: number; transports: Adapter[] }): Chain
	createKeepaliveLoop(opts: {
		interval?: number
		onDead: () => void
		sendPing: () => void
		timeout?: number
		transport: string
	}): Keepalive
	createResumableConnection(opts: Opts & Json & { transports: Adapter[]; url: string }): Resumable
	RealtimeAbortError: ErrorClass
	RealtimeAuthError: ErrorClass
	RealtimeConnectError: ErrorClass
	RealtimeError: ErrorClass
	RealtimeKickedError: ErrorClass
}
type Socket = { close(): void; on(event: "message", handler: (data: string) => void): void }

const ERRORS = [
	"RealtimeError",
	"RealtimeConnectError",
	"RealtimeAuthError",
	"RealtimeKickedError",
	"RealtimeAbortError",
] as const
const EXPORTS = [...ERRORS, "createKeepaliveLoop", "createFallbackChain", "createResumableConnection"] as const

/** An OpenAPI 3.1 document of `paths`. */
const doc = (paths: Json): Json => ({ info: { title: "T", version: "1" }, openapi: "3.1.0", paths })

const REALTIME = doc({ "/rt/feed": { get: { operationId: "rt.feed", responses: {}, "x-realtime": true } } })

/** The kitchen app's `/api/reconnect-ws` operation, with `extensions` beside its `x-websocket`. */
const reconnectWs = (extensions: Json = {}) =>
	doc({
		"/api/reconnect-ws": {
			get: { operationId: "reconnectWs", responses: { 101: { description: "" } }, "x-websocket": true, ...extensions },
		},
	})

/** The realtime runtime of `front`'s emitted module, each v0 export asserted present. */
async function realtime(front: "app" | "sdk" = "sdk"): Promise<Realtime> {
	const mod = front === "sdk" ? await emittedSdk(REALTIME) : await emittedApp()
	expect(EXPORTS.filter((name) => typeof mod[name] !== "function")).toEqual([])
	return mod as unknown as Realtime
}

const ready = (reconnectToken: string): Frame => ({ reconnectToken, t: "ready" })
const msg = (id: number, data: unknown): Frame => ({ data, id, t: "msg" })
const tick = () => Promise.resolve()

type Dial = { closed: boolean; opts: Opts; sent: string[]; url: string }

/** A transport adapter whose `script` drives each dial's connection once the runtime has wired it; dials are logged. */
function scripted(script: (conn: Conn, dial: number) => unknown): { adapter: Adapter; dials: Dial[] } {
	const dials: Dial[] = []
	const adapter: Adapter = {
		connect(url, opts) {
			const dial: Dial = { closed: false, opts: { ...opts }, sent: [], url }
			const n = dials.push(dial)
			const conn: Conn = {
				close: () => {
					dial.closed = true
				},
				onClose: () => {},
				onError: () => {},
				onFrame: () => {},
				send: (data) => {
					dial.sent.push(data)
				},
			}
			queueMicrotask(() => void script(conn, n))
			return conn
		},
	}
	return { adapter, dials }
}

/** The first `count` values `connection` yields. */
async function take(connection: AsyncIterable<unknown>, count: number): Promise<unknown[]> {
	const values: unknown[] = []
	for await (const value of connection) {
		values.push(value)
		if (values.length === count) break
	}
	return values
}

/** What `run` rejects with, as `[class name, reason]`. */
async function rejection(run: Promise<unknown>): Promise<[string, unknown]> {
	const error = (await run.then(
		() => null,
		(e: unknown) => e,
	)) as (Error & { reason?: unknown }) | null
	return [error?.name ?? "resolved", error?.reason]
}

/** A WebSocket standing in for the kitchen app's `/reconnect-ws`: a fresh token on open, the resumed one echoed back. */
function stubReconnectServer(): string[] {
	const opened: string[] = []
	class ReconnectServerSocket extends EventTarget {
		binaryType = "blob"
		readyState = 0
		readonly url: string
		constructor(url: string | URL) {
			super()
			this.url = String(url)
			opened.push(this.url)
			const token = new URL(this.url).searchParams.get("reconnect_token")
			const first = token === null ? { event: "open", token: "fresh-token-123" } : { event: "reconnected", token }
			setTimeout(() => {
				this.readyState = 1
				this.dispatchEvent(new Event("open"))
				this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(first) }))
			}, 0)
		}
		send(): void {}
		close(): void {
			this.readyState = 3
		}
	}
	vi.stubGlobal("WebSocket", ReconnectServerSocket)
	return opened
}

/** The first message the SDK's `reconnectWs` op receives for `input`, parsed. */
async function firstMessage(document: Json, input?: Json): Promise<unknown> {
	const mod = (await emittedSdk(document)) as unknown as { TestSDK: new (config: Json) => Json }
	const sdk = new mod.TestSDK({ baseURL: "http://127.0.0.1:3000", fetch: recordingFetch().fetch })
	const socket = (sdk.reconnectWs as (input?: Json) => Socket)(input)
	const data = await new Promise<string>((resolve) => socket.on("message", resolve))
	socket.close()
	return JSON.parse(data)
}

afterEach(() => {
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

describe("realtime errors", () => {
	// v0: 2e1b53dd4d
	it("exports the realtime errors on both fronts; a failed dial throws RealtimeConnectError, an abort RealtimeAbortError", async () => {
		const shapes = []
		for (const front of ["sdk", "app"] as const) {
			const rt = await realtime(front)
			for (const name of ERRORS) {
				const error = new rt[name]("boom", `${name}-reason`)
				shapes.push([front, error instanceof rt.RealtimeError, error instanceof Error, error.name, error.reason])
			}
		}
		const rt = await realtime()
		const refusing = scripted((conn) => conn.onError(new Error("refused")))
		const idle = scripted((conn) => conn.onFrame(ready("rt-1")))
		const abort = new AbortController()
		const connection = rt.createResumableConnection({ signal: abort.signal, transports: [idle.adapter], url: "u" })
		const next = connection[Symbol.asyncIterator]().next()
		await tick()
		await tick()
		abort.abort()
		expect([
			shapes,
			await rejection(rt.createFallbackChain({ transports: [] }).connect("u", {})),
			await rejection(rt.createFallbackChain({ transports: [refusing.adapter] }).connect("u", {})),
			await rejection(next),
			connection.state,
			idle.dials.map((dial) => dial.closed),
		]).toEqual([
			["sdk", "app"].flatMap((front) => ERRORS.map((name) => [front, true, true, name, `${name}-reason`])),
			["RealtimeConnectError", "no_transports"],
			["RealtimeConnectError", "all_failed"],
			["RealtimeAbortError", "aborted"],
			"closed",
			[true],
		])
	})
})

/** The loop's log over 400ms (interval 100, timeout 250), kept alive once at 100ms by `keep`, then stopped. */
function timeline(rt: Realtime, transport: string, keep: "onFrame" | "onPong"): string[] {
	const log: string[] = []
	const t0 = Date.now()
	const at = (what: string) => () => log.push(`${what}@${Date.now() - t0}`)
	const loop = rt.createKeepaliveLoop({
		interval: 100,
		onDead: at("dead"),
		sendPing: at("ping"),
		timeout: 250,
		transport,
	})
	loop.start()
	vi.advanceTimersByTime(100)
	loop[keep]()
	vi.advanceTimersByTime(300)
	loop.stop()
	vi.advanceTimersByTime(1000)
	return log
}

describe("createKeepaliveLoop", () => {
	// v0: 62953e772f
	it("pings a ws every interval and a pong postpones death; an sse frame postpones death; longpoll never pings", async () => {
		const rt = await realtime()
		vi.useFakeTimers({ now: 0, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
		expect({
			longpoll: timeline(rt, "longpoll", "onPong"),
			sse: timeline(rt, "sse", "onFrame"),
			ws: timeline(rt, "ws", "onPong"),
		}).toEqual({
			longpoll: [],
			sse: ["dead@350"],
			ws: ["ping@100", "ping@200", "ping@300", "dead@350", "ping@400"],
		})
	})
})

describe("createFallbackChain", () => {
	// v0: 9ffa315e9b
	it("falls past a silent and a refusing transport to the next, labels it by position, and redials the proven one first", async () => {
		const rt = await realtime()
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const silent = scripted(() => {})
		const refusing = scripted((conn) => conn.onError(new Error("refused")))
		const healthy = scripted((conn) => conn.onFrame(ready("rt-1")))
		const chain = rt.createFallbackChain({
			timeout: 50,
			transports: [silent.adapter, refusing.adapter, healthy.adapter],
		})
		const first = chain.connect("https://rt.example/feed", { reconnectToken: "rt-0" })
		await vi.advanceTimersByTimeAsync(50)
		const { transport } = await first
		const proven = chain.provenTransport
		const again = await chain.connect("https://rt.example/feed", {})
		expect([
			transport,
			proven,
			again.transport,
			[silent, refusing, healthy].map(({ dials }) => dials.length),
			silent.dials[0]?.closed,
			healthy.dials[0],
		]).toEqual([
			"longpoll",
			"longpoll",
			"longpoll",
			[1, 1, 2],
			true,
			{ closed: false, opts: { reconnectToken: "rt-0" }, sent: [], url: "https://rt.example/feed" },
		])
	})

	// v0: 2e3cc41c3c
	it("connects through a single custom transport on its ready frame", async () => {
		const rt = await realtime()
		const custom = scripted((conn) => conn.onFrame(ready("rt-custom")))
		const chain = rt.createFallbackChain({ transports: [custom.adapter] })
		const { transport } = await chain.connect("http://test.local/rt", {})
		expect([transport, chain.provenTransport, custom.dials.length]).toEqual(["ws", "ws", 1])
	})
})

describe("createResumableConnection over one transport", () => {
	// v0: 298ad7dec2
	it("dials lazily, resumes a dropped stream with the server's reconnect token and last event id, sends JSON", async () => {
		const rt = await realtime()
		const log: string[] = []
		const server = scripted(async (conn, dial) => {
			conn.onFrame(ready(`rt-${dial}`))
			await tick()
			conn.onFrame(msg(6 + dial, dial === 1 ? "a" : "b"))
			await tick()
			if (dial === 1) conn.onClose("network")
		})
		const connection = rt.createResumableConnection({
			headers: { authorization: "Bearer t" },
			lastId: 6,
			onReconnected: () => log.push("connected"),
			onReconnecting: (attempt: number) => log.push(`reconnecting ${attempt}`),
			reconnectDelayMs: 1,
			reconnectToken: "rt-0",
			transports: [server.adapter],
			url: "https://rt.example/feed",
		})
		const before = [connection.state, server.dials.length]
		const iterator = connection[Symbol.asyncIterator]()
		const values = [(await iterator.next()).value, (await iterator.next()).value]
		connection.send({ ack: 8 })
		connection.close()
		const headers = { authorization: "Bearer t" }
		expect([
			before,
			values,
			server.dials.map(({ opts, url }) => [url, opts]),
			server.dials.map(({ closed, sent }) => [closed, sent]),
			log,
			[connection.state, connection.provenTransport],
			await iterator.next(),
		]).toEqual([
			["idle", 0],
			["a", "b"],
			[
				["https://rt.example/feed", { headers, lastId: 6, reconnectToken: "rt-0" }],
				["https://rt.example/feed", { headers, lastId: 7, reconnectToken: "rt-1" }],
			],
			[
				[true, []],
				[true, ['{"ack":8}']],
			],
			["connected", "reconnecting 1", "connected"],
			["closed", "ws"],
			{ done: true, value: undefined },
		])
	})
})

describe("createResumableConnection over a fallback chain", () => {
	// v0: b1dcb28991
	it("drops mid-stream, reconnects through the next transport with its resume state, and keeps yielding", async () => {
		const rt = await realtime()
		const flaky = scripted(async (conn, dial) => {
			if (dial > 1) return conn.onError(new Error("flaky adapter refuses reconnect"))
			conn.onFrame(ready("rt-flaky"))
			await tick()
			conn.onFrame(msg(1, { seq: 1, src: "A" }))
			await tick()
			conn.onError(new Error("simulated mid-stream drop"))
		})
		const stable = scripted(async (conn) => {
			conn.onFrame(ready("rt-stable"))
			await tick()
			conn.onFrame(msg(1, { seq: 1, src: "B" }))
			await tick()
			conn.onFrame(msg(2, { seq: 2, src: "B" }))
		})
		const connection = rt.createResumableConnection({
			maxReconnectAttempts: 5,
			reconnectDelayMs: 10,
			transports: [flaky.adapter, stable.adapter],
			url: "http://test.local/rt",
		})
		const events = await take(connection, 3)
		const proven = connection.provenTransport
		connection.close()
		expect([events, flaky.dials.length, stable.dials.length, stable.dials[0]?.opts, proven, connection.state]).toEqual([
			[
				{ seq: 1, src: "A" },
				{ seq: 1, src: "B" },
				{ seq: 2, src: "B" },
			],
			2,
			1,
			{ lastId: 1, reconnectToken: "rt-flaky" },
			"sse",
			"closed",
		])
	})
})

describe("a WebSocket op's resume token", () => {
	const ops = [
		["x-websocket", reconnectWs()],
		["x-websocket + x-realtime", reconnectWs({ "x-realtime": true })],
	] as const

	// v0: 0490ad4dd6
	it.each(ops)(
		"%s: a fresh connection sends no token and receives the server's new one on open",
		async (_, document) => {
			const opened = stubReconnectServer()
			const first = await firstMessage(document)
			expect([opened, first]).toEqual([
				["ws://127.0.0.1:3000/api/reconnect-ws"],
				{ event: "open", token: "fresh-token-123" },
			])
		},
	)

	// v0: 9f42afa0bd
	it.each(ops)("%s: reconnectToken rides as the reconnect_token query param and resumes", async (_, document) => {
		const opened = stubReconnectServer()
		const first = await firstMessage(document, { reconnectToken: "old-session" })
		expect([opened, first]).toEqual([
			["ws://127.0.0.1:3000/api/reconnect-ws?reconnect_token=old-session"],
			{ event: "reconnected", token: "old-session" },
		])
	})
})

describe("SDK types: a WebSocket op's input", () => {
	// v0: 77c3e29e2f
	it("accepts reconnectToken?: string on a WebSocket and a realtime WebSocket op, and refuses a non-string", () => {
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
		const document = doc({
			"/rt": { get: { operationId: "rt.connect", responses: {}, "x-realtime": true, "x-websocket": true } },
			"/ws": { get: { operationId: "ws.connect", responses: { 200: { description: "" } }, "x-websocket": true } },
		})
		const { files, stem } = generateSdk(document, { name: "TestSDK" })
		for (const [name, text] of Object.entries(files)) project.createSourceFile(`/sdk/${name}`, text)
		const consumer = project.createSourceFile(
			"/sdk/consumer.ts",
			`import { TestSDK } from "./${stem}.index.gen.ts"
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
declare function expectType<T extends true>(): void
type Token<F extends (...args: never[]) => unknown> = NonNullable<Parameters<F>[0]>["reconnectToken"]
const sdk = new TestSDK({ baseURL: "https://api.example.com" })
expectType<Equal<Token<typeof sdk.ws.connect>, string | undefined>>()
expectType<Equal<Token<typeof sdk.rt.connect>, string | undefined>>()
sdk.ws.connect({ reconnectToken: "old-session" })
// @ts-expect-error a resume token is a string
sdk.rt.connect({ reconnectToken: 1 })
`,
		)
		expect(
			consumer.getPreEmitDiagnostics().map((d) => ts.flattenDiagnosticMessageText(d.compilerObject.messageText, "\n")),
		).toEqual([])
	})
})

describe("a realtime op dispatches by its transport (C4)", () => {
	it("sends a REST realtime op as a request and iterates an SSE realtime op's events", async () => {
		const ok = { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "" } }
		const events = { 200: { content: { "text/event-stream": { schema: { type: "string" } } }, description: "" } }
		const document = {
			info: { title: "T", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/feed": { get: { operationId: "rt.feed", responses: events, "x-realtime": true } },
				"/state": { get: { operationId: "rt.state", responses: ok, "x-realtime": true } },
			},
		}
		const { calls, fetch } = recordingFetch((request) =>
			request.url.endsWith("/feed")
				? new Response("data: a\n\n", { headers: { "content-type": "text/event-stream" } })
				: Response.json({ live: true }),
		)
		const { TestSDK } = (await emittedSdk(document)) as unknown as {
			TestSDK: new (config: Json) => Record<string, any>
		}
		const sdk = new TestSDK({ baseURL: "https://api.test", fetch, throwOnError: true })
		const seen: string[] = []
		for await (const event of sdk.rt.feed()) seen.push(event.data)
		expect([await sdk.rt.state(), seen, calls.map((r) => r.headers.get("accept"))]).toEqual([
			{ live: true },
			["a"],
			["text/event-stream", null],
		])
	})
})
