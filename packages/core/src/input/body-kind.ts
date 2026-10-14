/**
 * What body an answer carries, decided without reading it, and the answer to a HEAD request.
 * Honey tags its answers at creation: a buffered one by its raw body, a produced stream (sse,
 * stream, generate) by its tag. Neither ever reads `.body` off a buffered HoneyResponse, which on
 * Node would build a stream for it.
 */
import { isHoneyResponse, isProducedStream, rawBodyOf, replaceResponse } from "../response/builder.ts"

/**
 * `buffered`: the whole body is in memory, or its length is declared, so reading it is bounded.
 * `stream`: anything else that has a body; a middleware must never buffer it. `empty`: no body.
 */
export type BodyKind = "buffered" | "empty" | "stream"

/** `response`'s body kind; its content type is never consulted (SSE and NDJSON carry one). */
export function bodyKind(response: Response): BodyKind {
	if (rawBodyOf(response) !== null) return "buffered"
	if (isProducedStream(response)) return "stream"
	/* a HoneyResponse without a raw body hands out its stream, or null, without building one */
	if (response.body === null) return "empty"
	if (isHoneyResponse(response)) return "stream"
	const length = response.headers.get("content-length")
	return length !== null && /^\d+$/.test(length.trim()) ? "buffered" : "stream"
}

// per-process-constant: text-codec
const encoder = /* @__PURE__ */ new TextEncoder()

function noop(): void {}

/**
 * The answer to a HEAD request: GET's status and headers, no body. A body honey built keeps its
 * length in `content-length`, so HEAD states what GET would send; any other body is cancelled
 * unread, so a producer never starts (or stops if it already did).
 */
export function headResponse(response: Response): Response {
	const raw = rawBodyOf(response)
	const headers = new Headers(response.headers as HeadersInit)
	if (raw === null) {
		const body = response.body
		/* a HEAD's body is never sent: a cancel failing changes nothing the client sees */
		if (body !== null && !body.locked) body.cancel().catch(noop)
	} else if (!headers.has("content-length")) {
		headers.set("content-length", String(typeof raw === "string" ? encoder.encode(raw).byteLength : raw.byteLength))
	}
	return replaceResponse(response, { body: null, headers })
}
