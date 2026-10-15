import { describe, expect, it, vi } from "vitest"
import { timeout } from "../middleware/timeout.ts"
import { honey } from "../routing/app.ts"
import { proxy, type ProxyConfig } from "./proxy.ts"

type Seen = { init: RequestInit; url: string }

/** /api/* proxied to a fake destination that records what it was handed. */
function proxyApp(
	respond: (seen: Seen) => Response | Promise<Response> = () => new Response("ok"),
	extra: Partial<ProxyConfig<unknown>> = {},
) {
	const calls: Seen[] = []
	const app = honey<{}>()
	app.all("/api/*rest").handler(
		proxy({
			destination: (_ctx, url, init) => {
				const seen = { init, url }
				calls.push(seen)
				return respond(seen)
			},
			...extra,
		}),
	)
	return { app, calls }
}

/** A destination that answers only when its signal aborts: then it rejects with the reason. */
function hanging(record: { aborted: boolean }) {
	return (_ctx: unknown, _url: string, init: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			init.signal?.addEventListener("abort", () => {
				record.aborted = true
				reject(init.signal?.reason)
			})
		})
}

const req = (path: string, init: RequestInit = {}) => new Request(`http://app.test${path}`, init)

/** A request whose url is the raw target, as a runtime that does not normalize it hands it over. */
function rawRequest(path: string): Request {
	const request = new Request("http://app.test/")
	Object.defineProperty(request, "url", { value: `http://app.test${path}` })
	return request
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("proxy: the URL destination is handed", () => {
	// v0: c2425c00b2
	// v0: fd1f990356
	it("the normalized path the router matched, and the raw query", async () => {
		const { app, calls } = proxyApp()
		await app.fetch(req("/api/a/../b//c?x=1&y=%2F"), {})
		await app.fetch(req("/api/users?page=2"), {})
		expect(calls.map((call) => call.url)).toEqual(["/api/b/c?x=1&y=%2F", "/api/users?page=2"])
	})

	// v0: 8ae91bbefc
	// v0: c93bfb2b29
	it("a doubled slash or a backslash never makes it a protocol-relative URL", async () => {
		const { app, calls } = proxyApp((seen) => new Response(seen.url))
		await app.fetch(rawRequest("/api//evil.example/x?q=1"), {})
		await app.fetch(rawRequest("/api/\\evil.example/x"), {})
		expect(calls.map((call) => call.url)).toEqual(["/api/evil.example/x?q=1", "/api/evil.example/x"])
	})

	// v0: 910dc1bfea
	it("dot segments resolve before routing: one that climbs out of the proxied prefix never reaches it", async () => {
		const { app, calls } = proxyApp()
		const res = await app.fetch(rawRequest("/api/files/../../admin/secret"), {})
		expect([res.status, calls.length]).toEqual([404, 0])
	})

	// v0: 364f5829a7
	it("an encoded separator is a 400 before the proxy runs", async () => {
		const { app, calls } = proxyApp()
		const statuses = []
		for (const path of ["/api/..%2f..%2fadmin", "/api/a%5c..%5cadmin"])
			statuses.push((await app.fetch(rawRequest(path), {})).status)
		expect([statuses, calls.length]).toEqual([[400, 400], 0])
	})
})

describe("proxy: the body destination is handed", () => {
	// v0: 249a188eb7
	// v0: 1d738d3692
	// v0: 6b3d8b6bc0
	it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "PROPFIND"])("%s forwards its body", async (method) => {
		const { app, calls } = proxyApp(
			async (seen) => new Response(seen.init.body ? await new Response(seen.init.body).text() : ""),
		)
		const res = await app.fetch(
			req("/api/x", { body: '{"ids":[1]}', headers: { "content-type": "application/json" }, method }),
			{},
		)
		expect([await res.text(), calls[0]?.init.method]).toEqual(['{"ids":[1]}', method])
	})

	// v0: 6c47c0f41a
	// v0: 6381675843
	it("GET and HEAD never forward a body or a stale Content-Length", async () => {
		const { app, calls } = proxyApp()
		await app.fetch(req("/api/x", { headers: { "content-length": "11" } }), {})
		await app.fetch(req("/api/x", { method: "HEAD" }), {})
		const sent = calls.map((call) => [call.init.body, new Headers(call.init.headers).get("content-length")])
		expect(sent).toEqual([
			[undefined, null],
			[undefined, null],
		])
	})

	// v0: 997ddde7ff
	it("a small body with a declared length goes as bytes, even when a middleware cloned the request", async () => {
		const { app, calls } = proxyApp()
		const request = req("/api/x", { body: "{}", headers: { "content-length": "2" }, method: "POST" })
		request.clone()
		await app.fetch(request, {})
		const init = calls[0]?.init as RequestInit & { duplex?: string }
		expect([init.body instanceof ArrayBuffer, init.duplex, new Headers(init.headers).get("content-length")]).toEqual([
			true,
			undefined,
			null,
		])
	})

	// v0: 2f6368c7a7
	// v0: e32ec4b0bb
	it("an unsized or large body streams, half-duplex, its length passed on", async () => {
		const { app, calls } = proxyApp()
		const big = "x".repeat(1024 * 1024 + 1)
		await app.fetch(req("/api/x", { body: big, headers: { "content-length": String(big.length) }, method: "POST" }), {})
		const init = calls[0]?.init as RequestInit & { duplex?: string }
		expect([init.body instanceof ReadableStream, init.duplex, new Headers(init.headers).get("content-length")]).toEqual(
			[true, "half", String(big.length)],
		)
	})
})

