/**
 * The Node adapter's server: it hands each request to the app through the request view, writes
 * the answer (`response.ts`), answers what it refuses itself, and drains on shutdown.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
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

type Drain = { draining: boolean; readonly inflight: Map<ServerResponse, Request> }

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
		if (timeout !== undefined) {
			timer = setTimeout(() => {
				for (const request of drain.inflight.values()) abort(request, shuttingDown())
				server.closeAllConnections()
			}, timeout)
		}
	})
}

/** Serve `app` with `node:http`. The server starts listening at once; `'listening'` tells when it is bound. */
export function serve<TEnv>(app: FetchApp<TEnv>, options: NodeServeOptions<TEnv>): HoneyServer {
	const maxBody = options.maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY
	const onError = options.onError ?? reportAsWarning
	const drain: Drain = { draining: false, inflight: new Map() }

	const handle = async (incoming: IncomingMessage, res: ServerResponse): Promise<void> => {
		if (drain.draining) return answerPlain(res, 503, "Service Unavailable", true)
		const url = nodeRequestUrl(incoming)
		if (url === null) return answerPlain(res, 400, "Bad Request", true)
		const request = nodeRequest(incoming, url, maxBody)
		drain.inflight.set(res, request)
		/* closed before it finished: the client left, or shutdown cut it */
		res.once("close", () => {
			if (!res.writableFinished) abort(request)
		})
		try {
			/* a synchronous answer skips the extra microtask an await would cost */
			const answer = app.fetch(request, options.env)
			const response = answer instanceof Promise ? await answer : answer
			/* a body over the cap was left on the socket; while draining, the connection ends here */
			if (drain.draining || (request as unknown as Record<symbol, boolean>)[BODY_OVERFLOW]) res.shouldKeepAlive = false
			await writeResponse(response, res)
		} catch (error) {
			onError(error)
			/* every failure before this point comes before writeHead; a failing body pipe cuts the connection itself */
			answerPlain(res, 500, "Internal Server Error", false)
		} finally {
			drain.inflight.delete(res)
			/* a keep-alive connection that just went idle would hold close() open until it times out */
			if (drain.draining) setImmediate(() => server.closeIdleConnections())
		}
	}

	const server = createServer((incoming, res) => {
		void handle(incoming, res)
	}) as HoneyServer
	if (options.headersTimeout !== undefined) server.headersTimeout = options.headersTimeout
	if (options.requestTimeout !== undefined) server.requestTimeout = options.requestTimeout
	if (options.keepAliveTimeout !== undefined) server.keepAliveTimeout = options.keepAliveTimeout
	server.shutdown = (timeout) => shutdown(server, drain, timeout)
	server.listen(options.port ?? 0, options.hostname)
	return server
}
