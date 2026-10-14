/**
 * The Fetch → `node:http` side of the Node adapter: a server that hands each request to the app
 * through the request view, writes the answer, and drains on shutdown.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream as NodeReadableStream } from "node:stream/web"
import { isHoneyResponse, type RawBody, rawBodyOf } from "../../response/builder.ts"
import type { HeaderMap } from "../../response/out-headers.ts"
import { DEFAULT_MAX_REQUEST_BODY } from "../serve.ts"
import { ABORT_REQUEST, BODY_OVERFLOW, nodeRequest, nodeRequestUrl } from "./request.ts"

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

/** A known-size native body up to this many bytes is buffered and sent in one write. */
const BUFFER_BODY_MAX = 256 * 1024

/** Hop-by-hop headers (RFC 9110 §7.6.1) describe one connection: Node writes its own. */
const HOP_BY_HOP = /^(?:connection|keep-alive|proxy-connection|te|trailer|transfer-encoding|upgrade)$/

function abort(request: Request, reason?: unknown): void {
	;(request as unknown as Record<typeof ABORT_REQUEST, (reason?: unknown) => void>)[ABORT_REQUEST](reason)
}

function shuttingDown(): DOMException {
	return new DOMException("The server is shutting down", "AbortError")
}

function reportAsWarning(error: unknown): void {
	process.emitWarning(error instanceof Error ? error : String(error), "HoneyAdapterError")
}

/** The header names a `Connection` header lists: hop-by-hop too. */
function connectionNamed(value: string | string[] | null | undefined): string[] {
	return String(value ?? "")
		.toLowerCase()
		.split(",")
		.map((token) => token.trim())
}

/** A Honey header map, without the hop-by-hop ones a handler set; the same object when it has none. */
function honeyHeaders(headers: HeaderMap): HeaderMap {
	if (!Object.keys(headers).some((name) => HOP_BY_HOP.test(name))) return headers
	const named = connectionNamed(headers.connection)
	return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP.test(name) && !named.includes(name)))
}

/** A native response's headers as Node takes them: every Set-Cookie kept, hop-by-hop and Connection-named dropped. */
function nativeHeaders(response: Response): HeaderMap {
	const named = connectionNamed(response.headers.get("connection"))
	const headers: HeaderMap = {}
	response.headers.forEach((value, name) => {
		if (!HOP_BY_HOP.test(name) && !named.includes(name)) headers[name] = value
	})
	const cookies = response.headers.getSetCookie()
	if (cookies.length > 0) headers["set-cookie"] = cookies
	return headers
}

function headersOf(response: Response): HeaderMap {
	return isHoneyResponse(response) ? honeyHeaders(response.plainHeaders) : nativeHeaders(response)
}

function writeHead(res: ServerResponse, response: Response, headers: HeaderMap): void {
	res.writeHead(response.status, response.statusText === "" ? undefined : response.statusText, headers)
}

function writeBuffered(res: ServerResponse, response: Response, body: RawBody): void {
	const length = typeof body === "string" ? Buffer.byteLength(body) : body.byteLength
	writeHead(res, response, { ...headersOf(response), "content-length": String(length) })
	res.end(body)
}

/** A native body whose declared length is small enough to buffer: one write instead of a pipe. */
function isSmallDeclared(response: Response): boolean {
	const declared = response.headers.get("content-length")
	return declared !== null && /^\d+$/.test(declared) && Number(declared) <= BUFFER_BODY_MAX
}

/** Pipe a body to the socket; when the response closes first, the producer is cancelled. */
async function pipeBody(stream: ReadableStream<Uint8Array>, res: ServerResponse): Promise<void> {
	/* Node's web stream and the DOM ReadableStream brands do not overlap */
	const readable = Readable.fromWeb(stream as unknown as NodeReadableStream<Uint8Array>)
	try {
		await pipeline(readable, res)
	} catch {
		/* the client left, or the stream failed after the headers went out: cut the connection */
		res.destroy()
		await stream.cancel().catch(() => {})
	}
}

async function writeResponse(response: Response, res: ServerResponse): Promise<void> {
	const raw = rawBodyOf(response)
	if (raw !== null) return writeBuffered(res, response, raw)
	const body = response.body
	if (body === null) {
		writeHead(res, response, headersOf(response))
		res.end()
		return
	}
	if (isHoneyResponse(response)) {
		writeHead(res, response, headersOf(response))
		return pipeBody(body, res)
	}
	if (isSmallDeclared(response)) return writeBuffered(res, response, new Uint8Array(await response.arrayBuffer()))
	/* a stream's declared length is never trusted (`fetch()` keeps the encoded length of a body it
	 * decoded): Node chunks it, so a wrong length cannot truncate it or desynchronize keep-alive */
	const { "content-length": _declared, ...headers } = nativeHeaders(response)
	writeHead(res, response, headers)
	return pipeBody(body, res)
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
			const response = await app.fetch(request, options.env)
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