describe("proxy: the header timeout", () => {
	// v0: 86fac146ff
	// v0: a786b6a875
	it("no response headers within the timeout: 504 gateway_timeout, and the upstream call is aborted", async () => {
		const record = { aborted: false }
		const app = honey<{}>()
		app.all("/api/*rest").handler(proxy({ destination: hanging(record), timeout: 20 }))
		const res = await app.fetch(req("/api/x"), {})
		expect([res.status, ((await res.json()) as { error_key: string }).error_key, record.aborted]).toEqual([
			504,
			"gateway_timeout",
			true,
		])
	})

	it("a destination's own TimeoutError is a 504 too", async () => {
		const { app } = proxyApp(() => {
			throw new DOMException("timed out", "TimeoutError")
		})
		expect((await app.fetch(req("/api/x"), {})).status).toBe(504)
	})

	// v0: eddea90383
	// v0: 3eb4482e39
	it("timeout may be a function of ctx", async () => {
		const seen: unknown[] = []
		const record = { aborted: false }
		const app = honey<{}>()
		app.all("/api/*rest").handler(
			proxy({
				destination: hanging(record),
				timeout: (ctx: { path: string }) => {
					seen.push(ctx.path)
					return 20
				},
			}),
		)
		expect([(await app.fetch(req("/api/slow"), {})).status, seen]).toEqual([504, ["/api/slow"]])
	})

	// v0: 9f6efaf819
	it("a non-positive timeout never aborts", async () => {
		const { app } = proxyApp(
			async (seen) => {
				await wait(20)
				return new Response(seen.init.signal?.aborted ? "aborted" : "alive")
			},
			{ timeout: 0 },
		)
		expect(await (await app.fetch(req("/api/x"), {})).text()).toBe("alive")
	})
})

describe("proxy: the idle timeout", () => {
	// v0: b45b61a112
	// v0: 279a949ae6
	it("the header timeout does not cover the body", async () => {
		const { app } = proxyApp(
			() =>
				new Response(
					new ReadableStream({
						async start(controller) {
							for (let i = 0; i < 4; i++) {
								controller.enqueue(new TextEncoder().encode(`${i}`))
								await wait(15)
							}
							controller.close()
						},
					}),
				),
			{ timeout: 20 },
		)
		expect(await (await app.fetch(req("/api/x"), {})).text()).toBe("0123")
	})

	// v0: 8c3d948ede
	it("idleTimeout errors a stalled body and aborts the upstream", async () => {
		let upstream: AbortSignal | undefined
		const { app } = proxyApp(
			(seen) => {
				upstream = seen.init.signal ?? undefined
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("first"))
						},
					}),
				)
			},
			{ idleTimeout: 20 },
		)
		const res = await app.fetch(req("/api/x"), {})
		await expect(res.text()).rejects.toThrow()
		expect(upstream?.aborted).toBe(true)
	})
})

describe("proxy: a body the client cancels or the upstream stalls", () => {
	it("a client that cancels the body cancels the upstream's under idleTimeout too", async () => {
		let cancelled: unknown
		const { app } = proxyApp(
			() =>
				new Response(
					new ReadableStream({
						cancel(reason) {
							cancelled = reason
						},
						start(controller) {
							controller.enqueue(new TextEncoder().encode("first"))
						},
					}),
				),
			{ idleTimeout: 1000 },
		)
		const res = await app.fetch(req("/api/x"), {})
		await res.body?.cancel("client gone")
		expect(cancelled).toBe("client gone")
	})

	it("an upstream whose cancel rejects still has its stalled body errored", async () => {
		const { app } = proxyApp(
			() =>
				new Response(
					new ReadableStream({
						cancel() {
							return Promise.reject(new Error("binding will not cancel"))
						},
						start(controller) {
							controller.enqueue(new TextEncoder().encode("first"))
						},
					}),
				),
			{ idleTimeout: 20 },
		)
		const res = await app.fetch(req("/api/x"), {})
		await expect(res.text()).rejects.toThrow("upstream timed out")
	})
})

