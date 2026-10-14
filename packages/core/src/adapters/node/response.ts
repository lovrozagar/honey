/**
 * Fetch → `node:http`: a Response written to a ServerResponse. Headers that described another
 * connection are dropped, a stream's declared length is never trusted, a HoneyResponse goes out
 * from its bytes and header map with no Fetch Response built.
 */
import type { ServerResponse } from "node:http"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream as NodeReadableStream } from "node:stream/web"
import { isHoneyResponse, type RawBody, rawBodyOf } from "../../response/builder.ts"
import type { HeaderMap } from "../../response/out-headers.ts"

/** A known-size native body up to this many bytes is buffered and sent in one write. */
const BUFFER_BODY_MAX = 256 * 1024

/** Hop-by-hop headers (RFC 9110 §7.6.1) describe one connection: Node writes its own. */
const HOP_BY_HOP = /^(?:connection|keep-alive|proxy-connection|te|trailer|transfer-encoding|upgrade)$/

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

/** Write `response` to `res`: headers for this connection, the body buffered or piped. */
export async function writeResponse(response: Response, res: ServerResponse): Promise<void> {
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
