/**
 * WS4–WS8 regressions that run in-process (`app.fetch`, or a Node server inside the test process).
 * Each test reproduces a review finding's exact scenario with API that predates the fixes, so the
 * same file runs against the pre-fix tree (3ab88ce) and fails there. See
 * docs/regression-matrix/ws4-8.md.
 */
import { readFileSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"
import * as z from "zod"
import { cors } from "../../../src/cors.ts"
import { csrf } from "../../../src/csrf.ts"
import { curlLogger } from "../../../src/curl-logger.ts"
import { verify } from "../../../src/cookie-sign.ts"
import { serializeCookie } from "../../../src/cookie.ts"
import { etag } from "../../../src/etag.ts"
import { createMiddleware, honey } from "../../../src/index.ts"
import { ipRestrict } from "../../../src/ip-restrict.ts"
import { serve } from "../../../src/node.ts"
import { swagger } from "../../../src/openapi/swagger.ts"
import { poweredBy } from "../../../src/powered-by.ts"
import "../../../src/proxy.ts"
import { requestId } from "../../../src/request-id.ts"
import { secureHeaders } from "../../../src/secure-headers.ts"
import { serverTiming } from "../../../src/server-timing.ts"
import { staticFiles } from "../../../src/static.ts"
import { otelAdapter } from "../../../src/telemetry/otel.ts"
import { nodeWebSocket } from "../../../src/ws/node.ts"
import { sleep, startUpstream } from "./harness.ts"

/* realtime moved behind an import after 3ab88ce; the old tree has it built in */
await import("../../../src/realtime/register.ts").catch(() => {})

type AnyApp = {
	fetch(req: Request, env?: unknown): Promise<Response> | Response
	[k: string]: any
}
const app = (): AnyApp => honey() as unknown as AnyApp
const req = (path: string, init?: RequestInit): Request => new Request(`http://localhost${path}`, init)
const fetchApp = async (a: AnyApp, path: string, init?: RequestInit): Promise<Response> => a.fetch(req(path, init), {})

/** Settle `p` or report a timeout, so a hang fails the test instead of the run. */
function within<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
	return Promise.race([p, sleep(ms).then(() => "timeout" as const)])
}

describe("WS4 streaming and responses", () => {
	// regression: H7
	it("H7: HEAD on an SSE route leaves no producer running", async () => {
		const counts = { finished: 0, started: 0 }
		const a = app()
		a.get("/events").handler((ctx: any) =>
			ctx.res.sse(async (s: any) => {
				counts.started++
				try {
					for (let i = 0; i < 10_000; i++) {
						await s.send({ data: "tick" })
						await sleep(5)
					}
				} catch {
					/* the stream ended */
				} finally {
					counts.finished++
				}
			}),
		)
		for (let i = 0; i < 5; i++) {
			const res = await fetchApp(a, "/events", { method: "HEAD" })
			expect(res.status).toBe(200)
		}
		await sleep(200)
		expect(counts.started - counts.finished).toBe(0)
	})

	// regression: H8
	it("H8: etag() answers an SSE route instead of buffering the endless body", async () => {
		const a = app().use(etag())
		a.get("/sse").handler((ctx: any) =>
			ctx.res.sse(async (s: any) => {
				for (let i = 0; i < 10_000; i++) {
					try {
						await s.send({ data: "x" })
					} catch {
						return
					}
					await sleep(5)
				}
			}),
		)
		const res = await within(Promise.resolve(fetchApp(a, "/sse")), 800)
		expect(res).not.toBe("timeout")
		await (res as Response).body?.cancel()
	})

	// regression: WS4 (M) etag.ts:45-46
	it("M: etag() over a zero-length body answers 200 (it returned a consumed Response)", async () => {
		const a = app().use(etag())
		a.get("/empty").handler((ctx: any) => ctx.res.text("ok", ""))
		const res = await fetchApp(a, "/empty")
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("")
	})

	// regression: WS4 (M) response.ts:287-303
	it("M: res.stream() settles when the callback throws while holding the writer", async () => {
		const a = app()
		a.get("/s").handler((ctx: any) =>
			ctx.res.stream(async (w: WritableStream) => {
				const writer = w.getWriter()
				await writer.write(new TextEncoder().encode("a"))
				throw new Error("producer failed")
			}),
		)
		const res = await fetchApp(a, "/s")
		const settled = await within(
			res.text().then(
				() => "resolved",
				() => "rejected",
			),
			1000,
		)
		expect(settled).not.toBe("timeout")
	})

	// regression: WS4 (M) response.ts:261-285
	it("M: generate() runs the generator's finally on cancel and errors the body on a throw", async () => {
		let finallyRan = false
		const a = app()
		a.get("/cancel").handler((ctx: any) => {
			async function* gen(): AsyncGenerator<string> {
				try {
					for (let i = 0; i < 1000; i++) {
						yield `chunk ${i}\n`
						await sleep(5)
					}
				} finally {
					finallyRan = true
				}
			}
			return ctx.res.generate(gen())
		})
		a.get("/throw").handler((ctx: any) => {
			async function* gen(): AsyncGenerator<string> {
				yield "first\n"
				throw new Error("mid-stream failure")
			}
			return ctx.res.generate(gen())
		})
		const res = await fetchApp(a, "/cancel")
		const reader = res.body!.getReader()
		await reader.read()
		await reader.cancel()
		await sleep(50)
		expect(finallyRan).toBe(true)

		const broken = await fetchApp(a, "/throw")
		await expect(broken.text()).rejects.toBeDefined()
	})

	// regression: H26
	it("H26: header middleware over an immutable Response.redirect() does not 500", async () => {
		for (const mw of [secureHeaders(), requestId(), poweredBy(), serverTiming()] as unknown[]) {
			const a = app().use(mw)
			a.get("/r").handler(() => Response.redirect("https://example.com/next", 302) as never)
			const res = await fetchApp(a, "/r")
			expect(res.status).toBe(302)
			expect(res.headers.get("location")).toBe("https://example.com/next")
		}
	})
})

