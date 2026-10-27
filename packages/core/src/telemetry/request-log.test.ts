import type { AddressInfo } from "node:net"
import { connect } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { type HoneyServer, serve } from "../adapters/node/serve.ts"
import { createMiddleware } from "../middleware/middleware.ts"
import { createHoneyResponse, isHoneyResponse } from "../response/builder.ts"
import { type Honey, honey } from "../routing/app.ts"
import { createLogger } from "./logger.ts"
import { runtimeOf } from "./request-log.ts"
import { ws } from "../ws/route.ts"

/** A json logger at trace whose lines are parsed into `lines`. */
function recording() {
	const lines: Record<string, unknown>[] = []
	const logger = createLogger({
		format: "json",
		level: "trace",
		write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
	})
	return { lines, logger }
}

/** The request-log lines, without the clock and the duration. */
const entries = (lines: Record<string, unknown>[]): Record<string, unknown>[] =>
	lines
		.filter((line) => line.msg === "request")
		.map(({ durationMs, level: _level, msg: _msg, time: _time, ...line }) => ({
			...line,
			timed: typeof durationMs === "number",
		}))

/** An app with every body kind, logging to a recording logger with the request log on. */
function app(log = true) {
	const { lines, logger } = recording()
	const a = honey<{}>().logger(logger).requestLog(log)
	a.get("/json/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))
	a.get("/text").handler((ctx) => ctx.res.text("ok", "héllo"))
	a.get("/empty").handler(() => new Response(null, { status: 204 }) as never)
	a.get("/stream").handler((ctx) =>
		ctx.res.stream(async (writable) => {
			const writer = writable.getWriter()
			for (const part of ["ab", "cd", "ef"]) await writer.write(new TextEncoder().encode(part))
			await writer.close()
		}),
	)
	a.get("/sse").handler((ctx) =>
		ctx.res.sse(async (stream) => {
			await stream.send({ data: "one", event: "m" })
		}),
	)
	a.get("/fail").handler(() => {
		throw new Error("boom")
	})
	return { app: a, lines }
}

const get = (path: string, init?: RequestInit) => new Request(`https://app.example.com${path}`, init)

const servers: HoneyServer[] = []
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.shutdown(0)))
})

/** The raw bytes a real node:http server writes for `path`, without the Date header. */
async function onTheWire(served: Honey<{}>, request: string): Promise<string> {
	const server = serve(served, { env: {}, hostname: "127.0.0.1", port: 0 })
	servers.push(server)
	await new Promise((resolve) => server.once("listening", resolve))
	const { port } = server.address() as AddressInfo
	const out = await new Promise<string>((resolve) => {
		const socket = connect(port, "127.0.0.1")
		let text = ""
		socket.on("data", (chunk) => (text += chunk.toString("latin1")))
		socket.on("close", () => resolve(text))
		socket.write(request)
	})
	return out.replace(/^date: .*\r\n/im, "")
}

describe("requestLog: off by default", () => {
	it("an app that never turned it on writes no request line", async () => {
		const { lines, logger } = recording()
		const a = honey<{}>().logger(logger)
		a.get("/t").handler((ctx) => ctx.res.text("ok", "x"))
		await (await a.fetch(get("/t"), {})).text()
		expect(lines).toEqual([])
	})
})

describe("requestLog: one line per request, from the field catalog", () => {
	// v0: 20df5da772
	// v0: af640785a5
	// v0: b104e364f1
	// v0: 28c838ff81
	// v0: 238cf0a144
	// v0: dfd70438f2
	it("a buffered body: method, path without its query, status, route id, kind, bytes, runtime, a duration", async () => {
		const { app: a, lines } = app()
		await (await a.fetch(get("/json/7?token=secret"), {})).text()
		await (await a.fetch(get("/text"), {})).text()
		await (await a.fetch(get("/empty"), {})).text()
		await (await a.fetch(get("/fail"), {})).text()
		await (await a.fetch(get("/nowhere"), {})).text()
		const common = { method: "GET", runtime: "node", timed: true }
		expect(entries(lines)).toEqual([
			{ ...common, bytes: 10, kind: "json", path: "/json/7", routeId: "GET /json/:id", status: 200 },
			{ ...common, bytes: 6, kind: "text", path: "/text", routeId: "GET /text", status: 200 },
			{ ...common, kind: "empty", path: "/empty", routeId: "GET /empty", status: 204 },
			{ ...common, bytes: expect.any(Number), kind: "json", path: "/fail", routeId: "GET /fail", status: 500 },
			{ ...common, bytes: expect.any(Number), kind: "json", path: "/nowhere", routeId: "", status: 404 },
		])
	})

	// v0: 20c284d514
	it("carries the request id the response echoes", async () => {
		const { app: a, lines } = app()
		a.use(
			createMiddleware(async (_ctx, next) => {
				const res = await next()
				res.headers.set("x-request-id", "r-1")
				return res
			}),
		)
			.get("/with-id")
			.handler((ctx) => ctx.res.text("ok", "x"))
		await (await a.fetch(get("/with-id"), {})).text()
		expect(entries(lines)[0]).toMatchObject({ requestId: "r-1" })
	})
})

