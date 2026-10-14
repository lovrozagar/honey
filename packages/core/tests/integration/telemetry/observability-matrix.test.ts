/**
 * Observability end to end (H17): every reporting seam writes through the app's logger, the one
 * sink, and nothing reaches the console or process warnings around it.
 */
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type HoneyServer, serve } from "../../../src/adapters/node/serve.ts"
import { realtime } from "../../../src/realtime/realtime.ts"
import { honey } from "../../../src/routing/app.ts"
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

/* the reduced configuration matrix: logger × onError × requestLog × mode; the full 96 waits for tracing */
const MATRIX = (["default", "custom", "off"] as const).flatMap((logger) =>
	[false, true].flatMap((onError) =>
		[false, true].flatMap((requestLog) =>
			(["development", "production"] as const).map((mode) => [logger, onError, requestLog, mode] as const),
		),
	),
)
/* requestLog with logger(false) cannot work: those four cells refuse to serve instead */
const REFUSED = MATRIX.filter(([logger, , requestLog]) => logger === "off" && requestLog)
const SERVED = MATRIX.filter(([logger, , requestLog]) => !(logger === "off" && requestLog))

/** Serve the matrix's three requests: a plain answer, a handler error, a streamed body. */
async function serveThree(app: ReturnType<typeof honey<{}>>) {
	app.get("/ok").handler((ctx) => ctx.res.json("ok", { ok: true }))
	app.get("/fail").handler(() => {
		throw new Error("db down")
	})
	app.get("/stream").handler((ctx) =>
		ctx.res.stream(async (writable) => {
			const writer = writable.getWriter()
			await writer.write(new TextEncoder().encode("chunk"))
			await writer.close()
		}),
	)
	const answers = []
	for (const path of ["/ok", "/fail", "/stream"]) {
		const res = await app.fetch(new Request(`https://app.example.com${path}?q=1`), {})
		const text = await res.text()
		/* the digest is random per occurrence: everything else must match */
		answers.push([res.status, text.replace(/"digest":"[0-9a-f]{16}",?/, "")])
	}
	return answers
}

/** How many of `lines` carry `msg`, in json or pretty form. */
const count = (lines: string[], msg: string) =>
	lines.filter((line) => line.includes(`"msg":"${msg}"`) || line.includes(` ${msg} `) || line.endsWith(` ${msg}`))
		.length

describe("the reduced observability matrix: logger × onError × requestLog × mode", () => {
	it.each(REFUSED)(
		"logger %s, onError %s, requestLog %s, %s: refuses to serve, naming both",
		async (_l, _o, _r, mode) => {
			vi.stubEnv("NODE_ENV", mode)
			const app = honey<{}>().requestLog(true).logger(false)
			await expect(async () => serveThree(app)).rejects.toThrow("requestLog() is on, but logger(false) writes nothing")
			vi.unstubAllEnvs()
		},
	)

	it.each(SERVED)("logger %s, onError %s, requestLog %s, %s", async (logger, onError, requestLog, mode) => {
		vi.stubEnv("NODE_ENV", mode)
		const baseline = await serveThree(honey<{}>().logger(false))
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
		const custom: string[] = []
		const app = honey<{}>().requestLog(requestLog)
		if (logger === "custom")
			app.logger(createLogger({ format: "json", level: "info", write: (line) => void custom.push(line) }))
		if (logger === "off") app.logger(false)
		const seen: unknown[] = []
		if (onError) app.onError((error) => void seen.push(error))
		const answers = await serveThree(app)
		const written = logger === "custom" ? custom : stdout.mock.calls.map(([line]) => String(line))
		stdout.mockRestore()
		vi.unstubAllEnvs()
		expect([
			answers,
			seen.length,
			count(written, "unhandled error"),
			count(written, "request"),
			written.some((line) => line.includes("q=1")),
		]).toEqual([baseline, onError ? 1 : 0, logger === "off" ? 0 : 1, requestLog ? 3 : 0, false])
	})
})
