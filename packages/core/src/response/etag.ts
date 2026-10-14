/**
 * `etag()`: a validator for every GET or HEAD answered 200 with a body honey can hash, and the 304
 * a matching `If-None-Match` earns (RFC 9110 §8.8.3, §13.1.2). A body honey built is hashed from
 * the raw body it kept and handed on unread; a foreign body of declared length is read and
 * rebuilt; a stream is never buffered (it may never end). A validator the handler set is never
 * replaced.
 */
import { bodyKind, discardBody } from "../input/body-kind.ts"
import { type MiddlewareFn, namedMiddleware } from "../middleware/middleware.ts"
import { rawBodyOf, replaceResponse } from "./builder.ts"
import { withHeaders } from "./with-headers.ts"

export type ETagOptions = {
	/** A weak validator (`W/"…"`, the default), or a strong one with `false`. */
	weak?: boolean
}

// per-process-constant: text-codec
const encoder = /* @__PURE__ */ new TextEncoder()

/** Base64url of the first 16 bytes of the SHA-256 of `bytes`: 22 characters, no padding. */
async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes), 0, 16)
	let binary = ""
	for (const byte of hash) binary += String.fromCharCode(byte)
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

/* an entity tag, weak or strong: a quoted string may hold a comma */
const ENTITY_TAG = /(?:W\/)?"[^"]*"/g

/* the weakness indicator: weak comparison (RFC 9110 §8.8.3.2) ignores it */
const WEAK_PREFIX = /^W\//

/** The opaque tag, without its weakness indicator. */
function opaque(tag: string): string {
	return tag.replace(WEAK_PREFIX, "")
}

/** Whether an `If-None-Match` value (`*` or a list of tags) matches `current`, compared weakly. */
export function ifNoneMatchHits(header: string | null, current: string): boolean {
	if (header === null) return false
	if (header.trim() === "*") return true
	const target = opaque(current.trim())
	for (const tag of header.match(ENTITY_TAG) ?? []) {
		if (opaque(tag) === target) return true
	}
	return false
}

/**
 * `response` as a 304: its headers kept (validators, Cache-Control, Vary among them), no body. A
 * body honey did not keep is cancelled unread, so a producer never starts.
 */
export function notModified(response: Response): Response {
	discardBody(response)
	return replaceResponse(response, { body: null, status: 304 })
}

/** The bytes to hash, read from the raw body honey kept or from a foreign body of declared length. */
async function bytesOf(response: Response): Promise<{ bytes: Uint8Array<ArrayBuffer>; read: boolean }> {
	const raw = rawBodyOf(response)
	if (raw === null) return { bytes: new Uint8Array(await response.arrayBuffer()), read: true }
	return { bytes: typeof raw === "string" ? encoder.encode(raw) : (raw as Uint8Array<ArrayBuffer>), read: false }
}

export function etag(options: ETagOptions = {}): MiddlewareFn<{ req: Request }> {
	const weak = options.weak !== false
	return namedMiddleware("etag", async (ctx, next) => {
		const method = ctx.req.method
		if (method !== "GET" && method !== "HEAD") return next()
		const response = await next()
		/* only a 200 has a selected representation a 304 can stand in for */
		if (response.status !== 200) return response
		const ifNoneMatch = ctx.req.headers.get("if-none-match")
		const own = response.headers.get("etag")
		if (own !== null) return ifNoneMatchHits(ifNoneMatch, own) ? notModified(response) : response
		if (bodyKind(response) !== "buffered") return response
		const { bytes, read } = await bytesOf(response)
		/* a foreign body was read to hash it: the answer goes on with a fresh one */
		const whole = read ? replaceResponse(response, { body: bytes }) : response
		if (bytes.byteLength === 0) return whole
		const tag = weak ? `W/"${await digest(bytes)}"` : `"${await digest(bytes)}"`
		const tagged = withHeaders(whole, (headers) => headers.set("etag", tag))
		return ifNoneMatchHits(ifNoneMatch, tag) ? notModified(tagged) : tagged
	})
}