describe("requestLog: skip and a failing sink", () => {
	// v0: dbd3492d50
	it("skip answers true for a line not to write; a skip that throws is logged and the line still written", async () => {
		const { lines, logger } = recording()
		const a = honey<{}>()
			.logger(logger)
			.requestLog({
				skip: (entry) => {
					if (entry.path === "/broken") throw new Error("skip broke")
					return entry.path === "/health"
				},
			})
		for (const path of ["/health", "/broken", "/t"]) a.get(path).handler((ctx) => ctx.res.text("ok", "x"))
		for (const path of ["/health", "/broken", "/t"]) await (await a.fetch(get(path), {})).text()
		expect([
			entries(lines).map((entry) => entry.path),
			lines.find((line) => line.msg === "requestLog skip failed")?.err,
		]).toEqual([["/broken", "/t"], expect.objectContaining({ message: "skip broke" })])
	})

	// v0: 5e3943861c
	it("a sink that throws never fails the request", async () => {
		const a = honey<{}>()
			.logger(
				createLogger({
					level: "info",
					write: () => {
						throw new Error("EPIPE")
					},
				}),
			)
			.requestLog(true)
		a.get("/t").handler((ctx) => ctx.res.text("ok", "x"))
		const res = await a.fetch(get("/t"), {})
		expect([res.status, await res.text()]).toEqual([200, "x"])
	})
})

describe("requestLog: a streamed body is logged when it ends", () => {
	it("after the last chunk, with the bytes that went out; an SSE body as sse", async () => {
		const { app: a, lines } = app()
		const res = await a.fetch(get("/stream"), {})
		const before = entries(lines).length
		await res.text()
		await (await a.fetch(get("/sse"), {})).text()
		expect([before, entries(lines).map((entry) => [entry.kind, entry.bytes, entry.status])]).toEqual([
			0,
			[
				["stream", 6, 200],
				["sse", expect.any(Number), 200],
			],
		])
	})

	it("a client that leaves mid-body is logged as aborted, with what went out so far", async () => {
		const { app: a, lines } = app()
		const reader = ((await a.fetch(get("/stream"), {})).body as ReadableStream<Uint8Array>).getReader()
		await reader.read()
		await reader.cancel()
		expect(entries(lines).map((entry) => [entry.status, entry.bytes])).toEqual([["aborted", 2]])
	})

	it("reads the body only when its reader asks: no chunk is pulled ahead", async () => {
		const pulls = { off: 0, on: 0 }
		const counting = (side: "off" | "on") => {
			let n = 0
			return new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						pulls[side]++
						controller.enqueue(new Uint8Array([n++]))
					},
				},
				{ highWaterMark: 0 },
			)
		}
		const reads = async (log: boolean, side: "off" | "on") => {
			const a = honey<{}>().logger(false).requestLog(false)
			if (log) a.logger(recording().logger).requestLog(true)
			a.get("/s").handler(() => new Response(counting(side)) as never)
			const reader = ((await a.fetch(get("/s"), {})).body as ReadableStream<Uint8Array>).getReader()
			await reader.read()
			await reader.read()
			await reader.cancel()
		}
		await reads(false, "off")
		await reads(true, "on")
		expect(pulls).toEqual({ off: 2, on: 2 })
	})
})

describe("requestLog: never changes what goes out", () => {
	it.each([
		["a buffered JSON body", "GET /json/1 HTTP/1.1"],
		["a streamed body", "GET /stream HTTP/1.1"],
		["an SSE body", "GET /sse HTTP/1.1"],
		["a HEAD", "HEAD /stream HTTP/1.1"],
	])("%s: the bytes on the wire are the same with it on and off", async (_name, line) => {
		const request = `${line}\r\nHost: localhost\r\nConnection: close\r\n\r\n`
		const [off, on] = [await onTheWire(app(false).app, request), await onTheWire(app(true).app, request)]
		expect(on).toBe(off)
	})

	it("a HEAD is logged at once, with no bytes", async () => {
		const { app: a, lines } = app()
		await a.fetch(get("/stream", { method: "HEAD" }), {})
		expect(entries(lines).map((entry) => [entry.method, entry.status, entry.bytes])).toEqual([["HEAD", 200, undefined]])
	})

	// v0: a3424ebefa
	it("a 101 is handed back untouched and logged at once as an upgrade", async () => {
		const { lines, logger } = recording()
		const upgraded = new Response(null)
		Object.defineProperty(upgraded, "status", { value: 101 })
		const socket = { close() {}, raw: null, readyState: 1 as const, send() {} }
		const a = honey<{}>()
			.logger(logger)
			.requestLog(true)
			.wsAdapter({ upgrade: () => ({ response: upgraded, socket }) })
		ws(a, "/live").handler({})
		const res = await a.fetch(get("/live", { headers: { connection: "Upgrade", upgrade: "websocket" } }), {})
		expect([res === upgraded, entries(lines).map((entry) => [entry.status, entry.kind])]).toEqual([
			true,
			[[101, "upgrade"]],
		])
	})
})

