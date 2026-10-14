/**
 * Observability end to end (H17): every reporting seam writes through the app's logger, the one
 * sink, and nothing reaches the console or process warnings around it. Then the configuration
 * matrix (dx/observability.md): 96 cells of logger × onError × requestLog × tracer × trustInbound
 * × mode, each serving a plain answer, a handler error, a stream, SSE and a proxy hop, its answers
 * identical to an unconfigured server's, every line and span where the contract puts it, and no
 * query or credential in any of them.
 */
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type HoneyServer, serve } from "../../../src/adapters/node/serve.ts"
import { requestId } from "../../../src/middleware/request-id.ts"
import { proxy } from "../../../src/proxy/proxy.ts"
import { realtime } from "../../../src/realtime/realtime.ts"
import { honey } from "../../../src/routing/app.ts"
import { type Recorded, recorder } from "../../../src/telemetry/__fixtures__/recording-tracer.ts"
import { createLogger } from "../../../src/telemetry/logger.ts"
import type { WSAdapter, WSContext, WSHandler } from "../../../src/ws/contract.ts"

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

/** Each line as [msg, phase or route, the error's message]. */
const summary = (lines: Record<string, unknown>[]) =>
	lines.map((line) => [line.msg, line.phase ?? null, (line.err as { message?: string } | undefined)?.message ?? null])

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

/** An adapter that opens each upgrade at once and lets a test drive the socket. */
function openingAdapter() {
	const handlers: WSHandler<unknown>[] = []
	const socket: WSContext = { close: () => {}, raw: null, readyState: 1, send: () => {} }
	const adapter: WSAdapter = {
		upgrade(_req, _env, handler) {
			handlers.push(handler)
			handler.onOpen?.(undefined, socket)
			const response = new Response(null)
			Object.defineProperty(response, "status", { value: 101 })
			return { response, socket }
		},
	}
	return { adapter, handlers, socket }
}

const handshake = (path: string) =>
	new Request(`https://app.example.com${path}`, { headers: { connection: "Upgrade", upgrade: "websocket" } })

const servers: HoneyServer[] = []
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.shutdown(0)))
	vi.restoreAllMocks()
})

describe("the app logger reaches the ws and realtime sessions", () => {
	it("a ws callback that fails with no onError of its own", async () => {
		const { lines, logger } = recording()
		const { adapter, handlers, socket } = openingAdapter()
		const app = honey<{}>().logger(logger).wsAdapter(adapter)
		app.ws("/live").handler({
			onMessage: () => {
				throw new Error("message broke")
			},
		})
		await app.fetch(handshake("/live"), {})
		handlers[0]?.onMessage?.(undefined, socket, "x")
		await settle()
		expect(summary(lines)).toEqual([["callback failed", "websocket message", "message broke"]])
	})

	it("a realtime handler that fails with no onError of its own", async () => {
		const { lines, logger } = recording()
		const { adapter } = openingAdapter()
		const app = honey<{}>().logger(logger).wsAdapter(adapter)
		realtime(app, "/rt", {
			handler: () => {
				throw new Error("handler broke")
			},
		})
		await app.fetch(handshake("/rt"), {})
		await settle()
		expect(summary(lines)).toEqual([["callback failed", "realtime handler", "handler broke"]])
	})
})

