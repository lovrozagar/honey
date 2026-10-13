import { isHoneyResponse, replaceResponse } from "./honey-response.ts"
import { BODY_KIND } from "./producer-stream.ts"

/** Set by `ctx.res.json/text/html/...` on native responses built from in-memory bytes. */
const RAW_BODY = Symbol.for("honey.rawBody")

/** The in-memory body of a response Honey built from a string or bytes, if any. */
export function rawBodyOf(response: Response): string | Uint8Array | null {
	if (isHoneyResponse(response)) return response.rawBody
	return (response as Response & { [RAW_BODY]?: string | Uint8Array })[RAW_BODY] ?? null
}

/**
 * What kind of body a response carries, decided without reading it.
 *
 * - `empty`: no body.
 * - `buffered`: the whole body is already in memory (a response Honey built
 *   from a string or bytes) or its size is declared by `content-length`, so
 *   reading it is bounded.
 * - `stream`: anything else (SSE, `generate()`, `new Response(stream)`, a
 *   proxied `fetch()` without a length). Middleware must not buffer it.
 *
 * Content type is never consulted: SSE and NDJSON streams carry one.
 * Honey's own responses are tagged when they are created: buffered ones by their raw body,
 * streams by `BODY_KIND`. An untagged native response is a stream unless it declares a length.
 */
export function bodyKind(response: Response): "buffered" | "empty" | "stream" {
	if (rawBodyOf(response) !== null) return "buffered"
	/* `sse()`, `stream()` and `generate()` tag their responses at creation */
	if ((response as Response & { [BODY_KIND]?: string })[BODY_KIND] === "stream") return "stream"
	if (isHoneyResponse(response)) {
		/* `body` is the stream (or null) when no raw bytes exist; reading it does not allocate. */
		return response.body === null ? "empty" : "stream"
	}
	if (response.body === null) return "empty"
	const length = response.headers.get("content-length")
	if (length !== null && /^\d+$/.test(length.trim())) return "buffered"
	return "stream"
}

/** A stream `sse()`, `stream()` or `generate()` created: possibly endless, never to be buffered. */
export function isProducedStream(response: Response): boolean {
	return (response as Response & { [BODY_KIND]?: string })[BODY_KIND] === "stream"
}

function noop(): void {}

/**
 * The response to a HEAD request: same status and headers, no body. A body Honey built in
 * memory keeps its `content-length`, so HEAD reports the size GET would send; a stream is
 * cancelled unread, so its producer never starts (or stops if it already did).
 */
export function headResponse(response: Response): Response {
	if (response.status === 101) return response
	const raw = rawBodyOf(response)
	const headers = new Headers(response.headers as HeadersInit)
	if (raw !== null) {
		if (!headers.has("content-length")) {
			const length = typeof raw === "string" ? new TextEncoder().encode(raw).byteLength : raw.byteLength
			headers.set("content-length", String(length))
		}
	} else {
		const body = response.body
		if (body !== null && !body.locked) body.cancel().catch(noop)
	}
	return replaceResponse(response, { body: null, headers })
}
