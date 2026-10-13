import type { IncomingMessage, Server } from "node:http"
import { createServer, ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { Readable, type Duplex } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { Honey } from "./index.ts"
import { bodyKind, rawBodyOf } from "./body-kind.ts"
import { isHoneyResponse } from "./honey-response.ts"
import {
	ABORT_REQUEST,
	BODY_OVERFLOW,
	DEFAULT_MAX_REQUEST_BODY,
	incomingToNodeRequest,
	nodeRequestUrl,
	type NodeRequestOptions,
} from "./node-request.ts"
import type { WSAdapter } from "./ws/cloudflare.ts"
import type { NodeUpgradeData } from "./ws/node.ts"

export type NodeServeOptions<TEnv> = {
	env: TEnv
	hostname?: string
	port?: number
	/**
	 * Largest request body a read accepts, in bytes. A bigger one fails the read with 413 and the
	 * connection is closed. `0` disables the cap. Default 128 MiB, as on Bun.
	 */
	maxRequestBodySize?: number
	/** Node's `server.headersTimeout`, in ms (Node's default: 60 000). */
	headersTimeout?: number
	/** Node's `server.requestTimeout`, in ms (Node's default: 300 000). */
	requestTimeout?: number
	/** Node's `server.keepAliveTimeout`, in ms (Node's default: 5 000). */
	keepAliveTimeout?: number
	/**
	 * How long an upgrade request may take to become a WebSocket (or be answered), in ms.
	 * Default 30 000.
	 */
	upgradeTimeout?: number
	/** Errors the adapter could not hand to the app (it then answers 500). Default: `console.error`. */
	onError?: (error: unknown) => void
}

/** Buffer known-size bodies up to this many bytes, then `res.end(buf)`. */
const BUFFER_BODY_MAX = 256 * 1024
const DEFAULT_UPGRADE_TIMEOUT = 30_000

/**
 * Hop-by-hop headers (RFC 9110 §7.6.1): they describe one connection, so a response from
 * somewhere else (a proxied `fetch()`) must not carry them onto this one. Node writes its own.
 */
const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
])

// Node's `Readable.fromWeb` wants `node:stream/web` streams; DOM/Bun brands do not overlap.
function asNodeWebStream(stream: ReadableStream<Uint8Array>): import("node:stream/web").ReadableStream {
	return stream as unknown as import("node:stream/web").ReadableStream
}

/** `null` when the request target or `Host` is invalid (see `nodeRequestUrl`); the caller answers 400. */
function incomingToRequest(req: IncomingMessage, opts: NodeRequestOptions): Request | null {
	const url = nodeRequestUrl(req)
	return url === null ? null : incomingToNodeRequest(req, url, opts)
}

