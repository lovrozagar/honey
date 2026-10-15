import { describe, expect, it } from "vitest"
import { PEER_ADDRESS } from "../context/peer.ts"
import { honey } from "../routing/app.ts"
import { proxy, type ProxyConfig } from "./proxy.ts"

type Seen = { headers: Record<string, string>; init: RequestInit; url: string }

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
				const seen = { headers: Object.fromEntries(new Headers(init.headers).entries()), init, url }
				calls.push(seen)
				return respond(seen)
			},
			...extra,
		}),
	)
	return { app, calls }
}

function req(path: string, init: RequestInit & { peer?: string } = {}): Request {
	const { peer, ...rest } = init
	const request = new Request(`http://app.test${path}`, rest)
	if (peer !== undefined) Object.defineProperty(request, PEER_ADDRESS, { value: peer })
	return request
}

describe("proxy: what the upstream is sent", () => {
	// v0: c2ce3758b8
	// v0: 58d05a1a43
	it("no hop-by-hop header, and no header Connection names", async () => {
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
					"transfer-encoding": "chunked",
					upgrade: "h2c",
					"x-internal-auth": "admin",
					"x-kept": "yes",
					"x-other": "1",
				},
			}),
			{},
		)
		expect(calls[0]?.headers).toEqual({ "x-forwarded-host": "app.test", "x-forwarded-proto": "http", "x-kept": "yes" })
	})

	// v0: 9df55fa30f
	it("never the client's Host or Expect", async () => {
		const { app, calls } = proxyApp()
		await app.fetch(
			req("/api/x", { body: "x", headers: { expect: "100-continue", host: "evil.example" }, method: "POST" }),
			{},
		)
		expect([calls[0]?.headers.host, calls[0]?.headers.expect]).toEqual([undefined, undefined])
	})

	// v0: 70f86e44bd
	// v0: 7f2b5465a1
	it("a WebSocket upgrade, however the client spells it, keeps Upgrade: websocket and Connection: upgrade", async () => {
		const { app, calls } = proxyApp(() => new Response(null, { status: 200 }))
		await app.fetch(req("/api/ws", { headers: { connection: "Upgrade", upgrade: "WebSocket" } }), {})
		expect([calls[0]?.headers.upgrade, calls[0]?.headers.connection]).toEqual(["websocket", "upgrade"])
	})
})

describe("proxy: the forwarding headers describe the client as the platform reported it (H23)", () => {
	it("X-Forwarded-For is ctx.ip; -Proto and -Host are the request URL's", async () => {
		const { app, calls } = proxyApp()
		await app.fetch(req("/api/x", { peer: "203.0.113.9" }), {})
		expect(calls[0]?.headers).toEqual({
			"x-forwarded-for": "203.0.113.9",
			"x-forwarded-host": "app.test",
			"x-forwarded-proto": "http",
		})
	})

	it("whatever forwarding headers the client sent are dropped, not passed on", async () => {
		const { app, calls } = proxyApp()
		await app.fetch(
			req("/api/x", {
				headers: {
					forwarded: "for=6.6.6.6",
					"x-forwarded-for": "6.6.6.6",
					"x-forwarded-host": "evil.example",
					"x-forwarded-port": "1",
					"x-forwarded-proto": "https",
					"x-real-ip": "6.6.6.6",
				},
				peer: "203.0.113.9",
			}),
			{},
		)
		expect(calls[0]?.headers).toEqual({
			"x-forwarded-for": "203.0.113.9",
			"x-forwarded-host": "app.test",
			"x-forwarded-proto": "http",
		})
	})

	it("no peer reported: no X-Forwarded-For at all", async () => {
		const { app, calls } = proxyApp()
		await app.fetch(req("/api/x", { headers: { "x-forwarded-for": "6.6.6.6" } }), {})
		expect(calls[0]?.headers["x-forwarded-for"]).toBeUndefined()
	})

	it("CF-Connecting-IP passes through untouched, so a service-bound Worker sees the same client", async () => {
		const { app, calls } = proxyApp()
		await app.fetch(req("/api/x", { headers: { "cf-connecting-ip": "198.51.100.4" } }), {})
		expect(calls[0]?.headers["cf-connecting-ip"]).toBe("198.51.100.4")
	})

	// v0: 54b74ee5d4
	it("forwardedHeaders: false adds none, and still drops the client's", async () => {
		const { app, calls } = proxyApp(undefined, { forwardedHeaders: false })
		await app.fetch(req("/api/x", { headers: { "x-forwarded-for": "6.6.6.6" }, peer: "203.0.113.9" }), {})
		expect(calls[0]?.headers).toEqual({})
	})

	// v0: 97b9b8264f
	it("requestHeaders runs last and can set anything", async () => {
		const { app, calls } = proxyApp(undefined, { requestHeaders: { host: "internal.svc", "x-forwarded-for": "x" } })
		await app.fetch(req("/api/x", { peer: "203.0.113.9" }), {})
		expect([calls[0]?.headers["x-forwarded-for"], calls[0]?.headers.host]).toEqual(["x", "internal.svc"])
	})
})

describe("proxy: what the client gets back", () => {
	// v0: e4d75ab7c0
	it("no hop-by-hop or Connection-named header, and every Set-Cookie kept", async () => {
		const { app } = proxyApp(() => {
			const headers = new Headers({
				connection: "close, x-hop",
				"keep-alive": "timeout=9",
				"transfer-encoding": "chunked",
				"x-hop": "secret",
				"x-kept": "1",
			})
			headers.append("set-cookie", "a=1")
			headers.append("set-cookie", "b=2")
			return new Response("ok", { headers })
		})
		const res = await app.fetch(req("/api/x"), {})
		expect([...new Set(res.headers.keys())].filter((name) => name !== "content-type")).toEqual(["set-cookie", "x-kept"])
		expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"])
	})

	// v0: 36f4b37ea9
	it("a decoded body loses the encoding headers that described the encoded one", async () => {
		const { app } = proxyApp(
			() =>
				new Response("decoded text", {
					headers: { "content-encoding": "gzip", "content-length": "7", "content-type": "text/plain" },
				}),
		)
		const res = await app.fetch(req("/api/x"), {})
		expect([res.headers.get("content-encoding"), res.headers.get("content-length"), await res.text()]).toEqual([
			null,
			null,
			"decoded text",
		])
	})

	it("Content-Encoding: identity describes the bytes as they are, so it stays", async () => {
		const { app } = proxyApp(
			() => new Response("plain", { headers: { "content-encoding": "identity", "content-length": "5" } }),
		)
		const res = await app.fetch(req("/api/x"), {})
		expect([res.headers.get("content-encoding"), res.headers.get("content-length")]).toEqual(["identity", "5"])
	})

	// v0: 096d57cf3a
	it("decoded: false passes encoded bytes and their headers through", async () => {
		const { app } = proxyApp(
			() => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-encoding": "br", "content-length": "3" } }),
			{ decoded: false },
		)
		const res = await app.fetch(req("/api/x"), {})
		expect([res.headers.get("content-encoding"), res.headers.get("content-length")]).toEqual(["br", "3"])
	})
})