describe("requestLog: the kind, the runtime and a broken body", () => {
	it.each([["a +json type is json", { "content-type": "application/problem+json; charset=utf-8" }, "json"]])(
		"%s",
		async (_name, headers, kind) => {
			const { app: a, lines } = app()
			a.get("/typed").handler((ctx) => ctx.res.text("ok", "x", { headers }))
			await (await a.fetch(get("/typed"), {})).text()
			expect(entries(lines).map((entry) => entry.kind)).toEqual([kind])
		},
	)

	it("a native response's own request id and type are read without a HoneyResponse", async () => {
		const { app: a, lines } = app()
		a.get("/native").handler(
			() => new Response("{}", { headers: { "content-type": "application/json", "x-request-id": "n-1" } }) as never,
		)
		await (await a.fetch(get("/native"), {})).text()
		expect(entries(lines)[0]).toMatchObject({ kind: "stream", requestId: "n-1" })
	})

	it("a runtime serve() does not know is named unknown", () => {
		expect([runtimeOf({}), runtimeOf()]).toEqual(["unknown", "node"])
	})

	it("a body that breaks mid-stream is logged as aborted, and its reader still sees the failure", async () => {
		const { app: a, lines } = app()
		let sent = false
		const broken = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent) return controller.error(new Error("source broke"))
				sent = true
				controller.enqueue(new Uint8Array([1, 2]))
			},
		})
		a.get("/broken").handler(() => new Response(broken) as never)
		const reader = ((await a.fetch(get("/broken"), {})).body as ReadableStream<Uint8Array>).getReader()
		await reader.read()
		await expect(reader.read()).rejects.toThrow("source broke")
		expect(entries(lines).map((entry) => [entry.status, entry.bytes])).toEqual([["aborted", 2]])
	})
})

describe("requestLog: bytes, early answers and a HoneyResponse stream", () => {
	it("a raw byte body is binary, its bytes counted", async () => {
		const { app: a, lines } = app()
		a.get("/bytes").handler(
			() =>
				createHoneyResponse({
					headers: { "content-type": "application/octet-stream" },
					raw: new Uint8Array([1, 2, 3]),
					status: 200,
				}) as never,
		)
		await (await a.fetch(get("/bytes"), {})).arrayBuffer()
		expect(entries(lines).map((entry) => [entry.kind, entry.bytes])).toEqual([["binary", 3]])
	})

	it("an answer before routing (a bad path, a trailing-slash redirect) is logged with no route", async () => {
		const { lines, logger } = recording()
		const a = honey<{}>().logger(logger).requestLog(true).trailingSlash("strip")
		a.get("/page").handler((ctx) => ctx.res.text("ok", "x"))
		await a.fetch(get("/a%2Fb"), {})
		await a.fetch(get("/page/"), {})
		expect(entries(lines).map((entry) => [entry.status, entry.routeId])).toEqual([
			[400, ""],
			[308, ""],
		])
	})

	it("a HoneyResponse stream stays a HoneyResponse, so the writer takes the same path", async () => {
		const { app: a, lines } = app()
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([7]))
				controller.close()
			},
		})
		a.get("/honey-stream").handler(() => createHoneyResponse({ headers: {}, status: 200, stream }) as never)
		const res = await a.fetch(get("/honey-stream"), {})
		await res.arrayBuffer()
		expect([isHoneyResponse(res), entries(lines).map((entry) => entry.bytes)]).toEqual([true, [1]])
	})

	it("a cancel while a read is pending logs once, as aborted", async () => {
		const { app: a, lines } = app()
		const pending = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }, { highWaterMark: 0 })
		a.get("/pending").handler(() => new Response(pending) as never)
		const reader = ((await a.fetch(get("/pending"), {})).body as ReadableStream<Uint8Array>).getReader()
		const read = reader.read()
		await reader.cancel()
		await read
		expect(entries(lines).map((entry) => entry.status)).toEqual(["aborted"])
	})
})
