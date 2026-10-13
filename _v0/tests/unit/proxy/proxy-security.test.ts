import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"
import { setPeerAddress } from "../../../src/peer.ts"
import { timeout } from "../../../src/timeout.ts"
import "../../../src/proxy.ts"
import "../../../src/trust.ts"

/**
 * proxy() regressions, from reverse-proxy advisories (hono, elysia, node-http-proxy, nginx):
 * hop-by-hop smuggling through `Connection`, spoofed forwarding headers, Host forwarding,
 * encoding headers that lie about the body, timeouts that cut streams, user bugs reported as
 * upstream failures. The destination is a fake; proxy-upstream.test.ts runs a real upstream.
 */

type Seen = { headers: Record<string, string>; init: RequestInit; url: string }

function proxyApp(
	respond: (seen: Seen) => Response | Promise<Response> = () => new Response("ok"),
	extra: Record<string, unknown> = {},
) {
	const calls: Seen[] = []
	const app = honey()
	app.all("/api/*rest").proxy({
		destination: (_ctx, url, init) => {
			const seen = { headers: Object.fromEntries(new Headers(init.headers).entries()), init, url }
			calls.push(seen)
			return respond(seen)
		},
		...extra,
	})
	return { app, calls }
}

const req = (path: string, init: RequestInit = {}) => new Request(`http://app.test${path}`, init)

describe("proxy: request headers", () => {
	it("drops hop-by-hop headers and every header Connection names", async () => {
		const { app, calls } = proxyApp()
		await app.fetch(
			req("/api/x", {
				headers: {
					connection: "keep-alive, X-Internal-Auth, x-other",
					"keep-alive": "timeout=5",
					"proxy-authorization": "Basic Zm9vOmJhcg==",
					"proxy-connection": "keep-alive",
					te: "trailers",
					trailer: "x-t",
					upgrade: "h2c",
					"x-internal-auth": "admin",
					"x-other": "1",
					"x-kept": "yes",
				},
			}),
		)
		const h = calls[0].headers
		for (const name of [
			"connection",
			"keep-alive",
			"proxy-authorization",
			"proxy-connection",
			"te",
			"trailer",
			"upgrade",
			"x-internal-auth",
			"x-other",
		]) {
			expect(h[name], name).toBeUndefined()
		}
		expect(h["x-kept"]).toBe("yes")
	})

	it("never forwards the client's Host or Expect", async () => {
		const { app, calls } = proxyApp()
		await app.fetch(req("/api/x", { body: "x", headers: { expect: "100-continue" }, method: "POST" }))
		expect(calls[0].headers.host).toBeUndefined()
		expect(calls[0].headers.expect).toBeUndefined()
		expect(calls[0].headers["x-forwarded-host"]).toBe("app.test")
	})

	it("replaces spoofed forwarding headers with what trustProxy decided", async () => {
		const { app, calls } = proxyApp()
		const r = req("/api/x", {
			headers: {
				forwarded: "for=6.6.6.6",
				"x-forwarded-for": "6.6.6.6",
				"x-forwarded-host": "evil.example",
				"x-forwarded-proto": "https",
				"x-real-ip": "6.6.6.6",
			},
		})
		setPeerAddress(r, "203.0.113.9")
		await app.fetch(r)
		const h = calls[0].headers
		expect(h["x-forwarded-for"]).toBe("203.0.113.9")
		expect(h["x-forwarded-host"]).toBe("app.test")
		expect(h["x-forwarded-proto"]).toBe("http")
		expect(h.forwarded).toBeUndefined()
		expect(h["x-real-ip"]).toBeUndefined()
	})

	it("with trustProxy, forwards the client the trusted hops reported", async () => {
		const { app, calls } = proxyApp()
		app.trustProxy(1)
		const r = req("/api/x", { headers: { "x-forwarded-for": "6.6.6.6, 198.51.100.4", "x-forwarded-proto": "https" } })
		setPeerAddress(r, "10.0.0.1")
		await app.fetch(r)
		expect(calls[0].headers["x-forwarded-for"]).toBe("198.51.100.4")
		expect(calls[0].headers["x-forwarded-proto"]).toBe("https")
	})

	it("forwardedHeaders: false adds none, and still drops the client's", async () => {
		const { app, calls } = proxyApp(undefined, { forwardedHeaders: false })
		await app.fetch(req("/api/x", { headers: { "x-forwarded-for": "6.6.6.6" } }))
		expect(calls[0].headers["x-forwarded-for"]).toBeUndefined()
		expect(calls[0].headers["x-forwarded-host"]).toBeUndefined()
	})

	it("requestHeaders runs last and can set anything", async () => {
		const { app, calls } = proxyApp(undefined, { requestHeaders: { host: "internal.svc", "x-forwarded-for": "x" } })
		await app.fetch(req("/api/x"))
		expect(calls[0].headers["x-forwarded-for"]).toBe("x")
	})
})