describe("WS5 Node server lifecycle", () => {
	// regression: WS5 (M) node.ts:188-208, serve.ts:66-68
	it("M: shutdown closes open WebSockets and does not wait on idle keep-alive clients", async () => {
		const a = app()
		a.ws("/ws").handler({ onOpen: (_c: unknown, ws: any) => ws.send("ready") })
		a.get("/x").handler((ctx: any) => ctx.res.text("ok", "x"))
		a.wsAdapter(nodeWebSocket())
		const server = serve(a as never, { env: {}, port: 0 } as never) as any
		await new Promise<void>((r) => server.once("listening", () => r()))
		const port = server.address().port
		const http = await import("node:http")
		const agent = new http.Agent({ keepAlive: true })
		await new Promise<void>((resolve) => {
			http.get({ agent, host: "127.0.0.1", path: "/x", port }, (res) => {
				res.resume()
				res.on("end", () => resolve())
			})
		})
		let closed = false
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
		await new Promise<void>((r) => ws.once("message", () => r()))
		ws.on("close", () => {
			closed = true
		})
		const start = Date.now()
		await within(server.shutdown(500), 3000)
		const elapsed = Date.now() - start
		await sleep(100)
		agent.destroy()
		ws.terminate()
		expect(closed).toBe(true)
		expect(elapsed).toBeLessThan(1500)
	})

	// regression: WS5 (M) serve.ts:56,78,110
	it("M: startHoneyServer keeps a user-set wsAdapter", async () => {
		const { startHoneyServer } = await import("../../../src/serve.ts")
		const base = nodeWebSocket()
		let used = false
		const mine = {
			...base,
			upgrade: (...args: unknown[]) => {
				used = true
				return (base.upgrade as (...a: unknown[]) => unknown)(...args)
			},
		}
		const a = app()
		a.ws("/ws").handler({ onOpen: (_c: unknown, ws: any) => ws.send("ready") })
		a.wsAdapter(mine as never)
		const handle = (await startHoneyServer(a as never, { hostname: "127.0.0.1", port: 0 } as never)) as any
		try {
			const port = handle.port ?? handle.server?.address().port
			const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
			await within(new Promise<void>((r) => ws.once("message", () => r())), 1500)
			ws.terminate()
			expect(used).toBe(true)
		} finally {
			await (handle.close ?? handle.stop)?.call(handle, 100)
		}
	})

	// regression: WS5 (M) ws/node.ts:50 + package.json
	it("M: `ws` is declared as an optional peer dependency", () => {
		const pkg = JSON.parse(readFileSync(`${import.meta.dirname}/../../../package.json`, "utf-8")) as {
			peerDependencies?: Record<string, string>
			peerDependenciesMeta?: Record<string, { optional?: boolean }>
		}
		expect(pkg.peerDependencies?.ws).toBeDefined()
		expect(pkg.peerDependenciesMeta?.ws?.optional).toBe(true)
	})
})

