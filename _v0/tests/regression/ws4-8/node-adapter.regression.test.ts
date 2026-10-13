/**
 * WS4–WS8 regressions that need the real Node adapter: each test drives `node-fixture.ts` under
 * plain `node` with the exact scenario a review finding describes. Every test failed against the
 * pre-fix tree (3ab88ce); see docs/regression-matrix/ws4-8.md.
 */
import { connect } from "node:net"
import { gzipSync } from "node:zlib"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"
import { type Fixture, rawRequest, rawUntil, sleep, startFixture, startUpstream, stateOf } from "./harness.ts"

const TIMEOUT = 20_000

/** Assert the fixture survived and still answers. */
async function expectAlive(fx: Fixture): Promise<void> {
	await sleep(300)
	expect(fx.alive(), `fixture died: ${fx.stderr()}`).toBe(true)
	const res = await fetch(`${fx.base}/health`)
	expect(res.status).toBe(200)
}

type WsOutcome = {
	closeCode: number | null
	error: string | null
	messages: string[]
	opened: boolean
	status: number | null
}

function wsSession(
	url: string,
	opts: WebSocket.ClientOptions & { onOpen?: (ws: WebSocket) => void; ms?: number } = {},
): Promise<WsOutcome> {
	return new Promise((resolve) => {
		const out: WsOutcome = { closeCode: null, error: null, messages: [], opened: false, status: null }
		const ws = new WebSocket(url, opts)
		const finish = (): void => {
			clearTimeout(timer)
			try {
				ws.terminate()
			} catch {}
			resolve(out)
		}
		const timer = setTimeout(finish, opts.ms ?? 1500)
		ws.on("open", () => {
			out.opened = true
			opts.onOpen?.(ws)
		})
		ws.on("message", (d) => out.messages.push(d.toString()))
		ws.on("unexpected-response", (_req, res) => {
			out.status = res.statusCode ?? null
			finish()
		})
		ws.on("error", (e) => {
			out.error = e.message
		})
		ws.on("close", (code) => {
			out.closeCode = code
			finish()
		})
	})
}