function collectNodeHeaders(response: Response, extra?: Record<string, string>): Record<string, string | string[]> {
	const headerObj: Record<string, string | string[]> = {}
	let hasSetCookie = false
	/* headers a `Connection` header names are hop-by-hop too */
	const named = response.headers.get("connection")
	const dropNamed =
		named === null
			? null
			: named
					.toLowerCase()
					.split(",")
					.map((t) => t.trim())
	response.headers.forEach((value, key) => {
		if (key === "set-cookie") {
			hasSetCookie = true
			return
		}
		if (HOP_BY_HOP.has(key) && !(key === "upgrade" && response.status === 101)) return
		if (dropNamed !== null && dropNamed.includes(key)) return
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

function statusMessage(response: Response): string | undefined {
	return response.statusText === "" ? undefined : response.statusText
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
		res.writeHead(
			response.status,
			statusMessage(response),
			collectNodeHeaders(response, { "content-length": String(byteLength) }),
		)
		res.end(raw)
		return
	}

	const body = response.body
	if (body === null) {
		res.writeHead(response.status, statusMessage(response), collectNodeHeaders(response))
		res.end()
		return
	}

	if (shouldBufferBody(response)) {
		const buf = Buffer.from(await response.arrayBuffer())
		if (res.destroyed) return
		res.writeHead(
			response.status,
			statusMessage(response),
			collectNodeHeaders(response, { "content-length": String(buf.byteLength) }),
		)
		res.end(buf)
		return
	}

	const headers = collectNodeHeaders(response)
	/* a stream's declared length is never trusted (`fetch()` keeps the encoded length of a body it
	 * decoded): Node chunks it, so a wrong length cannot truncate it or desynchronize keep-alive */
	delete headers["content-length"]
	res.writeHead(response.status, statusMessage(response), headers)
	await pipeBody(body, res)
}

function isWebSocketUpgrade(req: IncomingMessage): boolean {
	return req.headers.upgrade?.toLowerCase() === "websocket"
}

/**
 * The body of a request that came in on Node's `'upgrade'` path but is served as a normal
 * request. Node with `shouldUpgradeCallback` never sends those there; before that,
 * some versions leave the body on the socket (the first bytes in `head`). Only a declared
 * `content-length` can be read back that way.
 */
function upgradeBodySource(
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
): AsyncIterable<Buffer> | null | "unsupported" {
	/* newer Node parses the body into `req` itself */
	if (!req.complete) return null
	if (req.headers["transfer-encoding"] !== undefined) return "unsupported"
	const declared = Number(req.headers["content-length"] ?? 0)
	if (!Number.isSafeInteger(declared) || declared <= 0) return null
	return (async function* () {
		let remaining = declared
		if (head.byteLength > 0) {
			const first = head.subarray(0, remaining)
			remaining -= first.byteLength
			yield first
		}
		if (remaining <= 0) return
		for await (const chunk of socket as AsyncIterable<Buffer>) {
			const part = chunk.subarray(0, remaining)
			remaining -= part.byteLength
			yield part
			if (remaining <= 0) return
		}
	})()
}

/** Answer on a socket Node handed over through `'upgrade'`, with a real `ServerResponse`. */
function responseOnSocket(req: IncomingMessage, socket: Socket): ServerResponse {
	const res = new ServerResponse(req)
	/* the connection ends with this response */
	res.shouldKeepAlive = false
	res.assignSocket(socket)
	res.once("finish", () => {
		res.detachSocket(socket)
		socket.end()
	})
	return res
}

/** A response written before any Request exists (bad target or `Host`): plain text, then close. */
function writeRawStatus(socket: Duplex, status: 400 | 503, text: string): void {
	if (socket.destroyed) return
	socket.end(
		`HTTP/1.1 ${status} ${text}\r\nconnection: close\r\ncontent-type: text/plain\r\ncontent-length: ${text.length}\r\n\r\n${text}`,
	)
}

export type HoneyServer = Server & {
	shutdown(timeout?: number): Promise<void>
}

export function serve<TEnv>(
	app: Honey<TEnv, unknown, unknown, unknown, unknown, string, string>,
	options: NodeServeOptions<TEnv>,
): HoneyServer {
	const env = options.env
	const requestOpts: NodeRequestOptions = { maxBodySize: options.maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY }
	const upgradeTimeout = options.upgradeTimeout ?? DEFAULT_UPGRADE_TIMEOUT
	const reportError =
		options.onError ??
		((err: unknown): void => {
			console.error("honey: request failed in the Node adapter", err)
		})
	/* in-flight requests and their responses: shutdown aborts their signals */
	const inflight = new Map<ServerResponse, Request>()
	/* sockets that became WebSockets: shutdown closes them */
	const upgraded = new Set<Duplex>()
	let draining = false

	const abort = (request: Request, reason: unknown): void => {
		;(request as unknown as { [ABORT_REQUEST]?: (r?: unknown) => void })[ABORT_REQUEST]?.(reason)
	}
	const wsAdapter = (): WSAdapter | null =>
		(app as unknown as { _graph: { settings: { wsAdapter: WSAdapter | null } } })._graph.settings.wsAdapter

	/** One HTTP request, whether it came in normally or on the `'upgrade'` path. */
	const handle = async (
		req: IncomingMessage,
		res: ServerResponse,
		bodySource: AsyncIterable<Buffer> | null = null,
	): Promise<void> => {
		if (draining) {
			res.writeHead(503, { connection: "close" })
			res.end("Service Unavailable")
			return
		}
		let request: Request | null = null
		try {
			request = incomingToRequest(req, bodySource === null ? requestOpts : { ...requestOpts, bodySource })
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
			/* a body over the cap was left unread on the socket: never reuse the connection */
			if ((request as unknown as { [BODY_OVERFLOW]?: boolean })[BODY_OVERFLOW] === true) res.shouldKeepAlive = false
			await responseToNode(response, res)
		} catch (err) {
			reportError(err)
			if (!res.headersSent) {
				res.writeHead(500, { "content-type": "text/plain" })
				res.end("Internal Server Error")
			} else if (!res.destroyed) {
				res.destroy()
			}
		} finally {
			if (request !== null) inflight.delete(res)
			/* a keep-alive connection that just went idle would hold `close()` open until it times out */
			if (draining) setImmediate(() => server.closeIdleConnections())
		}
	}

	const server = createServer(
		{
			/* only a WebSocket handshake takes the upgrade path; `Upgrade: h2c` and the like are
			 * served as the normal requests they are (where Node has `shouldUpgradeCallback`; older Node ignores the option) */
			shouldUpgradeCallback: isWebSocketUpgrade,
		} as Parameters<typeof createServer>[0],
		(req, res) => {
			void handle(req, res)
		},
	)
	if (options.headersTimeout !== undefined) server.headersTimeout = options.headersTimeout
	if (options.requestTimeout !== undefined) server.requestTimeout = options.requestTimeout
	if (options.keepAliveTimeout !== undefined) server.keepAliveTimeout = options.keepAliveTimeout

	/** A WebSocket handshake, or (on Node without `shouldUpgradeCallback`) any request with `Upgrade`. */
	const handleUpgrade = async (req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> => {
		if (!isWebSocketUpgrade(req)) {
			const source = upgradeBodySource(req, socket, head)
			if (source === "unsupported") {
				writeRawStatus(socket, 400, "Bad Request")
				return
			}
			socket.setTimeout(0)
			await handle(req, responseOnSocket(req, socket), source)
			return
		}
		if (draining) {
			writeRawStatus(socket, 503, "Service Unavailable")
			return
		}
		const request = incomingToRequest(req, requestOpts)
		if (request === null) {
			writeRawStatus(socket, 400, "Bad Request")
			return
		}
		socket.once("close", () => {
			abort(request, new DOMException("The client disconnected", "AbortError"))
		})
		const state: NodeUpgradeData = { head, req, socket, upgraded: false }
		const envWithUpgrade = { ...env, __nodeUpgrade: state } as TEnv
		let response: Response
		try {
			const maybe = app.fetch(request, envWithUpgrade)
			response = maybe instanceof Promise ? await maybe : maybe
		} catch (err) {
			reportError(err)
			/* once ws wrote the 101 the socket is a WebSocket: an HTTP status would corrupt it */
			if (!state.upgraded) {
				socket.setTimeout(0)
				const res = responseOnSocket(req, socket)
				res.writeHead(500, { "content-type": "text/plain" })
				res.end("Internal Server Error")
			}
			return
		}
		if (state.upgraded) {
			socket.setTimeout(0)
			upgraded.add(socket)
			socket.once("close", () => upgraded.delete(socket))
			return
		}
		if (socket.destroyed) {
			await response.body?.cancel().catch(() => {})
			return
		}
		/* not upgraded (auth rejected, 404, 426, an SSE route…): a real response, streamed, every header kept */
		socket.setTimeout(0)
		try {
			await responseToNode(response, responseOnSocket(req, socket))
		} catch (err) {
			reportError(err)
			socket.destroy()
		}
	}

	server.on("upgrade", (req: IncomingMessage, duplex: Duplex, head: Buffer) => {
		const socket = duplex as Socket
		/* first: a reset while the app is still deciding must not become an uncaught 'error' event */
		socket.on("error", () => {
			socket.destroy()
		})
		if (upgradeTimeout > 0) socket.setTimeout(upgradeTimeout, () => socket.destroy())
		handleUpgrade(req, socket, head).catch((err: unknown) => {
			reportError(err)
			socket.destroy()
		})
	})

	server.listen(options?.port ?? 0, options?.hostname)

	const honeyServer = server as HoneyServer
	/**
	 * Stop accepting connections and let in-flight requests finish. Responses already streaming
	 * (SSE, `generate()`) never finish on their own, so their `ctx.signal` aborts now and they
	 * end; WebSockets get a 1001 close. Handlers still working get until `timeout`; then their
	 * signal aborts and every connection, WebSockets included, is closed.
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
			wsAdapter()?.closeAll?.(1001, "server shutting down")
			if (timeout !== undefined) {
				timer = setTimeout(() => {
					for (const request of inflight.values()) abort(request, shutdownReason())
					for (const socket of upgraded) socket.destroy()
					server.closeAllConnections()
				}, timeout)
			}
		})
	}

	return honeyServer
}
