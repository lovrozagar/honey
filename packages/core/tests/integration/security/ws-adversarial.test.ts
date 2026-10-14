/**
 * The adversarial suite's WebSocket cases (F1): cross-site WebSocket hijacking, an oversized
 * frame, a handler queue that never drains, a slow consumer, a forged resume token. Each is a
 * failing input first and the guard that answers it second; the mutation harness reruns this
 * directory with each guard disabled and requires it to go red.
 */
import { resolve as resolvePath } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { guardNamed } from "../../structure/mutation-harness.ts"

const REPO = resolvePath(import.meta.dirname, "../../../../..")

const mutant = guardNamed(process.env.HONEY_MUTANT)
if (mutant !== undefined) {
	vi.doMock(resolvePath(REPO, mutant.module), async (importOriginal) => {
		const original = await importOriginal<Record<string, unknown>>()
		return { ...original, ...mutant.disable(original) }
	})
}

/* imported after the mock, so a mutant reaches every module that uses it */
const { honey } = (await import(
	resolvePath(REPO, "packages/core/src/routing/app.ts")
)) as typeof import("../../../src/routing/app.ts")
const { WSContextImpl } = (await import(
	resolvePath(REPO, "packages/core/src/ws/contract.ts")
)) as typeof import("../../../src/ws/contract.ts")
const { cfWebSocket } = (await import(
	resolvePath(REPO, "packages/core/src/ws/cloudflare.ts")
)) as typeof import("../../../src/ws/cloudflare.ts")

type Raw = { bufferedAmount: number; closes: [number?, string?][]; readyState: number; sent: unknown[] }
type Adapter = import("../../../src/ws/contract.ts").WSAdapter
type Handler = import("../../../src/ws/contract.ts").WSHandler<unknown>

/** An adapter that opens each upgrade at once over a recording socket, under `limits`. */
function recordingAdapter(limits = { backpressureLimit: 1024, backpressurePolicy: "close" as "close" | "drop" }) {
	const opened: { handler: Handler; raw: Raw; ws: InstanceType<typeof WSContextImpl> }[] = []
	const adapter: Adapter = {
		upgrade(_req, _env, handler) {
			const raw: Raw = { bufferedAmount: 0, closes: [], readyState: 1, sent: [] }
			const socket = {
				get bufferedAmount() {
					return raw.bufferedAmount
				},
				close: (code?: number, reason?: string) => void raw.closes.push([code, reason]),
				readyState: 1,
				send: (data: unknown) => void raw.sent.push(data),
			}
			const ws = new WSContextImpl(socket, limits)
			opened.push({ handler, raw, ws })
			handler.onOpen?.(undefined, ws)
			const response = new Response(null)
			Object.defineProperty(response, "status", { value: 101 })
			return { response, socket: ws }
		},
	}
	return { adapter, opened }
}

const handshake = (path: string, headers: Record<string, string> = {}) =>
	new Request(`https://app.example.com${path}`, {
		headers: { connection: "Upgrade", upgrade: "websocket", ...headers },
	})
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

describe("v1 adversarial: cross-site WebSocket hijacking (H18.12)", () => {
	it.each([
		["another site with a cookie", { cookie: "sid=1", origin: "https://evil.example" }, 403],
		["another site with a bearer token", { authorization: "Bearer t", origin: "https://evil.example" }, 403],
		["the same host over http, against https", { cookie: "sid=1", origin: "http://app.example.com" }, 403],
		["the same host on another port", { cookie: "sid=1", origin: "https://app.example.com:8443" }, 403],
		["an opaque origin", { cookie: "sid=1", origin: "null" }, 403],
		["the same origin", { cookie: "sid=1", origin: "https://app.example.com" }, 101],
		["a non-browser client, no Origin", { cookie: "sid=1" }, 101],
	])("%s: %i, and a refused one never reaches the handler", async (_name, headers, status) => {
		const { adapter, opened } = recordingAdapter()
		const app = honey<{}>().wsAdapter(adapter)
		let opens = 0
		app.ws("/live").handler({ onOpen: () => void opens++ })
		const res = await app.fetch(handshake("/live", headers), {})
		await settle()
		expect([res.status, opened.length, opens]).toEqual(status === 101 ? [101, 1, 1] : [403, 0, 0])
	})
})

describe("v1 adversarial: a client that floods or stops reading", () => {
	it("a handler queue that never drains closes 1008 at 1024 waiting, and the flood never reaches the handler", async () => {
		const { adapter, opened } = recordingAdapter()
		const app = honey<{}>().wsAdapter(adapter)
		let calls = 0
		app.ws("/live").handler({
			onMessage: () => {
				calls++
				return new Promise(() => {})
			},
		})
		await app.fetch(handshake("/live"), {})
		const [conn] = opened
		for (let i = 0; i < 5_000; i++) conn?.handler.onMessage?.(undefined, conn.ws, "m")
		await settle()
		expect([conn?.raw.closes[0], calls]).toEqual([[1008, "too many pending messages"], 1])
	})

	it.each([
		["close", [[1013, "slow consumer"]], []],
		["drop", [], []],
	] as const)("a reader that stopped reading meets the backpressure policy %s", async (policy, closes, sent) => {
		const { adapter, opened } = recordingAdapter({ backpressureLimit: 1024, backpressurePolicy: policy })
		const app = honey<{}>().wsAdapter(adapter)
		app.ws("/live").handler({})
		await app.fetch(handshake("/live"), {})
		const [conn] = opened
		if (conn === undefined) throw new Error("no connection")
		conn.raw.bufferedAmount = 64 * 1024
		conn.ws.send("x".repeat(1024))
		expect([conn.raw.closes, conn.raw.sent]).toEqual([closes, sent])
	})
})

describe("v1 adversarial: an oversized frame", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("a frame over maxPayload closes 1009 before the handler sees a byte of it", async () => {
		/* Workers' socket pair, stubbed: honey's own payload check, the same on any test runtime */
		const server = Object.assign(new EventTarget(), {
			accept() {},
			closes: [] as [number, string][],
			close(code: number, reason: string) {
				server.closes.push([code, reason])
			},
			readyState: 1,
			send() {},
		})
		vi.stubGlobal("WebSocketPair", function WebSocketPair() {
			return [new EventTarget(), server]
		})
		const app = honey<{}>().wsAdapter(cfWebSocket({ maxPayload: 1024 }))
		const seen: unknown[] = []
		app.ws("/live").handler({ onMessage: (_ctx, _ws, data) => void seen.push(data) })
		await app.fetch(handshake("/live"), {})
		server.dispatchEvent(new MessageEvent("message", { data: "x".repeat(4096) }))
		await settle()
		expect([server.closes, seen]).toEqual([[[1009, "message too big"]], []])
	})
})

describe("v1 adversarial: a forged resume token", () => {
	it.each([
		["a path", "/admin/../session"],
		["an identity claim", "user=admin"],
		["a script", "<script>alert(1)</script>"],
	])("%s reaches onReconnect as the data it is: never identity, never routing", async (_name, token) => {
		const { adapter } = recordingAdapter()
		const seen: unknown[] = []
		const app = honey<{}>().wsAdapter(adapter)
		app.ws("/rooms/:room").handler({
			onOpen: () => void seen.push("open"),
			onReconnect: (ctx, _ws, given) => void seen.push([given, ctx.params.room, new URL(ctx.req.url).pathname]),
		})
		const res = await app.fetch(handshake(`/rooms/lobby?reconnect_token=${encodeURIComponent(token)}`), {})
		await settle()
		expect([res.status, seen]).toEqual([101, [[token, "lobby", "/rooms/lobby"]]])
	})
})