describe("WS5 Node adapter and WebSockets", () => {
	// regression: C2
	it(
		"C2: a reset upgrade socket while the handler awaits does not crash the process",
		async () => {
			const fx = await startFixture()
			try {
				for (const path of ["/slow", "/ws-slow"]) {
					await new Promise<void>((resolve) => {
						const socket = connect(fx.port, "127.0.0.1", () => {
							socket.write(
								`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: ${path === "/slow" ? "x" : "websocket"}\r\n` +
									"Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
							)
							setTimeout(() => {
								socket.resetAndDestroy()
								resolve()
							}, 15)
						})
						socket.on("error", () => resolve())
					})
				}
				await sleep(200)
				await expectAlive(fx)
			} finally {
				await fx.stop()
			}
		},
		TIMEOUT,
	)

	// regression: H2
	it(
		"H2: a rejecting async onOpen and a throwing onClose do not crash the process",
		async () => {
			const fx = await startFixture()
			try {
				await wsSession(`ws://127.0.0.1:${fx.port}/ws-open-reject`, { ms: 500 })
				await expectAlive(fx)
				await wsSession(`ws://127.0.0.1:${fx.port}/ws-close-throw`, {
					ms: 800,
					onOpen: (ws) => setTimeout(() => ws.close(1000), 50),
				})
				await expectAlive(fx)
			} finally {
				await fx.stop()
			}
		},
		TIMEOUT,
	)

	// regression: WS5 NEW (M) realtime/onOpen sync throw on Node
	it(
		"NEW (M): a sync throw in onOpen never writes an HTTP 500 onto the upgraded socket",
		async () => {
			const fx = await startFixture()
			try {
				const data = await rawRequest(
					fx.port,
					"GET /ws-open-sync HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
						"Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
					800,
				)
				expect(data.startsWith("HTTP/1.1 101")).toBe(true)
				const afterHandshake = data.slice(data.indexOf("\r\n\r\n") + 4)
				expect(afterHandshake).not.toContain("HTTP/1.1")
				await expectAlive(fx)
			} finally {
				await fx.stop()
			}
		},
		TIMEOUT,
	)

	// regression: H5
	it(
		"H5: an SSE route reached with `Upgrade: x` streams instead of buffering forever",
		async () => {
			const fx = await startFixture()
			try {
				const data = await rawUntil(
					fx.port,
					"GET /events HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: x\r\n\r\n",
					/event 0/,
					1500,
				)
				expect(data).toContain("event 0")
			} finally {
				await fx.stop()
			}
		},
		TIMEOUT,
	)

	// regression: H6
	it(
		"H6: a non-WebSocket upgrade keeps the route's status, headers and content type",
		async () => {
			const fx = await startFixture()
			try {
				const data = await rawRequest(
					fx.port,
					"GET /plain HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n",
					800,
				)
				expect(data).toMatch(/^HTTP\/1\.1 200 OK\r\n/)
				expect(data.toLowerCase()).toContain("x-custom: 1")
				expect(data.toLowerCase()).toMatch(/content-type: text\/plain/)
				expect(data).toContain("hello world")
			} finally {
				await fx.stop()
			}
		},
		TIMEOUT,
	)

	// regression: WS5 (M) index.ts:3626-3633
	it(
		"M: WS `.input()` is validated before the upgrade",
		async () => {
			const fx = await startFixture()
			try {
				const out = await wsSession(`ws://127.0.0.1:${fx.port}/ws-input`)
				expect(out.opened).toBe(false)
				expect(out.status).toBe(400)
				const ok = await wsSession(`ws://127.0.0.1:${fx.port}/ws-input?token=t`)
				expect(ok.opened).toBe(true)
			} finally {
				await fx.stop()
			}
		},
		TIMEOUT,
	)

	// regression: WS5 (M) ws/node.ts:52
	it(
		"M: a WebSocket frame over the default maxPayload is refused, not delivered",
		async () => {
			const fx = await startFixture()
			try {
				const out = await wsSession(`ws://127.0.0.1:${fx.port}/ws-echo`, {
					ms: 3000,
					onOpen: (ws) => ws.send("x".repeat(2 * 1024 * 1024)),
				})
				expect(out.opened).toBe(true)
				expect(out.closeCode).toBe(1009)
				expect((await stateOf(fx)).maxMessageBytes).toBe(0)
			} finally {
				await fx.stop()
			}
		},
		TIMEOUT,
	)

	// regression: WS5 (H) WS Origin never checked
	it(
		"H: a cross-origin WebSocket upgrade carrying cookies is refused",
		async () => {
			const fx = await startFixture()
			try {
				const out = await wsSession(`ws://127.0.0.1:${fx.port}/ws-echo`, {
					headers: { cookie: "sid=victim" },
					origin: "https://evil.example",
				})
				expect(out.opened).toBe(false)
				expect(out.status).toBe(403)
			} finally {
				await fx.stop()
			}
		},
		TIMEOUT,
	)

	// regression: H29
	it(
		"H29: cors() in front of a WebSocket route lets the socket open and exchange frames",
		async () => {
			const fx = await startFixture()
			try {
				const out = await wsSession(`ws://127.0.0.1:${fx.port}/ws-cors`, {
					origin: "http://app.example",
					onOpen: (ws) => ws.send("hi"),
				})
				expect(out.error).toBeNull()
				expect(out.messages).toContain("ready")
				expect(out.messages).toContain("echo:hi")
				await expectAlive(fx)
			} finally {
				await fx.stop()
			}
		},
		TIMEOUT,
	)

	// regression: WS5 (M) node-request.ts:166-207,221-237
	it(
		"M: NodeRequest follows Fetch: clone() does not lock, a second read throws, empty json() throws",
		async () => {
			const fx = await startFixture()
			try {
				const res = await fetch(`${fx.base}/req-contract`, { body: "abc", method: "POST" })
				expect(await res.json()).toEqual({ cloneText: "abc", first: "abc", second: "threw:TypeError" })
				const empty = await fetch(`${fx.base}/req-empty-json`, { method: "POST" })
				expect(await empty.json()).toEqual({ result: "threw:SyntaxError" })
				const twice = await fetch(`${fx.base}/req-twice`, { body: "abc", method: "POST" })
				expect(await twice.json()).toEqual({ first: "abc", second: "threw:TypeError" })
				/* a repeated Authorization header (Node keeps only the first in `headers`) reads the same before and after iterating the headers */
				const raw = await rawRequest(
					fx.port,
					"GET /req-dup-header HTTP/1.1\r\nHost: localhost\r\nAuthorization: a\r\nAuthorization: b\r\nConnection: close\r\n\r\n",
					800,
				)
				const body = JSON.parse(
					raw.slice(raw.indexOf("\r\n\r\n") + 4).replace(/^[0-9a-f]+\r\n|\r\n0\r\n\r\n$/g, ""),
				) as {
					after: string
					before: string
				}
				expect(body.after).toBe(body.before)
			} finally {
				await fx.stop()
			}
		},
		TIMEOUT,
	)

	// regression: WS5 (M) curl-logger.ts:83 + body-limit.ts:70
	it(
		"M: curlLogger({ body: true }) before bodyLimit answers the POST instead of 500",
		async () => {
			const fx = await startFixture()
			try {
				const res = await fetch(`${fx.base}/curl-echo`, {
					body: JSON.stringify({ a: 1 }),
					headers: { "content-type": "application/json" },
					method: "POST",
				})
				expect(res.status).toBe(200)
				expect(await res.text()).toBe('{"a":1}')
			} finally {
				await fx.stop()
			}
		},
		TIMEOUT,
	)

	// regression: WS7 NEW (M) curl-logger.ts malformed Host
	it(
		"NEW (M): curlLogger on Node with a malformed Host never turns the request into a 500",
		async () => {
			const fx = await startFixture()
			try {
				const data = await rawRequest(fx.port, "GET /curl-get HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n", 800)
				expect(data).toMatch(/^HTTP\/1\.1 \d{3}/)
				expect(data).not.toMatch(/^HTTP\/1\.1 500/)
				await expectAlive(fx)
			} finally {
				await fx.stop()
			}
		},
		TIMEOUT,
	)
})

