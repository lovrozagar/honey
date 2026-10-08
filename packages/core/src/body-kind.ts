import { isHoneyResponse } from "./honey-response.ts"

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
 * Honey's own buffered responses are recognized by their raw-body tag.
 */
export function bodyKind(response: Response): "buffered" | "empty" | "stream" {
	if (rawBodyOf(response) !== null) return "buffered"
	if (isHoneyResponse(response)) {
		/* `body` is the stream (or null) when no raw bytes exist; reading it does not allocate. */
		return response.body === null ? "empty" : "stream"
	}
	if (response.body === null) return "empty"
	const length = response.headers.get("content-length")
	if (length !== null && /^\d+$/.test(length.trim())) return "buffered"
	return "stream"
}
