import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { createServer } from "node:http"
import { Readable, type Duplex } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { Honey } from "./index.ts"
import { bodyKind, rawBodyOf } from "./body-kind.ts"
import { isHoneyResponse } from "./honey-response.ts"
import { ABORT_REQUEST, incomingToNodeRequest, nodeRequestUrl } from "./node-request.ts"

type ServeOptions<TEnv> = {
	env: TEnv
	hostname?: string
	port?: number
}

/** Buffer known-size bodies up to this many bytes, then `res.end(buf)`. */
const BUFFER_BODY_MAX = 256 * 1024

// Node's `Readable.fromWeb` wants `node:stream/web` streams; DOM/Bun brands do not overlap.
function asNodeWebStream(stream: ReadableStream<Uint8Array>): import("node:stream/web").ReadableStream {
	return stream as unknown as import("node:stream/web").ReadableStream
}

/** `null` when the request target or `Host` is invalid (see `nodeRequestUrl`); the caller answers 400. */
function incomingToRequest(req: IncomingMessage): Request | null {
	const url = nodeRequestUrl(req)
	return url === null ? null : incomingToNodeRequest(req, url)
}

function collectNodeHeaders(response: Response, extra?: Record<string, string>): Record<string, string | string[]> {
	const headerObj: Record<string, string | string[]> = {}
	let hasSetCookie = false
	response.headers.forEach((value, key) => {
		if (key === "set-cookie") {
			hasSetCookie = true
			return
		}
		headerObj[key] = value
	})
	if (hasSetCookie) {
		const setCookies = response.headers.getSetCookie()
		if (setCookies.length > 0) headerObj["set-cookie"] = setCookies
	}
	if (extra) Object.assign(headerObj, extra)
	return headerObj
}

/**
 * Buffer a body only when its size is known and small: a body Honey built in memory, or one
 * that declares `content-length`. Everything else (SSE, `generate()`, a proxied stream, an
 * untagged `new Response(stream)`) is piped as it is produced, whatever its content type.
 */
function shouldBufferBody(response: Response): boolean {
	if (bodyKind(response) !== "buffered") return false
	const len = Number(response.headers.get("content-length"))
	return Number.isFinite(len) && len <= BUFFER_BODY_MAX
}

/**
 * Pipe a body to the socket. When the response closes first (client gone, shutdown), the
 * reader is cancelled so the producer stops; nothing is left reading.
 */
async function pipeBody(stream: ReadableStream<Uint8Array>, res: ServerResponse): Promise<void> {
	const readable = Readable.fromWeb(asNodeWebStream(stream))
	const onClose = (): void => {
		if (!res.writableFinished) readable.destroy()
	}
	res.once("close", onClose)
	try {
		await pipeline(readable, res)
	} catch {
		if (!res.destroyed) res.destroy()
		/* `destroy()` cancels the web reader; this covers a stream that errored on its own */
		stream.cancel().catch(() => {})
	} finally {
		res.off("close", onClose)
	}
}

async function responseToNode(response: Response, res: ServerResponse): Promise<void> {
	if (isHoneyResponse(response)) {
		const raw = response.rawBody
		if (typeof raw === "string" || raw instanceof Uint8Array) {
			const byteLength = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength
			res.writeHead(response.status, { ...response.plainHeaders, "content-length": String(byteLength) })
			res.end(raw)
			return
		}
		const stream = response.body
		if (stream === null) {
			res.writeHead(response.status, response.plainHeaders)
			res.end()
			return
		}
		res.writeHead(response.status, response.plainHeaders)
		await pipeBody(stream, res)
		return
	}

	const raw = rawBodyOf(response)
	if (typeof raw === "string" || raw instanceof Uint8Array) {
		const byteLength = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength
		res.writeHead(response.status, collectNodeHeaders(response, { "content-length": String(byteLength) }))
		res.end(raw)
		return
	}

	const body = response.body
	if (body === null) {
		res.writeHead(response.status, collectNodeHeaders(response))
		res.end()
		return
	}

	if (shouldBufferBody(response)) {
		const buf = Buffer.from(await response.arrayBuffer())
		if (res.destroyed) return
		res.writeHead(response.status, collectNodeHeaders(response, { "content-length": String(buf.byteLength) }))
		res.end(buf)
		return
	}

	res.writeHead(response.status, collectNodeHeaders(response))
	await pipeBody(body, res)
}

