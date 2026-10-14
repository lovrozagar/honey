/**
 * The Node adapter's server: it hands each request to the app through the request view, writes
 * the answer (`response.ts`), answers what it refuses itself, and drains on shutdown. A WebSocket
 * handshake takes Node's `'upgrade'` path: the raw socket rides on the request view under
 * `NODE_UPGRADE`, `ws` writes the 101 itself, and the body writer never touches an upgraded socket.
 */
import { createServer, type IncomingMessage, type Server, ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { GRAPH } from "../../routing/app.ts"
import type { HoneyGraph } from "../../routing/register.ts"
import type { AppSettings } from "../../routing/settings.ts"
import { NODE_UPGRADE, type NodeUpgrade, nodeWebSocket } from "../../ws/node.ts"
import { DEFAULT_MAX_REQUEST_BODY } from "../serve.ts"
import { ABORT_REQUEST, BODY_OVERFLOW, nodeRequest } from "./request.ts"
import { writeResponse } from "./response.ts"
import { nodeRequestUrl } from "./url.ts"

export type NodeServeOptions<TEnv> = {
	env: TEnv
	hostname?: string
	/** Default: a free port. */
	port?: number
	/** The largest request body a read accepts, in bytes; over it the read fails with 413. `0` turns it off. Default 128 MiB. */
	maxRequestBodySize?: number
	/** Node's `server.headersTimeout`, in ms. */
	headersTimeout?: number
	/** Node's `server.requestTimeout`, in ms. */
	requestTimeout?: number
	/** Node's `server.keepAliveTimeout`, in ms. */
	keepAliveTimeout?: number
	/** How long an upgrade request may take to become a WebSocket or be answered, in ms. Default 30 000. */
	upgradeTimeout?: number
	/** Errors the adapter could not hand to the app (it then answers 500). Default: a process warning. */
	onError?: (error: unknown) => void
}

export type HoneyServer = Server & {
	/**
	 * Stop accepting connections and let in-flight requests finish. Responses already streaming
	 * never finish on their own, so their signal aborts now. After `timeout` ms, everything still
	 * working is aborted and every connection closes.
	 */
	shutdown(timeout?: number): Promise<void>
}

type FetchApp<TEnv> = { fetch(request: Request, env: TEnv): Response | Promise<Response> }

function abort(request: Request, reason?: unknown): void {
	;(request as unknown as Record<typeof ABORT_REQUEST, (reason?: unknown) => void>)[ABORT_REQUEST](reason)
}

function shuttingDown(): DOMException {
	return new DOMException("The server is shutting down", "AbortError")
}

function reportAsWarning(error: unknown): void {
	process.emitWarning(error instanceof Error ? error : String(error), "HoneyAdapterError")
}
function answerPlain(res: ServerResponse, status: 400 | 500 | 503, text: string, close: boolean): void {
	const headers = { "content-length": String(text.length), "content-type": "text/plain" }
	/* the reason phrase is explicit: a writeHead that threw on a bad header already set "OK" */
	res.writeHead(status, text, close ? { connection: "close", ...headers } : headers)
	res.end(text)
}

type Drain = {
	draining: boolean
	readonly inflight: Map<ServerResponse, Request>
	/** sockets that became WebSockets: shutdown cuts them at its timeout */
	readonly upgraded: Set<Socket>
	/** the honey app's settings, for its ws adapter; `null` for a plain fetch handler */
	readonly settings: AppSettings | null
}

const DEFAULT_UPGRADE_TIMEOUT = 30_000

function isWebSocketUpgrade(incoming: IncomingMessage): boolean {
	return incoming.headers.upgrade?.toLowerCase() === "websocket"
}

/** The honey app's settings, its ws adapter filled with `nodeWebSocket()` when none is set. */
function settingsOf(app: unknown): AppSettings | null {
	const settings = (app as { [GRAPH]?: HoneyGraph })[GRAPH]?.settings ?? null
	if (settings === null) return null
	settings.wsAdapter ??= nodeWebSocket()
	if (settings.wsAdapter.runtime !== "node") {
		throw new Error("serve() on Node needs a nodeWebSocket() adapter, but app.wsAdapter() was given another")
	}
	return settings
}

/** Answer on a socket Node handed over through `'upgrade'`, with a real ServerResponse; the connection ends with it. */
function responseOnSocket(incoming: IncomingMessage, socket: Socket): ServerResponse {
	const res = new ServerResponse(incoming)
	res.shouldKeepAlive = false
	res.assignSocket(socket)
	res.once("finish", () => {
		res.detachSocket(socket)
		socket.end()
	})
	return res
}

function shutdown(server: Server, drain: Drain, timeout: number | undefined): Promise<void> {
	drain.draining = true
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined
		server.close(() => {
			clearTimeout(timer)
			resolve()
		})
		server.closeIdleConnections()
		for (const [res, request] of drain.inflight) if (res.headersSent) abort(request, shuttingDown())
		drain.settings?.wsAdapter?.closeAll?.(1001, "server shutting down")
		if (timeout !== undefined) {
			timer = setTimeout(() => {
				for (const request of drain.inflight.values()) abort(request, shuttingDown())
				for (const socket of drain.upgraded) socket.destroy()
				server.closeAllConnections()
			}, timeout)
		}
	})
}

