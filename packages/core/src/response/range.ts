/**
 * Range requests (A3, RFC 9110 §14): `rangeResponse` answers one satisfiable byte range with 206,
 * a range past the end with 416, and everything else with the whole body. A plain helper:
 * `staticFiles` and routes call it with the request.
 */
import { withRawBody } from "./builder.ts"

/** A body that can hand out any byte span without reading the rest. */
export type RangeSource = {
	readonly size: number
	slice(start: number, endInclusive: number): Blob | ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer>
}

/** Bytes backed by a plain ArrayBuffer: a shared one cannot be a response body. */
export type RangeBody = Blob | RangeSource | Uint8Array<ArrayBuffer>

export type RangeInit = {
	/** Default: a Blob's own type, else `application/octet-stream`. */
	contentType?: string
	headers?: Record<string, string>
}

type Span = { readonly end: number; readonly start: number }

/** One range spec: two digit runs around a dash, each at most 15 digits (beyond that it names no real offset). */
const SPEC = /^(\d{0,15})-(\d{0,15})$/
const UNIT = /^bytes=/i

function sizeOf(body: RangeBody): number {
	return body instanceof Uint8Array ? body.byteLength : body.size
}

/**
 * The span one `Range` header asks for: a Span, `"unsatisfiable"` when it lies past the end, or
 * `null` when the header is not one byte range (malformed, another unit, several ranges) and is
 * ignored (RFC 9110 §14.2). Linear in the header's length.
 */
function spanOf(header: string, size: number): Span | "unsatisfiable" | null {
	if (!UNIT.test(header) || header.includes(",")) return null
	const match = SPEC.exec(header.slice(6))
	if (match === null) return null
	const [, first = "", last = ""] = match
	if (first === "" && last === "") return null
	if (first === "") {
		const suffix = Number(last)
		return suffix === 0 || size === 0 ? "unsatisfiable" : { end: size - 1, start: Math.max(0, size - suffix) }
	}
	const start = Number(first)
	if (last !== "" && Number(last) < start) return null
	if (start >= size) return "unsatisfiable"
	return { end: last === "" ? size - 1 : Math.min(Number(last), size - 1), start }
}

function slice(body: RangeBody, span: Span): BodyInit {
	if (body instanceof Uint8Array) return body.subarray(span.start, span.end + 1)
	if (body instanceof Blob) return body.slice(span.start, span.end + 1)
	return body.slice(span.start, span.end)
}

function headersFor(body: RangeBody, init: RangeInit | undefined): Headers {
	const headers = new Headers(init?.headers)
	const own = body instanceof Blob && body.type !== "" ? body.type : "application/octet-stream"
	headers.set("content-type", init?.contentType ?? own)
	headers.set("accept-ranges", "bytes")
	return headers
}

/** The whole body, 200; a HEAD gets the head alone, with the length GET would send. */
function whole(request: Request, body: RangeBody, headers: Headers): Response {
	const size = sizeOf(body)
	headers.set("content-length", String(size))
	if (request.method === "HEAD" || size === 0) return new Response(null, { headers, status: 200 })
	if (body instanceof Uint8Array) return withRawBody(new Response(body, { headers, status: 200 }), body)
	return new Response(slice(body, { end: size - 1, start: 0 }), { headers, status: 200 })
}

/**
 * Answer `request` from `body` honoring its `Range` header. Only GET carries a range (RFC 9110
 * §14.2); one satisfiable range is 206 with `Content-Range`, one past the end is 416, and several
 * ranges, a malformed header or an `If-Range` (until validators exist, A4) get the whole body.
 * Every answer says `Accept-Ranges: bytes`.
 */
export function rangeResponse(request: Request, body: RangeBody, init?: RangeInit): Response {
	const headers = headersFor(body, init)
	const header = request.headers.get("range")
	if (request.method !== "GET" || header === null || request.headers.has("if-range"))
		return whole(request, body, headers)
	const size = sizeOf(body)
	const span = spanOf(header, size)
	if (span === null) return whole(request, body, headers)
	if (span === "unsatisfiable") {
		headers.set("content-range", `bytes */${size}`)
		return new Response(null, { headers, status: 416 })
	}
	headers.set("content-range", `bytes ${span.start}-${span.end}/${size}`)
	headers.set("content-length", String(span.end - span.start + 1))
	return new Response(slice(body, span), { headers, status: 206 })
}