describe("WS4 streaming on Node", () => {
	// regression: H3
	it(
		"H3: the README `finally { s.close() }` SSE shape survives a client disconnect",
		async () => {
			const fx = await startFixture()
			try {
				for (let i = 0; i < 3; i++) {
					const ac = new AbortController()
					const res = await fetch(`${fx.base}/sse-finally`, { signal: ac.signal })
					const reader = res.body!.getReader()
					await reader.read()
					ac.abort()
					await sleep(100)
				}
				await expectAlive(fx)
				expect((await stateOf(fx)).sseFinally).toBe(3)
			} finally {
				await fx.stop()
			}
		},
		TIMEOUT,
	)

	// regression: H9
	it(
		"H9: a text/plain generate() of unknown length streams its first chunk without buffering",
		async () => {
			const fx = await startFixture()
			try {
				const start = Date.now()
				const res = await fetch(`${fx.base}/gen-text`)
				const reader = res.body!.getReader()
				const first = await reader.read()
				const elapsed = Date.now() - start
				expect(new TextDecoder().decode(first.value)).toContain("first")
				expect(elapsed).toBeLessThan(900)
				await reader.cancel()
			} finally {
				await fx.stop()
			}
		},
		TIMEOUT,
	)

	// regression: WS4 (M) node-request.ts:134-140
	it(
		"M: a disconnect after the body was read aborts the request signal",
		async () => {
			const fx = await startFixture()
			try {
				const ac = new AbortController()
				const res = await fetch(`${fx.base}/sse-post`, { body: "payload", method: "POST", signal: ac.signal })
				const reader = res.body!.getReader()
				await reader.read()
				ac.abort()
				await sleep(400)
				expect((await stateOf(fx)).postAborted).toBe(1)
			} finally {
				await fx.stop()
			}
		},
		TIMEOUT,
	)

	// regression: WS4 NEW (L) index.ts:2716
	it(
		"NEW (L): HEAD keeps Content-Length on Node",
		async () => {
			const fx = await startFixture()
			try {
				const get = await fetch(`${fx.base}/plain`)
				const head = await fetch(`${fx.base}/plain`, { method: "HEAD" })
				expect(get.headers.get("content-length")).toBe("11")
				expect(head.headers.get("content-length")).toBe("11")
			} finally {
				await fx.stop()
			}
		},
		TIMEOUT,
	)
})

