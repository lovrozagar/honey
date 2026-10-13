import { bodyKind, rawBodyOf } from "./body-kind.ts"
import { replaceResponse } from "./honey-response.ts"
import { namedMiddleware } from "./middleware.ts"
import type { MiddlewareFn } from "./middleware.ts"

type ETagOptions = {
	weak?: boolean
}

const encoder = new TextEncoder()

/** Base64url of the first 16 bytes of SHA-256: collision-resistant enough for a strong validator. */
async function digest(data: Uint8Array<ArrayBuffer>): Promise<string> {
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data)).subarray(0, 16)
	let binary = ""
	for (let i = 0; i < hash.length; i++) binary += String.fromCharCode(hash[i])
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const ENTITY_TAG_RE = /(?:W\/)?"[^"]*"/g

/** Weak comparison (RFC 9110 §8.8.3.2): opaque tags match regardless of the `W/` prefix. */
function opaque(tag: string): string {
	return tag.startsWith("W/") ? tag.slice(2) : tag
}

/** RFC 9110 §13.1.2: `*` or a list of entity tags, compared weakly. */
export function ifNoneMatchHits(header: string | null, etag: string): boolean {
	if (header === null) return false
	if (header.trim() === "*") return true
	const target = opaque(etag.trim())
	for (const tag of header.match(ENTITY_TAG_RE) ?? []) {
		if (opaque(tag) === target) return true
	}
	return false
}

export function etag(options?: ETagOptions): MiddlewareFn<{ req: Request }, {}> {
	const weak = options?.weak !== false

	const mw: MiddlewareFn<{ req: Request }, {}> = async (ctx, next) => {
		const method = ctx.req.method
		if (method !== "GET" && method !== "HEAD") {
			return next()
		}

		const response = await next()

		/* Only a 200 has a selected representation a 304 can stand in for. */
		if (response.status !== 200) return response

		const ifNoneMatch = ctx.req.headers.get("if-none-match")

		/* A handler-set ETag is authoritative: never overwrite it or hash the body. */
		const existing = response.headers.get("etag")
		if (existing !== null) {
			if (!ifNoneMatchHits(ifNoneMatch, existing)) return response
			await response.body?.cancel().catch(() => {})
			return replaceResponse(response, { body: null, headers: response.headers, status: 304 })
		}

		/* Never buffer a stream: SSE and generate() can be endless. */
		if (bodyKind(response) !== "buffered") return response

		let bytes: Uint8Array<ArrayBuffer>
		const raw = rawBodyOf(response)
		if (raw !== null) {
			bytes = typeof raw === "string" ? encoder.encode(raw) : new Uint8Array(raw)
		} else {
			bytes = new Uint8Array(await response.arrayBuffer())
		}

		/* Nothing to validate; hand back a fresh body (the original may have been read). */
		if (bytes.byteLength === 0) {
			return raw === null ? replaceResponse(response, { body: bytes, headers: response.headers }) : response
		}

		const hash = await digest(bytes)
		const etagValue = weak ? `W/"${hash}"` : `"${hash}"`

		const headers = new Headers(response.headers as HeadersInit)
		headers.set("etag", etagValue)

		if (ifNoneMatchHits(ifNoneMatch, etagValue)) {
			return replaceResponse(response, { body: null, headers, status: 304 })
		}

		/* The original body was read (or is raw): always hand back a fresh one. */
		return replaceResponse(response, {
			body: typeof raw === "string" ? raw : bytes,
			headers,
			status: response.status,
		})
	}

	return namedMiddleware("etag", mw)
}
