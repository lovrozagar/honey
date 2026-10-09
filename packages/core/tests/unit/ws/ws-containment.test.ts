import { describe, expect, it, vi } from "vitest"
import { honey } from "../../../src/index.ts"
import { createEventQueue, invokeUser } from "../../../src/invoke-user.ts"
import type { WSAdapter, WSHandler } from "../../../src/ws/cloudflare.ts"
import { cfWebSocket, WSContextImpl } from "../../../src/ws/cloudflare.ts"
import { originAllowed, validateOriginPolicy } from "../../../src/ws-origin.ts"

function make101(): Response {
	const r = new Response(null)
	Object.defineProperty(r, "status", { value: 101 })
	return r
}

/** An adapter that upgrades at once and lets the test drive events. */
function testAdapter() {
	const raw = { close: vi.fn(), readyState: 1, send: vi.fn() }
	let handler: WSHandler<unknown> | null = null
	const socket = new WSContextImpl(raw)
	const adapter: WSAdapter = {
		upgrade(_req, _env, h) {
			handler = h
			h.onOpen?.(undefined, socket)
			return { response: make101(), socket }
		},
	}
	return {
		adapter,
		close: (code: number, reason = "") => handler?.onClose?.(undefined, socket, code, reason),
		error: (err: unknown) => handler?.onError?.(undefined, socket, err),
		message: (data: string) => handler?.onMessage?.(undefined, socket, data),
		raw,
	}
}

const upgrade = (path = "/ws", headers: Record<string, string> = {}) =>
	new Request(`http://localhost${path}`, { headers: { connection: "Upgrade", upgrade: "websocket", ...headers } })

const tick = () => new Promise((r) => setTimeout(r, 10))

describe("websocket callbacks run on one ordered, contained queue", () => {
	it("an async onOpen finishes before the first message runs, and close runs last", async () => {
		const t = testAdapter()
		const order: string[] = []
		const app = honey<{}>().wsAdapter(t.adapter)
		app.ws("/ws").handler({
			onClose() {
				order.push("close")
			},
			async onMessage(_c, _ws, data) {
				order.push(`message:${String(data)}`)
			},
			async onOpen() {
				await new Promise((r) => setTimeout(r, 20))
				order.push("open")
			},
		})
		await app.fetch(upgrade(), {})
		t.message("a")
		t.message("b")
		t.close(1000)
		await vi.waitFor(() => expect(order).toEqual(["open", "message:a", "message:b", "close"]))
	})

	it("a rejecting handler goes to onError and the next message still runs", async () => {
		const t = testAdapter()
		const seen: string[] = []
		const errors: unknown[] = []
		const app = honey<{}>().wsAdapter(t.adapter)
		app.ws("/ws").handler({
			onError(_c, _ws, err) {
				errors.push(err)
			},
			async onMessage(_c, _ws, data) {
				if (data === "bad") throw new Error("bad message")
				seen.push(String(data))
			},
		})
		await app.fetch(upgrade(), {})
		t.message("bad")
		t.message("good")
		await vi.waitFor(() => expect(seen).toEqual(["good"]))
		expect(errors).toHaveLength(1)
		expect((errors[0] as Error).message).toBe("bad message")
	})

	it("sync throws in onOpen and onClose never escape, with no onError they are logged", async () => {
		const t = testAdapter()
		const log = vi.spyOn(console, "error").mockImplementation(() => {})
		const app = honey<{}>().wsAdapter(t.adapter)
		app.ws("/ws").handler({
			onClose() {
				throw new Error("close")
			},
			onOpen() {
				throw new Error("open")
			},
		})
		await expect(app.fetch(upgrade(), {})).resolves.toMatchObject({ status: 101 })
		expect(() => t.close(1000)).not.toThrow()
		await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2))
		log.mockRestore()
	})

	it("an onError that throws is logged once and never called again for its own error", async () => {
		const t = testAdapter()
		const log = vi.spyOn(console, "error").mockImplementation(() => {})
		const onError = vi.fn(() => {
			throw new Error("onError fails")
		})
		const seen: string[] = []
		const app = honey<{}>().wsAdapter(t.adapter)
		app.ws("/ws").handler({
			onError,
			async onMessage(_c, _ws, data) {
				if (data === "bad") throw new Error("bad")
				seen.push(String(data))
			},
		})
		await app.fetch(upgrade(), {})
		t.message("bad")
		t.message("next")
		await vi.waitFor(() => expect(seen).toEqual(["next"]))
		expect(onError).toHaveBeenCalledTimes(1)
		expect(log).toHaveBeenCalledTimes(1)
		log.mockRestore()
	})

	it("a transport error reaches onError once; an onError that throws on it is logged", async () => {
		const t = testAdapter()
		const log = vi.spyOn(console, "error").mockImplementation(() => {})
		const onError = vi.fn(() => {
			throw new Error("nope")
		})
		const app = honey<{}>().wsAdapter(t.adapter)
		app.ws("/ws").handler({ onError })
		await app.fetch(upgrade(), {})
		t.error(new Error("socket broke"))
		await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1))
		expect(onError).toHaveBeenCalledTimes(1)
		log.mockRestore()
	})

	it("more than 1024 waiting messages close the connection with 1008", async () => {
		const t = testAdapter()
		let release: () => void = () => {}
		const gate = new Promise<void>((r) => {
			release = r
		})
		const app = honey<{}>().wsAdapter(t.adapter)
		app.ws("/ws").handler({ onMessage: () => gate })
		await app.fetch(upgrade(), {})
		for (let i = 0; i < 1025; i++) t.message("x")
		expect(t.raw.close).toHaveBeenCalledWith(1008, "too many pending messages")
		release()
		await tick()
	})
})