describe("proxy: when the idle clock runs", () => {
	it("idleTimeout counts only while a read waits: a slow reader is backpressure, not an idle upstream", async () => {
		const { app } = proxyApp(
			() =>
				new Response(
					new ReadableStream({
						pull(controller) {
							controller.enqueue(new TextEncoder().encode("x"))
							controller.close()
						},
					}),
				),
			{ idleTimeout: 10 },
		)
		const res = await app.fetch(req("/api/x"), {})
		await wait(40)
		expect(await res.text()).toBe("x")
	})
})

describe("proxy: signals", () => {
	it("a WebSocket upgrade arms neither timeout", async () => {
		const { app, calls } = proxyApp(() => new Response(null, { status: 200 }), { idleTimeout: 1, timeout: 1 })
		await app.fetch(req("/api/ws", { headers: { connection: "upgrade", upgrade: "websocket" } }), {})
		await wait(10)
		expect(calls[0]?.init.signal?.aborted).toBe(false)
	})

	// v0: 8aa66ae6eb
	it("ctx.signal (timeout(), a disconnect, shutdown) cancels the upstream call", async () => {
		const record = { aborted: false }
		const app = honey<{}>()
		app
			.all("/api/*rest")
			.use(timeout({ duration: 20 }))
			.handler(proxy({ destination: hanging(record), timeout: 0 }))
		const res = await app.fetch(req("/api/x"), {})
		await wait(5)
		expect([res.status, record.aborted]).toEqual([504, true])
	})

	// v0: def4c77871
	it("destination always gets a live signal that follows the request", async () => {
		const { app, calls } = proxyApp()
		await app.fetch(req("/api/x"), {})
		expect([calls[0]?.init.signal instanceof AbortSignal, calls[0]?.init.signal?.aborted]).toEqual([true, false])
	})
})

describe("proxy: a network failure is a 502", () => {
	// v0: bc2d554930
	// v0: 38d54f7455
	it.each([
		["undici", Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })],
		[
			"Bun",
			Object.assign(new TypeError("Unable to connect. Is the computer able to access the url?"), {
				code: "ConnectionRefused",
			}),
		],
		["a DNS failure", Object.assign(new TypeError("getaddrinfo ENOTFOUND x"), { code: "ENOTFOUND" })],
		["Workers", new TypeError("Network connection lost.")],
	])("a network failure as %s reports it: 502 bad_gateway", async (_name, error) => {
		const { app } = proxyApp(() => {
			throw error
		})
		const res = await app.fetch(req("/api/x"), {})
		expect([res.status, ((await res.json()) as { error_key: string }).error_key]).toEqual([502, "bad_gateway"])
	})

	// v0: f092b2ffb5
	it("a real connection refused is a 502", async () => {
		const app = honey<{}>()
		app.all("/api/*rest").handler(proxy({ destination: (_ctx, url, init) => fetch(`http://127.0.0.1:9${url}`, init) }))
		expect((await app.fetch(req("/api/x"), {})).status).toBe(502)
	})
})

describe("proxy: any other throw is a 500", () => {
	// v0: 1e4250179a
	it("a bug in destination is a 500, not a 502", async () => {
		const { app } = proxyApp(() => {
			const env = undefined as unknown as { SVC: { fetch(): Response } }
			return env.SVC.fetch()
		})
		expect((await app.fetch(req("/api/x"), {})).status).toBe(500)
	})

	// v0: 8779dcba63
	it("an invalid upstream URL is the destination's bug: a 500", async () => {
		const app = honey<{}>()
		app.all("/api/*rest").handler(proxy({ destination: (_ctx, url, init) => fetch(`http://[::1${url}`, init) }))
		expect((await app.fetch(req("/api/x"), {})).status).toBe(500)
	})

	it.each([
		["a non-Error throw", "boom"],
		["an invalid-URL code", Object.assign(new TypeError("bad"), { code: "ERR_INVALID_URL" })],
		["a TypeError of user code", new TypeError("x is not a function")],
	])("%s is a 500", async (_name, thrown) => {
		const { app } = proxyApp(() => {
			throw thrown
		})
		expect((await app.fetch(req("/api/x"), {})).status).toBe(500)
	})

	it("a client that went away: the destination's abort is not reported as a 502", async () => {
		const controller = new AbortController()
		const destination = vi.fn((_ctx: unknown, _url: string, init: RequestInit) => {
			controller.abort()
			throw Object.assign(new TypeError("fetch failed"), { cause: init.signal?.reason })
		})
		const app = honey<{}>()
		app.all("/api/*rest").handler(proxy({ destination }))
		const res = await app.fetch(req("/api/x", { signal: controller.signal }), {})
		expect(res.status).not.toBe(502)
	})
})