/** Hand `error` to the operator's onError; one that throws itself must not become an unhandled rejection. */
function report(s: { readonly onError: (error: unknown) => void }, error: unknown): void {
	try {
		s.onError(error)
	} catch {
		/* the 500 still goes out; nothing else is left to tell */
	}
}

type Serving<TEnv> = {
	readonly app: FetchApp<TEnv>
	readonly drain: Drain
	readonly env: TEnv
	readonly maxBody: number
	readonly onError: (error: unknown) => void
	readonly server: Server
}

async function handleRequest<TEnv>(s: Serving<TEnv>, incoming: IncomingMessage, res: ServerResponse): Promise<void> {
	const { drain } = s
	if (drain.draining) return answerPlain(res, 503, "Service Unavailable", true)
	const url = nodeRequestUrl(incoming)
	if (url === null) return answerPlain(res, 400, "Bad Request", true)
	const request = nodeRequest(incoming, url, s.maxBody)
	drain.inflight.set(res, request)
	/* closed before it finished: the client left, or shutdown cut it */
	res.once("close", () => {
		if (!res.writableFinished) abort(request)
	})
	try {
		/* a synchronous answer skips the extra microtask an await would cost */
		const answer = s.app.fetch(request, s.env)
		const response = answer instanceof Promise ? await answer : answer
		/* a body over the cap was left on the socket; while draining, the connection ends here */
		if (drain.draining || (request as unknown as Record<symbol, boolean>)[BODY_OVERFLOW]) res.shouldKeepAlive = false
		await writeResponse(response, res, incoming.method === "HEAD")
	} catch (error) {
		report(s, error)
		/* every failure before this point comes before writeHead; a failing body pipe cuts the connection itself */
		answerPlain(res, 500, "Internal Server Error", false)
	} finally {
		drain.inflight.delete(res)
		/* a keep-alive connection that just went idle would hold close() open until it times out */
		if (drain.draining) setImmediate(() => s.server.closeIdleConnections())
	}
}

/** Node without shouldUpgradeCallback sends every Upgrade to 'upgrade': a bodiless one is an ordinary request. */
function upgradeAsRequest<TEnv>(s: Serving<TEnv>, incoming: IncomingMessage, socket: Socket): Promise<void> | void {
	/* its body bytes would already be on the raw socket: only a bodiless one can be served */
	if (incoming.headers["transfer-encoding"] !== undefined || Number(incoming.headers["content-length"] ?? 0) > 0) {
		return answerPlain(responseOnSocket(incoming, socket), 400, "Bad Request", true)
	}
	socket.setTimeout(0)
	return handleRequest(s, incoming, responseOnSocket(incoming, socket))
}

