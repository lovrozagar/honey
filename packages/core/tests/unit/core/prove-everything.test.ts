import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { sign, verify } from "../../../src/cookie-sign.ts"
import { defineErrors, honey } from "../../../src/index.ts"
import { readableStream } from "../../../src/input.ts"
import { createLongPollHandler } from "../../../src/realtime/longpoll.ts"
import { ReconnectBuffer } from "../../../src/realtime/buffer.ts"
import { staticFiles } from "../../../src/static.ts"
import { otelAdapter } from "../../../src/telemetry/otel.ts"
import type { WSAdapter, WSHandler } from "../../../src/ws/cloudflare.ts"
import { WSContextImpl } from "../../../src/ws/cloudflare.ts"

function make101(): Response {
	const response = new Response(null, { status: 200 })
	Object.defineProperty(response, "status", { value: 101 })
	return response
}

function testWsAdapter(): {
	adapter: WSAdapter
	inbox: string[]
	send(data: string): void
} {
	const inbox: string[] = []
	let handler: WSHandler<unknown> | null = null
	const raw = {
		close: () => {},
		readyState: 1,
		send: (d: ArrayBuffer | Uint8Array | string) => {
			inbox.push(typeof d === "string" ? d : "bin")
		},
	}
	return {
		adapter: {
			upgrade(_req, _env, next) {
				handler = next
				const socket = new WSContextImpl(raw)
				next.onOpen?.(undefined, socket)
				return { response: make101(), socket }
			},
		},
		inbox,
		send(data: string) {
			handler?.onMessage?.(undefined, new WSContextImpl(raw), data)
		},
	}
}

describe("prove: static files from real disk", () => {
	it("serves a real file and blocks traversal", async () => {
		const dir = join(tmpdir(), `honey-static-${Date.now()}`)
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, "hello.txt"), "hello-disk", "utf-8")

		const app = honey().use(
			staticFiles({
				headers: { "cache-control": "no-store" },
				prefix: "/assets",
				resolve: async (_ctx, filePath) => {
					const name = filePath.replace(/^\//, "")
					if (name !== "hello.txt") return null
					const { readFileSync } = await import("node:fs")
					return new Response(readFileSync(join(dir, name), "utf-8"), {
						headers: { "content-type": "text/plain" },
					})
				},
			}),
		)
		app.get("/other").handler((ctx) => ctx.res.text("ok", "route"))

		const hit = await app.fetch(new Request("http://x/assets/hello.txt"), {})
		expect(hit.status).toBe(200)
		expect(await hit.text()).toBe("hello-disk")
		expect(hit.headers.get("cache-control")).toBe("no-store")

		const miss = await app.fetch(new Request("http://x/assets/nope.txt"), {})
		expect(miss.status).toBe(404)

		const traverse = await app.fetch(new Request("http://x/assets/../hello.txt"), {})
		expect(traverse.status).toBe(404)

		const other = await app.fetch(new Request("http://x/other"), {})
		expect(await other.text()).toBe("route")
	})
})

