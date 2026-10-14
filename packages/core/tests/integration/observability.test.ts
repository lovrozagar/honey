/**
 * Observability end to end (H17): every reporting seam writes through the app's logger, the one
 * sink, and nothing reaches the console or process warnings around it.
 */
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type HoneyServer, serve } from "../../src/adapters/node/serve.ts"
import { realtime } from "../../src/realtime/realtime.ts"
import { honey } from "../../src/routing/app.ts"
import { createLogger } from "../../src/telemetry/logger.ts"
import type { WSAdapter, WSContext, WSHandler } from "../../src/ws/contract.ts"

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