/** A WebSocket handshake: the app's ws route upgrades it through the adapter, or answers it on the socket. */
async function handleUpgrade<TEnv>(
	s: Serving<TEnv>,
	incoming: IncomingMessage,
	socket: Socket,
	head: Buffer,
): Promise<void> {
	if (!isWebSocketUpgrade(incoming)) return upgradeAsRequest(s, incoming, socket)
	const url = s.drain.draining ? null : nodeRequestUrl(incoming)
	if (url === null) {
		const [status, text] = s.drain.draining ? ([503, "Service Unavailable"] as const) : ([400, "Bad Request"] as const)
		return answerPlain(responseOnSocket(incoming, socket), status, text, true)
	}
	const request = nodeRequest(incoming, url, s.maxBody)
	const upgrade: NodeUpgrade = { head, req: incoming, socket, upgraded: false }
	Object.defineProperty(request, NODE_UPGRADE, { value: upgrade })
	socket.once("close", () => abort(request))
	try {
		const answer = await s.app.fetch(request, s.env)
		socket.setTimeout(0)
		/* the socket is a WebSocket now: an HTTP answer on it would corrupt the stream */
		if (upgrade.upgraded) return trackUpgraded(s.drain, socket)
		if (!socket.destroyed) await writeResponse(answer, responseOnSocket(incoming, socket), false)
	} catch (error) {
		report(s, error)
		/* a socket ws already took stays the WebSocket's; shutdown still has to be able to cut it */
		if (upgrade.upgraded) trackUpgraded(s.drain, socket)
		else if (!socket.destroyed) answerPlain(responseOnSocket(incoming, socket), 500, "Internal Server Error", false)
	}
}

function trackUpgraded(drain: Drain, socket: Socket): void {
	drain.upgraded.add(socket)
	socket.once("close", () => drain.upgraded.delete(socket))
}

/** Serve `app` with `node:http`. The server starts listening at once; `'listening'` tells when it is bound. */
export function serve<TEnv>(app: FetchApp<TEnv>, options: NodeServeOptions<TEnv>): HoneyServer {
	const drain: Drain = { draining: false, inflight: new Map(), settings: settingsOf(app), upgraded: new Set() }
	const server = createServer(
		/* only a WebSocket handshake takes the 'upgrade' path where Node can tell (shouldUpgradeCallback) */
		{ shouldUpgradeCallback: isWebSocketUpgrade } as Parameters<typeof createServer>[0],
	) as HoneyServer
	const serving: Serving<TEnv> = {
		app,
		drain,
		env: options.env,
		maxBody: options.maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY,
		onError: options.onError ?? reportAsWarning,
		server,
	}
	server.on("request", (incoming: IncomingMessage, res: ServerResponse) => {
		void handleRequest(serving, incoming, res)
	})
	const upgradeTimeout = options.upgradeTimeout ?? DEFAULT_UPGRADE_TIMEOUT
	server.on("upgrade", (incoming: IncomingMessage, socket: Socket, head: Buffer) => {
		/* a reset while the app is still deciding must not become an uncaught 'error' */
		socket.on("error", () => socket.destroy())
		if (upgradeTimeout > 0) socket.setTimeout(upgradeTimeout, () => socket.destroy())
		void handleUpgrade(serving, incoming, socket, head)
	})
	if (options.headersTimeout !== undefined) server.headersTimeout = options.headersTimeout
	if (options.requestTimeout !== undefined) server.requestTimeout = options.requestTimeout
	if (options.keepAliveTimeout !== undefined) server.keepAliveTimeout = options.keepAliveTimeout
	server.shutdown = (timeout) => shutdown(server, drain, timeout)
	server.listen(options.port ?? 0, options.hostname)
	return server
}