describe("WS6 realtime bus", () => {
	// regression: WS6 (M) index.ts:1902-1907
	it("M: a realtime route does not shadow an HTTP route on the same path", async () => {
		const a = app()
		a.realtime("/live", { handler: () => {} })
		a.get("/live").handler((ctx: any) => ctx.res.text("ok", "http"))
		const res = await fetchApp(a, "/live")
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("http")
	})

	// regression: WS6 (M) index.ts:1700-1716 documented no-ops
	it("M: the documented-but-ignored reconnectBuffer option is rejected, not silently accepted", () => {
		const a = app()
		expect(() => a.realtime("/rb", { handler: () => {}, reconnectBuffer: 10 })).toThrow()
	})
})

describe("WS7 security middleware", () => {
	// regression: H23
	it("H23: csrf rejects a cross-site POST that has no Content-Type", async () => {
		const a = app().use(csrf())
		a.post("/transfer").handler((ctx: any) => ctx.res.text("ok", "done"))
		const res = await fetchApp(a, "/transfer", {
			body: new Uint8Array([123, 125]),
			headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
			method: "POST",
		})
		expect(res.status).toBe(403)
	})

	// regression: H24
	it("H24: credentialed CORS never reflects an arbitrary or null Origin", async () => {
		for (const opts of [{ credentials: true }, { credentials: true, origin: "*" as const }]) {
			let mw: unknown
			try {
				mw = cors(opts)
			} catch {
				continue /* refusing the config at construction is the fix */
			}
			const a = app().use(mw)
			a.get("/me").handler((ctx: any) => ctx.res.text("ok", "secret"))
			for (const origin of ["https://evil.example", "null"]) {
				const res = await fetchApp(a, "/me", { headers: { origin } })
				const reflected = res.headers.get("access-control-allow-origin")
				const creds = res.headers.get("access-control-allow-credentials")
				expect(reflected === origin && creds === "true").toBe(false)
			}
		}
	})

	// regression: WS7 (M) cors.ts:36-45
	it("M: cors adds Vary: Origin when the Origin is disallowed or absent", async () => {
		const a = app().use(cors({ origin: ["https://a.example"] }))
		a.get("/x").handler((ctx: any) => ctx.res.text("ok", "x"))
		for (const headers of [{ origin: "https://b.example" }, {}] as Record<string, string>[]) {
			const res = await fetchApp(a, "/x", { headers })
			expect(res.headers.get("vary") ?? "").toMatch(/origin/i)
		}
	})

	// regression: C3
	it("C3: ipRestrict does not trust a client-sent cf-connecting-ip, and deny-only fails closed", async () => {
		const allow = app().use(ipRestrict({ allowList: ["127.0.0.1"] }))
		allow.get("/admin").handler((ctx: any) => ctx.res.text("ok", "admin"))
		const spoofed = await fetchApp(allow, "/admin", { headers: { "cf-connecting-ip": "127.0.0.1" } })
		expect(spoofed.status).toBe(403)

		const deny = app().use(ipRestrict({ denyList: ["203.0.113.7"] }))
		deny.get("/admin").handler((ctx: any) => ctx.res.text("ok", "admin"))
		const unknown = await fetchApp(deny, "/admin")
		expect(unknown.status).toBe(403)
	})

	// regression: WS7 (M) ip-restrict.ts:40-50,112-151
	it("M: ipRestrict canonicalizes addresses and rejects invalid rules", async () => {
		const blocked = async (rule: { allowList?: string[]; denyList?: string[] }, ip: string): Promise<number> => {
			const a = app().use(ipRestrict({ ...rule, getIp: () => ip }))
			a.get("/x").handler((ctx: any) => ctx.res.text("ok", "x"))
			return (await fetchApp(a, "/x")).status
		}
		expect(await blocked({ denyList: ["203.0.113.7"] }, "::ffff:203.0.113.7")).toBe(403)
		expect(await blocked({ denyList: ["2001:db8::1"] }, "2001:DB8::1")).toBe(403)
		expect(await blocked({ denyList: ["203.0.113.7"] }, "203.0.113.7:51234")).toBe(403)
		expect(await blocked({ allowList: ["10.0.0.0/8"] }, "10.0.0.1abc")).toBe(403)
		expect(() => ipRestrict({ allowList: ["10.0.0.0/33"] })).toThrow()
		expect(() => ipRestrict({ allowList: [] })).toThrow()
	})

	// regression: WS7 (M) static.ts:34-37
	it("M: staticFiles matches its prefix on a segment boundary", async () => {
		const seen: string[] = []
		const a = app().use(
			staticFiles({
				prefix: "/assets",
				resolve: (_ctx: unknown, filePath: string) => {
					seen.push(filePath)
					return new Response(`file:${filePath}`)
				},
			}),
		)
		a.get("/health").handler((ctx: any) => ctx.res.text("ok", "ok"))
		const res = await fetchApp(a, "/assets-private/secret.txt")
		expect(seen).toEqual([])
		expect(await res.text()).not.toContain("secret")
	})

	// regression: WS7 (M) static.ts:11,40-44
	it("M: staticFiles never hands resolve a path with a `..` segment", async () => {
		const seen: string[] = []
		const a = app().use(
			staticFiles({
				prefix: "/assets",
				resolve: (_ctx: unknown, filePath: string) => {
					seen.push(filePath)
					return null
				},
			}),
		)
		a.get("/health").handler((ctx: any) => ctx.res.text("ok", "ok"))
		for (const p of [
			"/assets/..%5c..%5csecret",
			"/assets/a/..",
			"/assets/x\\..\\..\\secret",
			"/assets/%2e%2e/secret",
		]) {
			await fetchApp(a, p)
		}
		for (const filePath of seen) {
			/* a resolver that decodes (the README one does) must not see a `..` segment either */
			const decoded = (() => {
				try {
					return decodeURIComponent(filePath)
				} catch {
					return filePath
				}
			})()
			expect(decoded.split(/[\\/]/)).not.toContain("..")
		}
	})

	// regression: H4
	it("H4: curlLogger never leaves a floating rejection when a downstream middleware throws", async () => {
		const unhandled: unknown[] = []
		const onUnhandled = (e: unknown): void => {
			unhandled.push(e)
		}
		process.on("unhandledRejection", onUnhandled)
		try {
			const deny = createMiddleware(async () => {
				throw new Error("auth failed")
			})
			const a = app()
				.use(
					curlLogger({
						log: () => {},
						redactHeader: () => {
							throw new Error("redact failed")
						},
					}),
				)
				.use(deny)
			a.get("/x").handler((ctx: any) => ctx.res.text("ok", "x"))
			const res = await fetchApp(a, "/x", { headers: { authorization: "Bearer t" } })
			expect(res.status).toBeGreaterThanOrEqual(400)
			await sleep(50)
		} finally {
			process.off("unhandledRejection", onUnhandled)
		}
		expect(unhandled).toEqual([])
	})

	// regression: WS7 (M) curl-logger.ts:125-131, request-to-curl.ts:15
	it("M: curlLogger redacts credentials and token query params by default", async () => {
		const lines: string[] = []
		const a = app().use(curlLogger({ log: (d: { curl: string }) => lines.push(d.curl) }))
		a.get("/x").handler((ctx: any) => ctx.res.text("ok", "x"))
		await fetchApp(a, "/x?token=SECRET789", {
			headers: { authorization: "Bearer SECRET123", cookie: "sid=SECRET456" },
		})
		await sleep(20)
		expect(lines.length).toBe(1)
		expect(lines[0]).not.toMatch(/SECRET123|SECRET456|SECRET789/)
	})

	// regression: WS7 (M) telemetry/otel.ts:101,48,127
	it("M: otel ends the root span on short-circuited preflights and records the route pattern without the query", async () => {
		type FakeSpan = { attrs: Record<string, unknown>; ended: boolean; name: string }
		const spans: FakeSpan[] = []
		const tracer = {
			startSpan(name: string) {
				const span: FakeSpan = { attrs: {}, ended: false, name }
				spans.push(span)
				return {
					addEvent() {},
					end() {
						span.ended = true
					},
					recordException() {},
					setAttribute(k: string, v: unknown) {
						span.attrs[k] = v
					},
					setAttributes(o: Record<string, unknown>) {
						Object.assign(span.attrs, o)
					},
					setStatus() {},
				}
			},
		}
		const a = app()
			.telemetry(otelAdapter({ tracer } as never))
			.use(cors({ origin: ["https://a.example"] }))
		a.get("/users/:id").handler((ctx: any) => ctx.res.text("ok", "u"))
		await fetchApp(a, "/users/42", {
			headers: { "access-control-request-method": "GET", origin: "https://a.example" },
			method: "OPTIONS",
		})
		expect(spans.length).toBeGreaterThan(0)
		expect(spans.every((s) => s.ended)).toBe(true)

		spans.length = 0
		await fetchApp(a, "/users/42?apikey=SECRET")
		const routes = spans.map((s) => s.attrs["http.route"]).filter((v) => v !== undefined)
		expect(routes.length).toBeGreaterThan(0)
		expect(new Set(routes)).toEqual(new Set(["/users/:id"]))
		const all = spans.flatMap((s) => Object.values(s.attrs).map(String))
		expect(all.some((v) => v.includes("SECRET"))).toBe(false)
	})

	// regression: WS7 (M) openapi/swagger.ts:12,20-26
	it("M: the Swagger docs page pins its assets with SRI and sends CSP + nosniff", async () => {
		const a = app()
		a.get("/docs").handler(swagger({ url: "/openapi.json" }) as never)
		const res = await fetchApp(a, "/docs")
		const html = await res.text()
		expect(html).toMatch(/<script[^>]+integrity="sha(256|384|512)-/)
		expect(res.headers.get("content-security-policy")).toBeTruthy()
		expect(res.headers.get("x-content-type-options")).toBe("nosniff")
	})
})

describe("WS7 proxy against a real upstream", () => {
	let upstream: Awaited<ReturnType<typeof startUpstream>>
	const received: { body: string; headers: IncomingMessage["headers"]; method: string; url: string }[] = []
	beforeAll(async () => {
		upstream = await startUpstream((r: IncomingMessage, res: ServerResponse) => {
			let body = ""
			r.on("data", (c: Buffer) => {
				body += c.toString()
			})
			r.on("end", () => {
				received.push({ body, headers: r.headers, method: r.method ?? "", url: r.url ?? "" })
				if (r.url?.startsWith("/sse")) {
					res.writeHead(200, { "content-type": "text/event-stream" })
					let n = 0
					const timer = setInterval(() => {
						res.write(`data: ${n}\n\n`)
						if (++n === 5) {
							clearInterval(timer)
							res.end()
						}
					}, 260)
					return
				}
				res.writeHead(200, { "content-type": "text/plain" })
				res.end(`${r.method} ${r.url} ${body}`)
			})
		})
	})
	afterAll(() => {
		upstream.server.close()
	})

	const proxied = (extra: Record<string, unknown> = {}): AnyApp => {
		const a = app()
		a.all("/up/*").proxy({
			destination: (_c: unknown, url: string, init: RequestInit) => fetch(`${upstream.url}${url}`, init),
			rewriteUrl: (u: string) => u.replace(/^\/up/, ""),
			...extra,
		})
		return a
	}

	// regression: WS7 (M) proxy.ts:130
	it("M: proxy timeout covers the wait for headers, not the whole streamed body", async () => {
		const res = await fetchApp(proxied({ timeout: 500 }), "/up/sse")
		const text = await res.text().catch(() => "")
		for (let i = 0; i < 5; i++) expect(text).toContain(`data: ${i}`)
	})

	// regression: WS7 (M) proxy.ts:4,124
	it("M: proxy forwards the body of a DELETE", async () => {
		received.length = 0
		const res = await fetchApp(proxied(), "/up/items/1", {
			body: JSON.stringify({ reason: "dup" }),
			headers: { "content-type": "application/json" },
			method: "DELETE",
		})
		expect(res.status).toBe(200)
		expect(received.at(-1)?.body).toBe('{"reason":"dup"}')
	})

	// regression: WS7 (M) proxy.ts:100-107 Host/Expect/Upgrade
	it("M: proxy does not fail on client `Expect` / `Upgrade` headers (502 on Node)", async () => {
		for (const headers of [{ expect: "100-continue" }, { connection: "upgrade", upgrade: "foo" }]) {
			const res = await fetchApp(proxied(), "/up/plain", { headers })
			expect(res.status).toBe(200)
		}
	})

	// regression: WS7 (M) proxy.ts:87
	it("M: proxy detects a WebSocket upgrade case-insensitively", async () => {
		let captured: Headers | null = null
		const a = app()
		a.all("/up/*").proxy({
			destination: (_c: unknown, _url: string, init: RequestInit) => {
				captured = new Headers(init.headers)
				return new Response("captured")
			},
		})
		await fetchApp(a, "/up/ws", { headers: { connection: "Upgrade", upgrade: "WebSocket" } })
		expect((captured as Headers | null)?.get("connection")?.toLowerCase()).toBe("upgrade")
	})

	// regression: WS7 (M) proxy.ts:95-97
	it("M: destination never receives a `//host` URL or an encoded traversal", async () => {
		const urls: string[] = []
		const a = app()
		a.all("/up/*").proxy({
			destination: (_c: unknown, url: string) => {
				urls.push(url)
				return new Response("captured")
			},
			rewriteUrl: (u: string) => u.replace(/^\/up/, ""),
		})
		await fetchApp(a, "/up//evil.example/x")
		await fetchApp(a, "/up/..%2f..%2fadmin")
		for (const url of urls) {
			expect(url.startsWith("//")).toBe(false)
			expect(url.toLowerCase()).not.toContain("%2f")
		}
	})
})

describe("WS8 input and output", () => {
	const jsonApp = (): AnyApp => {
		const a = app()
		a.post("/j")
			.input({ json: z.object({ a: z.number() }) })
			.handler((ctx: any) => ctx.res.json("ok", { a: ctx.input.json.a }))
		a.delete("/d")
			.input({ json: z.object({ a: z.number() }) })
			.handler((ctx: any) => ctx.res.json("ok", { got: ctx.input.json ?? null }))
		a.post("/f")
			.input({ form: z.object({ role: z.string() }) })
			.handler((ctx: any) => ctx.res.json("ok", { role: ctx.input.form.role }))
		return a
	}

	// regression: H30
	it("H30: malformed JSON is a 400, not a 500", async () => {
		const res = await fetchApp(jsonApp(), "/j", {
			body: "{",
			headers: { "content-type": "application/json" },
			method: "POST",
		})
		expect(res.status).toBe(400)
	})

	// regression: WS8 (M) validation.ts:49,251
	it("M: a declared json schema is validated on DELETE", async () => {
		const res = await fetchApp(jsonApp(), "/d", {
			body: JSON.stringify({ a: "not a number" }),
			headers: { "content-type": "application/json" },
			method: "DELETE",
		})
		expect(res.status).toBe(400)
	})

	// regression: WS8 (M) validation.ts:39-45,268
	it("M: content-type matching is case-insensitive, accepts +json, and is not a prefix match", async () => {
		const send = async (type: string): Promise<number> =>
			(
				await fetchApp(jsonApp(), "/j", {
					body: JSON.stringify({ a: 1 }),
					headers: { "content-type": type },
					method: "POST",
				})
			).status
		expect(await send("Application/JSON")).toBe(200)
		expect(await send("application/vnd.api+json")).toBe(200)
		expect(await send("application/jsonx")).toBe(415)
	})

	// regression: WS8 (M) validation.ts:195-212
	it("M: form duplicates give a scalar field its first value", async () => {
		const res = await fetchApp(jsonApp(), "/f", {
			body: "role=user&role=admin",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			method: "POST",
		})
		expect(await res.json()).toEqual({ role: "user" })
	})

	// regression: WS8 (M) cookie.ts:16-33
	it("M: cookie values containing `%` round-trip", async () => {
		const a = app()
		a.get("/c")
			.input({ cookies: z.object({ c: z.string() }) })
			.handler((ctx: any) => ctx.res.json("ok", { c: ctx.input.cookies.c }))
		for (const value of ["%41", "100%", "a%2Fb"]) {
			const header = serializeCookie("c", { value } as never)
			const pair = header.split(";")[0]
			const res = await fetchApp(a, "/c", { headers: { cookie: pair } })
			expect(await res.json()).toEqual({ c: value })
		}
	})

	// regression: WS8 (M) cookie-sign.ts:19-27,41
	it("M: verify() returns null for a malformed signature instead of throwing", async () => {
		await expect(verify("value.!!!not-base64!!!", ["secret"])).resolves.toBeNull()
		await expect(verify("value.~@@@", ["secret"])).resolves.toBeNull()
	})
})