export type HoneyServer = Server & {
	shutdown(timeout?: number): Promise<void>
}

export function serve<TEnv>(
	app: Honey<TEnv, unknown, unknown, unknown, unknown, string, string>,
	options: ServeOptions<TEnv>,
): HoneyServer {
	const env = options.env
	/* in-flight requests and their responses: shutdown aborts their signals */
	const inflight = new Map<ServerResponse, Request>()
	let draining = false

	const abort = (request: Request, reason: unknown): void => {
		;(request as unknown as { [ABORT_REQUEST]?: (r?: unknown) => void })[ABORT_REQUEST]?.(reason)
	}

	const server = createServer(async (req, res) => {
		if (draining) {
			res.writeHead(503, { connection: "close" })
			res.end("Service Unavailable")
			return
		}
		let request: Request | null = null
		try {
			request = incomingToRequest(req)
			if (request === null) {
				res.writeHead(400, { connection: "close", "content-type": "text/plain" })
				res.end("Bad Request")
				return
			}
			const tracked = request
			inflight.set(res, tracked)
			/* the response closed before it finished: the client left (or shutdown cut it) */
			res.once("close", () => {
				if (!res.writableFinished) abort(tracked, new DOMException("The client disconnected", "AbortError"))
			})
			const maybe = app.fetch(request, env)
			const response = maybe instanceof Promise ? await maybe : maybe
			/* while draining, tell keep-alive clients this connection ends with the response */
			if (draining) res.shouldKeepAlive = false
			await responseToNode(response, res)
		} catch {
			if (!res.headersSent) {
				res.writeHead(500)
				res.end("Internal Server Error")
			} else if (!res.destroyed) {
				res.destroy()
			}
		} finally {
			if (request !== null) inflight.delete(res)
			/* a keep-alive connection that just went idle would hold `close()` open until it times out */
			if (draining) setImmediate(() => server.closeIdleConnections())
		}
	})

	/* WebSocket upgrade handling */
	server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		try {
			const request = incomingToRequest(req)
			if (request === null) {
				socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n")
				return
			}
			const envWithUpgrade = { ...env, __nodeUpgrade: { head, req, socket } } as TEnv
			const maybe = app.fetch(request, envWithUpgrade)
			const response = maybe instanceof Promise ? await maybe : maybe

			if (response.status !== 101) {
				const text = await response.text()
				socket.write(
					`HTTP/1.1 ${response.status} ${response.statusText ?? "Error"}\r\n` +
						"content-type: application/json\r\n" +
						`\r\n${text}`,
				)
				socket.destroy()
			}
		} catch {
			socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n")
			socket.destroy()
		}
	})

	server.listen(options?.port ?? 0, options?.hostname)

	const honeyServer = server as HoneyServer
	/**
	 * Stop accepting connections and let in-flight requests finish. Responses already streaming
	 * (SSE, `generate()`) never finish on their own, so their `ctx.signal` aborts now and they
	 * end; handlers still working get until `timeout`, then their signal aborts and every
	 * connection is closed.
	 */
	honeyServer.shutdown = (timeout?: number): Promise<void> => {
		draining = true
		const shutdownReason = (): DOMException => new DOMException("The server is shutting down", "AbortError")

		return new Promise<void>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined
			/* fires once every connection has closed */
			server.close(() => {
				if (timer !== undefined) clearTimeout(timer)
				resolve()
			})
			server.closeIdleConnections()
			for (const [res, request] of inflight) {
				if (res.headersSent) abort(request, shutdownReason())
			}
			if (timeout !== undefined) {
				timer = setTimeout(() => {
					for (const request of inflight.values()) abort(request, shutdownReason())
					server.closeAllConnections()
				}, timeout)
			}
		})
	}

	return honeyServer
}
