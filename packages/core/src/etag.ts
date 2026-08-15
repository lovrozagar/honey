import { replaceResponse } from "./honey-response.ts"
import type { MiddlewareFn } from "./middleware.ts"

type ETagOptions = {
	weak?: boolean
}

/**
 * FNV-1a 32-bit hash — fast, non-cryptographic, deterministic.
 * Good enough for ETag fingerprinting (not security-critical).
 */
function fnv1a(data: Uint8Array): string {
	let hash = 0x811c9dc5
	for (let i = 0; i < data.length; i++) {
		hash ^= data[i]
		hash = Math.imul(hash, 0x01000193)
	}
	return (hash >>> 0).toString(16).padStart(8, "0")
}

export function etag(options?: ETagOptions): MiddlewareFn<{ req: Request }, {}> {
	const weak = options?.weak !== false

	const mw: MiddlewareFn<{ req: Request }, {}> = async (ctx, next) => {
		const method = ctx.req.method
		if (method !== "GET" && method !== "HEAD") {
			return next()
		}

		const response = await next()

		/* skip error responses — caching errors is wasteful and misleading */
		if (response.status >= 400) return response

		/* skip streaming responses — can't hash without buffering entire stream */
		if (
			response.headers.get("transfer-encoding") === "chunked" ||
			(response.body !== null &&
				!response.headers.has("content-length") &&
				!response.headers.has("content-type"))
		) {
			return response
		}

		/* read body to compute hash */
		const body = await response.arrayBuffer()
		if (body.byteLength === 0) return response

		const hash = fnv1a(new Uint8Array(body))
		const etagValue = weak ? `W/"${hash}"` : `"${hash}"`

		const headers = new Headers(response.headers)
		headers.set("etag", etagValue)

		/* check If-None-Match — supports comma-separated list and wildcard per RFC 7232 */
		const ifNoneMatch = ctx.req.headers.get("if-none-match")
		if (ifNoneMatch === "*" || ifNoneMatch?.split(",").some((v) => v.trim() === etagValue)) {
			return replaceResponse(response, {
				body: null,
				headers,
				status: 304,
			})
		}

		/* return response with ETag header and reconstituted body */
		return replaceResponse(response, {
			body,
			headers,
			status: response.status,
		})
	}

	return mw
}