describe("the app logger reaches the request's producers, background tasks and the bridge", () => {
	// v0: 739857836c
	it("an SSE or stream producer that fails after its body started", async () => {
		const { lines, logger } = recording()
		const app = honey<{}>().logger(logger)
		app.get("/sse").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({ data: "one", event: "m" })
				throw new Error("producer broke")
			}),
		)
		await (await app.fetch(new Request("https://app.example.com/sse"), {})).text().catch(() => "")
		await settle()
		expect(lines.map((line) => [line.msg, line.path, (line.err as { message: string }).message])).toEqual([
			["stream producer failed", "/sse", "producer broke"],
		])
	})

	it("a background task that rejects, where there is no waitUntil", async () => {
		const { lines, logger } = recording()
		const app = honey<{}>().logger(logger)
		app.get("/bg").handler((ctx) => {
			ctx.background(Promise.reject(new Error("task broke")))
			return ctx.res.text("ok", "x")
		})
		await app.fetch(new Request("https://app.example.com/bg"), {})
		await settle()
		expect(lines.map((line) => [line.msg, line.path, (line.err as { message: string }).message])).toEqual([
			["background task failed", "/bg", "task broke"],
		])
	})

	it("the Node bridge: a failure it answers with 500 goes to the app logger, never to process warnings", async () => {
		const { lines, logger } = recording()
		const warning = vi.spyOn(process, "emitWarning")
		const app = honey<{}>().logger(logger)
		app.get("/page").handler((ctx) => ctx.res.text("ok", "x"))
		/* a builder left without .handler() makes the app refuse to serve: the bridge answers 500 */
		app.get("/unfinished")
		const server = serve(app, { env: {}, hostname: "127.0.0.1", port: 0 })
		servers.push(server)
		await new Promise((resolve) => server.once("listening", resolve))
		const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/page`)
		expect([res.status, summary(lines), warning.mock.calls]).toEqual([
			500,
			[["serve failed", null, expect.stringContaining("never got a .handler()")]],
			[],
		])
	})
})

/* logger × onError × requestLog × tracer × trustInbound × mode: 96 cells */
const MATRIX = (["default", "custom", "off"] as const).flatMap((logger) =>
	[false, true].flatMap((onError) =>
		[false, true].flatMap((requestLog) =>
			[false, true].flatMap((tracer) =>
				[false, true].flatMap((trustInbound) =>
					(["development", "production"] as const).map((mode) => ({
						logger,
						mode,
						onError,
						requestLog,
						tracer,
						trustInbound,
					})),
				),
			),
		),
	),
)
/* requestLog with logger(false) cannot work: those cells refuse to serve instead */
type Cell = (typeof MATRIX)[number]
const REFUSED = MATRIX.filter((cell) => cell.logger === "off" && cell.requestLog)
const SERVED = MATRIX.filter((cell) => !(cell.logger === "off" && cell.requestLog))

/** The cell's app, its custom sink, what its onError saw, and the spans its tracer recorded. */
function configured({ logger, onError, requestLog, tracer, trustInbound }: Cell) {
	const custom: string[] = []
	const app = honey<{}>().requestLog(requestLog)
	if (logger === "custom")
		app.logger(createLogger({ format: "json", level: "info", write: (line) => void custom.push(line) }))
	if (logger === "off") app.logger(false)
	const seen: unknown[] = []
	if (onError) app.onError((error) => void seen.push(error))
	const { spans, telemetry } = recorder()
	if (tracer) app.telemetry({ ...telemetry, trustInbound })
	return { app, custom, seen, spans }
}

const INBOUND_TRACE = "0af7651916cd43dd8448eb211c80319c"
/** What every request carries: a query, credentials, and an id and a trace a client picked. */
const INBOUND = {
	authorization: "Bearer SECRET-TOKEN",
	cookie: "session=SECRET-SESSION",
	traceparent: `00-${INBOUND_TRACE}-b7ad6b7169203331-01`,
	"x-request-id": "client-picked-id",
}
const PATHS = ["/ok", "/fail", "/stream", "/sse", "/api/up"]

/** The upstream a proxy hop reaches. */
const upstream = honey<{}>()
upstream.all("/*rest").handler((ctx) => ctx.res.text("ok", `upstream ${ctx.path}`))

/** Serve the matrix's five requests: a plain answer, a handler error, a stream, SSE and a proxy hop. */
async function serveFive(app: ReturnType<typeof honey<{}>>, trustInbound: boolean) {
	const routed = app.use(requestId({ trustInbound }))
	routed.get("/ok").handler((ctx) => ctx.res.json("ok", { ok: true }))
	routed.get("/fail").handler(() => {
		throw new Error("db down")
	})
	routed.get("/stream").handler((ctx) =>
		ctx.res.stream(async (writable) => {
			const writer = writable.getWriter()
			await writer.write(new TextEncoder().encode("chunk"))
			await writer.close()
		}),
	)
	routed.get("/sse").handler((ctx) => ctx.res.sse(async (stream) => stream.send({ data: "one", event: "m" })))
	routed
		.all("/api/*rest")
		.handler(
			proxy({ destination: (_ctx, url, init) => upstream.fetch(new Request(`http://upstream.test${url}`, init), {}) }),
		)
	const answers = []
	const ids = []
	for (const path of PATHS) {
		const res = await app.fetch(new Request(`https://app.example.com${path}?q=1`, { headers: INBOUND }), {})
		const text = await res.text()
		ids.push(res.headers.get("x-request-id"))
		/* the digest is random per occurrence: everything else must match */
		answers.push([res.status, text.replace(/"digest":"[0-9a-f]{16}",?/, "")])
	}
	return { answers, ids }
}