describe("websocket origin policy", () => {
	const app = (policy?: Parameters<ReturnType<ReturnType<typeof honey>["ws"]>["origins"]>[0]) => {
		const t = testAdapter()
		const opened = vi.fn()
		const a = honey<{}>().wsAdapter(t.adapter)
		const route = a.ws("/ws")
		;(policy === undefined ? route : route.origins(policy)).handler({ onOpen: opened })
		return { app: a, opened }
	}

	it("refuses a cross-origin upgrade that carries cookies, before the handler runs", async () => {
		const { app: a, opened } = app()
		const res = await a.fetch(upgrade("/ws", { cookie: "sid=1", origin: "https://evil.example" }), {})
		expect(res.status).toBe(403)
		expect(opened).not.toHaveBeenCalled()
	})

	it("lets same-origin, credential-less and non-browser upgrades through by default", async () => {
		for (const headers of [
			{ cookie: "sid=1", origin: "http://localhost" },
			{ origin: "https://other.example" },
			{ cookie: "sid=1" },
		]) {
			const { app: a, opened } = app()
			expect((await a.fetch(upgrade("/ws", headers), {})).status).toBe(101)
			expect(opened).toHaveBeenCalledTimes(1)
		}
	})

	it("a list allows exactly those origins, with or without credentials", async () => {
		const ok = app(["https://app.example"])
		expect((await ok.app.fetch(upgrade("/ws", { origin: "https://app.example" }), {})).status).toBe(101)
		const no = app(["https://app.example"])
		expect((await no.app.fetch(upgrade("/ws", { origin: "https://evil.example" }), {})).status).toBe(403)
	})

	it('"*" and predicates', async () => {
		const any = app("*")
		expect((await any.app.fetch(upgrade("/ws", { cookie: "a=1", origin: "https://x.example" }), {})).status).toBe(101)
		const pred = app((o) => o.endsWith(".trusted.example"))
		expect(
			(await pred.app.fetch(upgrade("/ws", { cookie: "a=1", origin: "https://a.trusted.example" }), {})).status,
		).toBe(101)
	})

	it("realtime routes take the same policy through allowedOrigins", async () => {
		const t = testAdapter()
		const handler = vi.fn()
		const a = honey<{}>().wsAdapter(t.adapter)
		a.realtime("/rt", { allowedOrigins: ["https://app.example"], handler })
		expect((await a.fetch(upgrade("/rt", { origin: "https://evil.example" }), {})).status).toBe(403)
		expect(handler).not.toHaveBeenCalled()
	})

	it("validates policies at registration", () => {
		expect(() => validateOriginPolicy(["not an origin"])).toThrow(TypeError)
		expect(() => validateOriginPolicy(42)).toThrow(TypeError)
		expect(() =>
			honey<{}>()
				.ws("/ws")
				.origins(["nope"] as never),
		).toThrow(TypeError)
		expect(() => honey<{}>().realtime("/rt", { allowedOrigins: "evil" as never, handler: () => {} })).toThrow(TypeError)
	})

	it("originAllowed compares hosts case-insensitively and never trusts Origin: null", () => {
		expect(originAllowed(null, "http://LOCALHOST:3000", "localhost:3000", true)).toBe(true)
		expect(originAllowed(null, "null", "localhost", true)).toBe(false)
		expect(originAllowed(["null"], "null", "localhost", false)).toBe(true)
	})
})