describe("proxy: bodies", () => {
	for (const method of ["DELETE", "OPTIONS", "PROPFIND", "PATCH"]) {
		it(`${method} forwards its body`, async () => {
			const { app, calls } = proxyApp(
				async (s) => new Response(s.init.body ? await new Response(s.init.body).text() : ""),
			)
			const res = await app.fetch(
				req("/api/x", { body: '{"ids":[1]}', headers: { "content-type": "application/json" }, method }),
			)
			expect(await res.text()).toBe('{"ids":[1]}')
			expect(calls[0].init.method).toBe(method)
		})
	}

	it("GET never forwards a body or a stale content-length", async () => {
		const { app, calls } = proxyApp()
		await app.fetch(req("/api/x", { headers: { "content-length": "11" } }))
		expect(calls[0].init.body).toBeUndefined()
		expect(calls[0].headers["content-length"]).toBeUndefined()
	})
})

describe("proxy: response headers", () => {
	it("drops hop-by-hop and Connection-named headers, keeps every Set-Cookie", async () => {
		const { app } = proxyApp(() => {
			const h = new Headers({
				connection: "close, x-hop",
				"keep-alive": "timeout=9",
				"transfer-encoding": "chunked",
				"x-hop": "secret",
			})
			h.append("set-cookie", "a=1")
			h.append("set-cookie", "b=2")
			return new Response("ok", { headers: h })
		})
		const res = await app.fetch(req("/api/x"))
		expect(res.headers.get("transfer-encoding")).toBeNull()
		expect(res.headers.get("keep-alive")).toBeNull()
		expect(res.headers.get("connection")).toBeNull()
		expect(res.headers.get("x-hop")).toBeNull()
		expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"])
	})

	it("a decoded body loses the encoding headers that described the encoded one", async () => {
		const { app } = proxyApp(
			() =>
				new Response("decoded text", {
					headers: { "content-encoding": "gzip", "content-length": "7", "content-type": "text/plain" },
				}),
		)
		const res = await app.fetch(req("/api/x"))
		expect(res.headers.get("content-encoding")).toBeNull()
		expect(res.headers.get("content-length")).not.toBe("7")
		expect(await res.text()).toBe("decoded text")
	})

	it("decoded: false passes encoded bytes and their headers through", async () => {
		const { app } = proxyApp(
			() => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-encoding": "br", "content-length": "3" } }),
			{ decoded: false },
		)
		const res = await app.fetch(req("/api/x"))
		expect(res.headers.get("content-encoding")).toBe("br")
	})

	it("onResponse can set headers on an immutable upstream response", async () => {
		const app = honey()
		app.all("/api/*rest").proxy({
			destination: () => Response.redirect("http://up.test/elsewhere", 302),
			onResponse: (_ctx, response) => {
				response.headers.set("x-proxied", "1")
			},
		})
		const res = await app.fetch(req("/api/x"))
		expect(res.status).toBe(302)
		expect(res.headers.get("x-proxied")).toBe("1")
		expect(res.headers.get("location")).toBe("http://up.test/elsewhere")
	})

	it("a 204 or 304 upstream response stays bodiless", async () => {
		const { app } = proxyApp(() => new Response(null, { status: 304 }))
		const res = await app.fetch(req("/api/x"))
		expect(res.status).toBe(304)
		expect(res.body).toBeNull()
	})
})

describe("proxy: WebSocket upgrades", () => {
	it("detects the upgrade case-insensitively and keeps Upgrade/Connection", async () => {
		const { app, calls } = proxyApp(() => new Response(null, { status: 200 }), { timeout: 1 })
		await app.fetch(req("/api/ws", { headers: { connection: "Upgrade", upgrade: "WebSocket" } }))
		expect(calls[0].headers.upgrade).toBe("websocket")
		expect(calls[0].headers.connection).toBe("upgrade")
		/* no header timeout armed for an upgrade */
		await new Promise((r) => setTimeout(r, 10))
		expect(calls[0].init.signal?.aborted).toBe(false)
	})
})

