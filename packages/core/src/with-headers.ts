import { isHoneyResponse } from "./honey-response.ts"

/**
 * Apply header edits to a response a middleware got back from `next()`.
 *
 * - `101 Switching Protocols` passes through untouched. Upgrade responses are
 *   adapter sentinels (Node and Bun fake the status, Workers carry `webSocket`),
 *   and rebuilding one throws or drops the socket.
 * - Honey's own responses and `new Response()` objects are edited in place.
 * - Responses with immutable headers (`fetch()`, `Response.redirect()`,
 *   `cache.match()`) are copied first: same body stream, status, status text
 *   and headers, then edited.
 *
 * `edit` must not read the body.
 */
export function withHeaders(response: Response, edit: (headers: Headers) => void): Response {
	if (response.status === 101) return response
	if (isHoneyResponse(response)) {
		edit(response.headers as unknown as Headers)
		return response
	}
	if (!headersAreImmutable(response)) {
		edit(response.headers)
		return response
	}
	const copy = new Response(response.body, {
		headers: new Headers(response.headers),
		status: response.status,
		statusText: response.statusText,
	})
	edit(copy.headers)
	return copy
}

/** Probe with a header name no one sends: immutable Headers throw on any write. */
const PROBE = "x-honey-mutability-probe"

function headersAreImmutable(response: Response): boolean {
	try {
		response.headers.delete(PROBE)
		return false
	} catch {
		return true
	}
}