/** How many of `lines` carry `msg`, in json or pretty form. */
const count = (lines: string[], msg: string) =>
	lines.filter((line) => line.includes(`"msg":"${msg}"`) || line.includes(` ${msg} `) || line.endsWith(` ${msg}`))
		.length

/** The spans by name, sorted, each with how many times it ended; and whether the roots continued the trace. */
function spanSet(spans: readonly Recorded[]) {
	const roots = spans.filter((s) => s.kind === "server")
	return {
		continued: roots.map((r) => r.parent !== null),
		ended: spans.every((s) => s.ended === 1),
		names: spans.map((s) => s.name).sort(),
	}
}

const TRACED_NAMES = [
	"GET /api/*rest",
	"GET /fail",
	"GET /ok",
	"GET /sse",
	"GET /stream",
	"http.error",
	"http.handler",
	"http.handler",
	"http.handler",
	"http.handler",
	"http.handler",
	"http.proxy",
	...Array.from({ length: 5 }, () => "middleware.requestId"),
]

const NAME =
	"logger $logger, onError $onError, requestLog $requestLog, tracer $tracer, trustInbound $trustInbound, $mode"

describe("the observability matrix: refused cells", () => {
	it.each(REFUSED)(`${NAME}: refuses to serve, naming both`, async ({ mode, trustInbound }) => {
		vi.stubEnv("NODE_ENV", mode)
		const app = honey<{}>().requestLog(true).logger(false)
		await expect(async () => serveFive(app, trustInbound)).rejects.toThrow(
			"requestLog() is on, but logger(false) writes nothing",
		)
		vi.unstubAllEnvs()
	})
})

describe("the observability matrix: logger × onError × requestLog × tracer × trustInbound × mode", () => {
	it.each(SERVED)(NAME, async (cell) => {
		const { logger, onError, requestLog, tracer, trustInbound } = cell
		vi.stubEnv("NODE_ENV", cell.mode)
		const baseline = await serveFive(honey<{}>().logger(false), trustInbound)
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
		const { app, custom, seen, spans } = configured(cell)
		const { answers, ids } = await serveFive(app, trustInbound)
		await new Promise((resolve) => setTimeout(resolve, 0))
		const written = logger === "custom" ? custom : stdout.mock.calls.map(([line]) => String(line))
		stdout.mockRestore()
		vi.unstubAllEnvs()
		const unhandled = written.filter((line) => line.includes("unhandled error"))
		const exported = JSON.stringify(spans.map((s) => [s.name, s.attributes, s.events]))
		expect([
			answers,
			ids.every((id) => id !== null && /^[\w.:+/=-]{1,128}$/.test(id)),
			ids.every((id) => (id === "client-picked-id") === trustInbound),
			seen.length,
			unhandled.length,
			unhandled.every((line) => line.includes("trace_id") === tracer),
			count(written, "request"),
			[...written, exported].some((text) => text.includes("q=1") || text.includes("SECRET")),
			spanSet(spans),
		]).toEqual([
			baseline.answers,
			true,
			true,
			onError ? 1 : 0,
			logger === "off" ? 0 : 1,
			true,
			requestLog ? PATHS.length : 0,
			false,
			tracer
				? { continued: PATHS.map(() => trustInbound), ended: true, names: TRACED_NAMES }
				: { continued: [], ended: true, names: [] },
		])
	})
})