describe("WS6 realtime bus on Node", () => {
	// regression: H1
	it(
		"H1: a rejecting realtime message handler does not crash the process",
		async () => {
			const fx = await startFixture()
			try {
				await wsSession(`ws://127.0.0.1:${fx.port}/rt-reject`, {
					ms: 600,
					onOpen: (ws) => ws.send(JSON.stringify({ data: 1, t: "msg" })),
				})
				await expectAlive(fx)
			} finally {
				await fx.stop()
			}
		},
		TIMEOUT,
	)

	// regression: WS6 (M) wire format asymmetric
	it(
		"M: the wire format is symmetric — a client sends the payload itself and gets JSON back",
		async () => {
			const fx = await startFixture()
			try {
				const out = await wsSession(`ws://127.0.0.1:${fx.port}/rt-echo`, {
					onOpen: (ws) => ws.send(JSON.stringify({ a: 1 })),
				})
				expect(out.messages.map((m) => JSON.parse(m))).toContainEqual({ echo: { a: 1 } })
			} finally {
				await fx.stop()
			}
		},
		TIMEOUT,
	)

	// regression: WS6 (M) index.ts:2217-2225, realtime/bus.ts:19-33
	it(
		"M: a throwing close handler still unsubscribes the connection (no ghost in presence)",
		async () => {
			const fx = await startFixture()
			try {
				let during: string[] = []
				await wsSession(`ws://127.0.0.1:${fx.port}/rt-ghost`, {
					ms: 1500,
					onOpen: (ws) => {
						ws.once("message", async () => {
							during = ((await (await fetch(`${fx.base}/rt-presence`)).json()) as { members: string[] }).members
							ws.close(1000)
						})
					},
				})
				expect(during.length).toBe(1)
				await sleep(300)
				expect(fx.alive(), fx.stderr()).toBe(true)
				const after = (await (await fetch(`${fx.base}/rt-presence`)).json()) as { members: string[] }
				expect(after.members).toEqual([])
			} finally {
				await fx.stop()
			}
		},
		TIMEOUT,
	)
})

describe("WS7 proxy on Node", () => {
	let upstream: Awaited<ReturnType<typeof startUpstream>>
	const big = "a".repeat(400_000)
	beforeAll(async () => {
		upstream = await startUpstream((req, res) => {
			if (req.url?.startsWith("/up/gzip-big")) {
				const body = gzipSync(big)
				res.writeHead(200, { "content-encoding": "gzip", "content-length": body.length, "content-type": "text/plain" })
				res.end(body)
				return
			}
			if (req.url?.startsWith("/up/chunked")) {
				res.writeHead(200, { "content-type": "text/plain", "keep-alive": "timeout=5", connection: "keep-alive" })
				res.write("part1-")
				setTimeout(() => res.end("part2"), 20)
				return
			}
			res.writeHead(404)
			res.end()
		})
	})
	afterAll(() => {
		upstream.server.close()
	})

	// regression: H27
	it(
		"H27: a gzip upstream body over 256 KB arrives intact and the keep-alive socket stays in sync",
		async () => {
			const fx = await startFixture({ UPSTREAM: upstream.url })
			try {
				for (let i = 0; i < 2; i++) {
					const res = await fetch(`${fx.base}/up/gzip-big`)
					expect(res.status).toBe(200)
					expect((await res.text()).length).toBe(big.length)
				}
				expect((await fetch(`${fx.base}/health`)).status).toBe(200)
			} finally {
				await fx.stop()
			}
		},
		TIMEOUT,
	)

	// regression: H28
	it(
		"H28: hop-by-hop upstream headers are stripped and never sent with both framings",
		async () => {
			const fx = await startFixture({ UPSTREAM: upstream.url })
			try {
				const data = await rawRequest(
					fx.port,
					"GET /up/chunked HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
					1000,
				)
				const head = data.slice(0, data.indexOf("\r\n\r\n")).toLowerCase()
				expect(head).toMatch(/^http\/1\.1 200/)
				expect(head.includes("transfer-encoding:") && head.includes("content-length:")).toBe(false)
				expect(head).not.toContain("keep-alive: timeout=5")
				expect(data).toContain("part1-")
			} finally {
				await fx.stop()
			}
		},
		TIMEOUT,
	)
})