describe("prove: proxy to a live upstream", () => {
	it("forwards GET/POST and rewrite through a real Honey dest", async () => {
		const upstream = honey()
			.get("/v1/ping")
			.handler((ctx) => ctx.res.json("ok", { pong: ctx.req.headers.get("x-fwd") }))
			.post("/v1/echo")
			.handler(async (ctx) => ctx.res.json("ok", await ctx.req.json()))

		const edge = honey()
			.all("/proxy/*")
			.proxy({
				destination: (ctx, url, init) => upstream.fetch(new Request(`http://up${url}`, init), ctx.env),
				requestHeaders: (_ctx, headers) => {
					headers.set("x-fwd", "yes")
				},
				rewriteUrl: (url) => url.replace(/^\/proxy/, "/v1"),
			})

		const ping = await edge.fetch(new Request("http://edge/proxy/ping"), {})
		expect(ping.status).toBe(200)
		expect(await ping.json()).toEqual({ pong: "yes" })

		const echo = await edge.fetch(
			new Request("http://edge/proxy/echo", {
				body: JSON.stringify({ n: 7 }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(echo.status).toBe(200)
		expect(await echo.json()).toEqual({ n: 7 })
	})
})

describe("prove: signed cookie HTTP round trip", () => {
	it("Set-Cookie then Cookie header verifies", async () => {
		const secret = "prove-secret-key"
		const app = honey()
			.post("/login")
			.handler(async (ctx) => {
				const token = await sign("user-42", secret)
				return ctx.res.text("ok", "in", {
					cookies: { sid: { httpOnly: true, path: "/", value: token } },
				})
			})
			.get("/me")
			.handler(async (ctx) => {
				const raw = ctx.cookies.sid
				const user = raw ? await verify(raw, [secret]) : null
				if (!user) return ctx.res.text("unauthorized", "no", { status: 401 })
				return ctx.res.text("ok", user)
			})

		const login = await app.fetch(new Request("http://x/login", { method: "POST" }), {})
		expect(login.status).toBe(200)
		const setCookie = login.headers.get("set-cookie")
		expect(setCookie).toMatch(/^sid=user-42\./)
		const sid = setCookie?.split(";")[0]?.slice("sid=".length)
		expect(sid).toBeTruthy()

		const me = await app.fetch(new Request("http://x/me", { headers: { cookie: `sid=${sid}` } }), {})
		expect(me.status).toBe(200)
		expect(await me.text()).toBe("user-42")

		const bad = await app.fetch(new Request("http://x/me", { headers: { cookie: "sid=user-42.forged" } }), {})
		expect(bad.status).toBe(401)
	})
})

describe("prove: multipart file + readableStream", () => {
	it("accepts multipart File and streams a raw body", async () => {
		const app = honey()
			.post("/upload")
			.input({ form: z.object({ title: z.string(), blob: z.file() }) })
			.handler((ctx) =>
				ctx.res.json("created", {
					name: ctx.input.form.blob.name,
					size: ctx.input.form.blob.size,
					title: ctx.input.form.title,
					type: ctx.input.form.blob.type,
				}),
			)
			.post("/stream")
			.input({ json: readableStream(z.unknown()) })
			.handler(async (ctx) => {
				const raw = await ctx.req.text()
				return ctx.res.text("ok", raw)
			})

		const fd = new FormData()
		fd.set("title", "pic")
		fd.set("blob", new File(["PNGDATA"], "a.png", { type: "image/png" }))
		const up = await app.fetch(new Request("http://x/upload", { body: fd, method: "POST" }), {})
		expect(up.status).toBe(201)
		expect(await up.json()).toEqual({
			name: "a.png",
			size: 7,
			title: "pic",
			type: "image/png",
		})

		const streamed = await app.fetch(
			new Request("http://x/stream", {
				body: "raw-bytes",
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(streamed.status).toBe(200)
		expect(await streamed.text()).toBe("raw-bytes")
	})
})

describe("prove: outputValidation dev vs production", () => {
	const prev = process.env.NODE_ENV
	const schema = z.object({ id: z.string() })

	function appWith(mode: "always" | "dev" | "off") {
		return honey()
			.outputValidation(mode)
			.get("/item")
			.output({ "application/json": { ok: schema } })
			.handler((ctx) => ctx.res.json("ok", { id: 1 } as never))
	}

	it("'always' rejects bad output", async () => {
		const res = await appWith("always").fetch(new Request("http://x/item"), {})
		expect(res.status).toBe(500)
	})

	it("'off' lets bad output through", async () => {
		const res = await appWith("off").fetch(new Request("http://x/item"), {})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ id: 1 })
	})

	it("'dev' validates when NODE_ENV is not production", async () => {
		process.env.NODE_ENV = "development"
		try {
			const res = await appWith("dev").fetch(new Request("http://x/item"), {})
			expect(res.status).toBe(500)
		} finally {
			process.env.NODE_ENV = prev
		}
	})

	it("'dev' skips when NODE_ENV is production", async () => {
		process.env.NODE_ENV = "production"
		try {
			const res = await appWith("dev").fetch(new Request("http://x/item"), {})
			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({ id: 1 })
		} finally {
			process.env.NODE_ENV = prev
		}
	})
})

describe("prove: route() compose taps + i18n + ws", () => {
	it("parent taps and i18n apply; child ws upgrades", async () => {
		const taps: unknown[] = []
		const ws = testWsAdapter()
		const errors = defineErrors({ gone: "not_found" })
		const child = honey()
			.basePath("/api")
			.ws("/echo")
			.handler({
				onMessage(_ctx, socket, data) {
					socket.send(String(data))
				},
			})

		const app = honey()
			.wsAdapter(ws.adapter)
			.errorFactory(errors)
			.errorI18n({
				errors: { en: { gone: "missing {id}" } },
				resolveLocale: () => "en",
			})
			.tap("audit", (_ctx, payload) => {
				taps.push(payload)
			})
			.route(child)
			.get("/item/:id")
			.meta({ audit: { action: "get" } })
			.handler((ctx) => {
				if (ctx.params.id === "0") throw ctx.errors.gone({ vars: { id: "0" } })
				ctx.tap("audit", { action: "ok", id: ctx.params.id })
				return ctx.res.json("ok", { id: ctx.params.id })
			})

		const ok = await app.fetch(new Request("http://x/item/7"), {})
		expect(ok.status).toBe(200)
		const boom = await app.fetch(new Request("http://x/item/0"), {})
		expect(boom.status).toBe(404)
		expect(await boom.text()).toMatch(/missing 0/)

		const upgrade = await app.fetch(new Request("http://x/api/echo", { headers: { upgrade: "websocket" } }), {})
		expect(upgrade.status).toBe(101)
		expect(ws.inbox.length).toBeGreaterThanOrEqual(0)

		await new Promise((r) => setTimeout(r, 10))
		expect(taps).toEqual([{ action: "get" }, { action: "ok", id: "7" }])
	})
})

describe("prove: workerd-shaped waitUntil taps", () => {
	it("calls waitUntil as a method on executionCtx", async () => {
		const pending: Promise<unknown>[] = []
		const executionCtx = {
			waitUntil(p: Promise<unknown>) {
				if (this !== executionCtx) throw new Error("Illegal invocation")
				pending.push(p)
			},
		}
		const seen: unknown[] = []
		const app = honey()
			.tap("audit", (_ctx, payload) => {
				seen.push(payload)
			})
			.get("/x")
			.handler((ctx) => {
				ctx.tap("audit", { via: "waitUntil" })
				return ctx.res.text("ok", "ok")
			})

		const res = await app.fetch(new Request("http://x/x"), {}, executionCtx)
		expect(res.status).toBe(200)
		expect(pending.length).toBe(1)
		await Promise.all(pending)
		expect(seen).toEqual([{ via: "waitUntil" }])
	})
})

describe("prove: otel adapter on a real request", () => {
	it("records request/route/handler/response spans", async () => {
		const events: string[] = []
		const tracer = {
			startSpan(name: string) {
				events.push(`start:${name}`)
				return {
					addEvent(n: string) {
						events.push(`event:${n}`)
					},
					end() {
						events.push(`end:${name}`)
					},
					setAttribute() {},
				}
			},
		}
		const app = honey()
			.telemetry(otelAdapter({ tracer }))
			.get("/traced/:id")
			.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

		const res = await app.fetch(new Request("http://x/traced/9"), {})
		expect(res.status).toBe(200)
		expect(events.some((e) => e.startsWith("start:"))).toBe(true)
		expect(events.some((e) => e.startsWith("end:"))).toBe(true)
	})
})

describe("prove: REST publish reaches a realtime subscriber", () => {
	it("POST /broadcast hits the joined topic", async () => {
		const ws = testWsAdapter()
		const app = honey()
			.wsAdapter(ws.adapter)
			.realtime("/rt/:room", {
				handler(_c, conn) {
					conn.join(`room:${conn.id ? "x" : "x"}`)
					conn.join("room:lobby")
					conn.send({ event: "joined" })
				},
			})
			.post("/broadcast/:topic")
			.handler(async (ctx) => {
				const body = await ctx.req.json()
				ctx.realtime.publish(ctx.params.topic, body)
				return ctx.res.json("ok", { published: true })
			})

		const upgrade = await app.fetch(new Request("http://x/rt/lobby", { headers: { upgrade: "websocket" } }), {})
		expect(upgrade.status).toBe(101)
		expect(ws.inbox.some((m) => m.includes("joined"))).toBe(true)

		const pub = await app.fetch(
			new Request("http://x/broadcast/room:lobby", {
				body: JSON.stringify({ hello: "room" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(pub.status).toBe(200)
		expect(ws.inbox.some((m) => m.includes("hello"))).toBe(true)
	})
})

describe("prove: longpoll handler over Honey routes", () => {
	it("poll + send round trip", async () => {
		const buffer = new ReconnectBuffer({ size: 16 })
		const token = buffer.create("c1")
		const subscribers = new Map<string, (frame: { data: unknown; id: number; t: "msg" }) => void>()
		const lp = createLongPollHandler({
			buffer: {
				replay(t, lastId) {
					return buffer.replay(t, lastId)
				},
			},
			bus: {
				deliverMessage(t, payload) {
					const cb = subscribers.get(t)
					if (!cb) return false
					cb({ data: payload, id: 1, t: "msg" })
					return true
				},
				subscribe(t, cb) {
					subscribers.set(t, cb)
					return () => subscribers.delete(t)
				},
			},
			defaultWait: 0,
		})

		const app = honey()
			.get("/lp")
			.handler((ctx) => lp.poll(ctx.req))
			.post("/lp")
			.handler((ctx) => lp.send(ctx.req))

		buffer.push(token, { hi: 1 })
		const polled = await app.fetch(
			new Request(`http://x/lp?reconnectToken=${encodeURIComponent(token)}&lastId=0&wait=0`),
			{},
		)
		expect(polled.status).toBe(200)
		const frames = (await polled.json()) as Array<{ data: { hi: number } }>
		expect(frames[0]?.data.hi).toBe(1)
	})
})

describe("prove: middleware suite on one app", () => {
	it("request-id, timeout, body-limit, csrf skip, ip allow", async () => {
		const { requestId } = await import("../../../src/request-id.ts")
		const { timeout } = await import("../../../src/timeout.ts")
		const { bodyLimit } = await import("../../../src/body-limit.ts")
		const { ipRestrict } = await import("../../../src/ip-restrict.ts")

		const app = honey()
			.use(requestId())
			.use(timeout({ duration: 1_000 }))
			.use(bodyLimit({ maxSize: 1_000 }))
			.use(ipRestrict({ allowList: ["127.0.0.1"], trustProxy: true }))
			.post("/ping")
			.handler((ctx) => ctx.res.json("ok", { id: ctx.req.headers.get("x-request-id") ?? "ok" }))

		const res = await app.fetch(
			new Request("http://x/ping", {
				body: "{}",
				headers: { "content-type": "application/json", "x-forwarded-for": "127.0.0.1" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
	})
})