describe("WSContextImpl", () => {
	it("cuts a close reason to 123 UTF-8 bytes without splitting a character", () => {
		const raw = { close: vi.fn(), readyState: 1, send: vi.fn() }
		new WSContextImpl(raw).close(1000, "é".repeat(100))
		const reason = raw.close.mock.calls[0][1] as string
		expect(new TextEncoder().encode(reason).byteLength).toBeLessThanOrEqual(123)
		expect(reason).toBe("é".repeat(61))
	})

	it("drops sends after the socket closed instead of queueing them forever", () => {
		const raw = { close: vi.fn(), readyState: 3, send: vi.fn() }
		const ws = new WSContextImpl(raw)
		ws.send("late")
		raw.readyState = 1
		ws.flush()
		expect(raw.send).not.toHaveBeenCalled()
	})

	it("over the backpressure limit: closes with 1013, or drops", () => {
		const slow = { bufferedAmount: 10_000, close: vi.fn(), readyState: 1, send: vi.fn() }
		new WSContextImpl(slow, { backpressureLimit: 1000, backpressurePolicy: "close" }).send("x")
		expect(slow.send).not.toHaveBeenCalled()
		expect(slow.close).toHaveBeenCalledWith(1013, "slow consumer")

		const dropping = { bufferedAmount: 10_000, close: vi.fn(), readyState: 1, send: vi.fn() }
		new WSContextImpl(dropping, { backpressureLimit: 1000, backpressurePolicy: "drop" }).send("x")
		expect(dropping.send).not.toHaveBeenCalled()
		expect(dropping.close).not.toHaveBeenCalled()

		/* Bun reports it through getBufferedAmount() */
		const bun = { close: vi.fn(), getBufferedAmount: () => 0, readyState: 1, send: vi.fn() }
		new WSContextImpl(bun, { backpressureLimit: 1000, backpressurePolicy: "close" }).send("x")
		expect(bun.send).toHaveBeenCalledWith("x")
	})
})

describe("cfWebSocket", () => {
	class FakeCF {
		listeners: Record<string, Array<(e: unknown) => void>> = {}
		close = vi.fn()
		readyState = 1
		send = vi.fn()
		accept() {}
		addEventListener(type: string, fn: (e: unknown) => void) {
			;(this.listeners[type] ??= []).push(fn)
		}
		emit(type: string, e: unknown) {
			for (const fn of this.listeners[type] ?? []) fn(e)
		}
	}

	/** Install a WebSocketPair for one upgrade; returns the server half. */
	function upgradeWith(adapter: WSAdapter, req: Request, handler: WSHandler<unknown>) {
		const g = globalThis as Record<string, unknown>
		const server = new FakeCF()
		g.WebSocketPair = class {
			constructor() {
				return [new FakeCF(), server] as never
			}
		}
		/* Workers' Response takes 101; Node's does not */
		const Real = globalThis.Response
		globalThis.Response = class extends Real {
			constructor(body?: BodyInit | null, init?: ResponseInit) {
				super(body, { ...init, status: init?.status === 101 ? 200 : init?.status })
				if (init?.status === 101) Object.defineProperty(this, "status", { value: 101 })
			}
		} as typeof Response
		try {
			const { response } = adapter.upgrade(req, {}, handler) as { response: Response }
			return { response, server }
		} finally {
			globalThis.Response = Real
			delete g.WebSocketPair
		}
	}

	it("echoes a 1005 close as 1000, since 1005 can never be sent", () => {
		const { server } = upgradeWith(cfWebSocket(), new Request("http://x/ws"), {})
		server.emit("close", { code: 1005, reason: "" })
		expect(server.close).toHaveBeenCalledWith(1000, "")
	})

	it("answers with the chosen subprotocol and enforces maxPayload", () => {
		const onMessage = vi.fn()
		const req = new Request("http://x/ws", { headers: { "sec-websocket-protocol": "v2, v1" } })
		const { response, server } = upgradeWith(cfWebSocket({ maxPayload: 3 }), req, { onMessage })
		expect(response.headers.get("sec-websocket-protocol")).toBe("v2")
		server.emit("message", { data: "1234" })
		expect(onMessage).not.toHaveBeenCalled()
		expect(server.close).toHaveBeenCalledWith(1009, "message too big")
	})
})

describe("invokeUser", () => {
	it("resolves true on success and false on a throw or rejection, never rejecting", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {})
		expect(await invokeUser(() => 1, { phase: "t" })).toBe(true)
		expect(await invokeUser(() => Promise.resolve(), { phase: "t" })).toBe(true)
		expect(
			await invokeUser(
				() => {
					throw new Error("x")
				},
				{ phase: "t" },
			),
		).toBe(false)
		expect(await invokeUser(() => Promise.reject(new Error("y")), { phase: "t" })).toBe(false)
		expect(log).toHaveBeenCalledTimes(2)
		log.mockRestore()
	})

	it("uses the app logger when given one, and survives a logger that throws", async () => {
		const error = vi.fn(() => {
			throw new Error("broken logger")
		})
		const log = vi.spyOn(console, "error").mockImplementation(() => {})
		await invokeUser(() => Promise.reject(new Error("z")), { log: { error }, phase: "t" })
		expect(error).toHaveBeenCalledTimes(1)
		expect(log).toHaveBeenCalledTimes(1)
		log.mockRestore()
	})

	it("an ordered queue runs tasks one after another and keeps going after a failure", async () => {
		const q = createEventQueue()
		const order: number[] = []
		void q.push(async () => {
			await tick()
			order.push(1)
		})
		void q.push(() => Promise.reject(new Error("fails")))
		await q.push(async () => {
			order.push(3)
		})
		expect(order).toEqual([1, 3])
	})
})