describe("proxy: failures", () => {
	it("a bug in destination is a 500, not a 502", async () => {
		const app = honey()
		app.all("/api/*rest").proxy({
			destination: () => {
				const env = undefined as unknown as { SVC: { fetch(): Response } }
				return env.SVC.fetch()
			},
		})
		expect((await app.fetch(req("/api/x"))).status).toBe(500)
	})

	it("an invalid upstream URL is a 500", async () => {
		const app = honey()
		app.all("/api/*rest").proxy({ destination: (_c, url, init) => fetch(`http://[::1${url}`, init) })
		expect((await app.fetch(req("/api/x"))).status).toBe(500)
	})

	it("network failures are 502, whatever the runtime calls them", async () => {
		const shapes = [
			Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
			Object.assign(new TypeError("Unable to connect. Is the computer able to access the url?"), {
				code: "ConnectionRefused",
			}),
			Object.assign(new TypeError("getaddrinfo ENOTFOUND x"), { code: "ENOTFOUND" }),
			new TypeError("Network connection lost."),
		]
		for (const error of shapes) {
			const app = honey()
			app.all("/api/*rest").proxy({
				destination: () => {
					throw error
				},
			})
			expect((await app.fetch(req("/api/x"))).status, error.message).toBe(502)
		}
	})

	it("a real connection refused is a 502", async () => {
		const app = honey()
		app.all("/api/*rest").proxy({ destination: (_c, url, init) => fetch(`http://127.0.0.1:9${url}`, init) })
		expect((await app.fetch(req("/api/x"))).status).toBe(502)
	})

	it("no headers within timeout is a 504, and the upstream call is aborted", async () => {
		let aborted = false
		const app = honey()
		app.all("/api/*rest").proxy({
			destination: (_c, _u, init) =>
				new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => {
						aborted = true
						reject(init.signal?.reason)
					})
				}),
			timeout: 20,
		})
		expect((await app.fetch(req("/api/x"))).status).toBe(504)
		expect(aborted).toBe(true)
	})

	it("the header timeout does not cover the body", async () => {
		const { app } = proxyApp(
			() =>
				new Response(
					new ReadableStream({
						async start(c) {
							for (let i = 0; i < 4; i++) {
								c.enqueue(new TextEncoder().encode(`${i}`))
								await new Promise((r) => setTimeout(r, 15))
							}
							c.close()
						},
					}),
				),
			{ timeout: 20 },
		)
		const res = await app.fetch(req("/api/x"))
		expect(await res.text()).toBe("0123")
	})

	it("idleTimeout errors a stalled body and aborts the upstream", async () => {
		let upstreamSignal: AbortSignal | undefined
		const { app } = proxyApp(
			(s) => {
				upstreamSignal = s.init.signal ?? undefined
				return new Response(
					new ReadableStream({
						start(c) {
							c.enqueue(new TextEncoder().encode("first"))
						},
					}),
				)
			},
			{ idleTimeout: 20 },
		)
		const res = await app.fetch(req("/api/x"))
		await expect(res.text()).rejects.toThrow()
		expect(upstreamSignal?.aborted).toBe(true)
	})

	it("ctx.signal (timeout(), disconnect, shutdown) cancels the upstream call", async () => {
		let aborted = false
		const app = honey()
		app
			.all("/api/*rest")
			.use(timeout({ duration: 20 }))
			.proxy({
				destination: (_c, _u, init) =>
					new Promise<Response>((_resolve, reject) => {
						init.signal?.addEventListener("abort", () => {
							aborted = true
							reject(init.signal?.reason)
						})
					}),
				timeout: 0,
			})
		const res = await app.fetch(req("/api/x"))
		expect(res.status).toBe(504)
		await new Promise((r) => setTimeout(r, 5))
		expect(aborted).toBe(true)
	})
})

describe("proxy: URL", () => {
	it("forwards the normalized path and the raw query", async () => {
		const { app, calls } = proxyApp()
		await app.fetch(req("/api/a/../b//c?x=1&y=%2F"))
		expect(calls[0].url).toBe("/api/b/c?x=1&y=%2F")
	})
})
