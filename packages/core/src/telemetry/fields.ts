/**
 * The privacy-safe field catalog (H17): what a log line or a span may say about a request. Paths
 * go without their query or fragment; cookies, credentials and bodies never appear at all.
 */

/** One request-log line's fields (the catalog below), as `requestLog({ skip })` sees them. */
export type RequestLogEntry = {
	/** body bytes sent, when the body was counted */
	readonly bytes?: number
	readonly durationMs: number
	/** what the body is: json, text, binary, stream, sse, generate or empty */
	readonly kind: string
	readonly method: string
	/** without its query */
	readonly path: string
	readonly requestId?: string
	/** the route that served it; empty for a request no route served */
	readonly routeId: string
	readonly runtime: string
	/** the status sent, or "aborted" when the client left before the body ended */
	readonly status: number | "aborted"
}

/** Every field a request-log line carries; nothing outside it is ever written. */
export const REQUEST_LOG_FIELDS: readonly string[] = /* @__PURE__ */ Object.freeze([
	"bytes",
	"durationMs",
	"kind",
	"method",
	"path",
	"requestId",
	"routeId",
	"runtime",
	"status",
])

const SENSITIVE: Readonly<Record<string, true>> = /* @__PURE__ */ Object.freeze({
	authorization: true,
	cookie: true,
	"proxy-authorization": true,
	"set-cookie": true,
	"x-api-key": true,
	"x-auth-token": true,
})

/** A header whose value is a credential or a cookie: never logged, never a span attribute. */
export function isSensitiveHeader(name: string): boolean {
	return Object.hasOwn(SENSITIVE, name.toLowerCase())
}

/** The path of `target` (a URL or a path) without its query or fragment; `/` when empty. */
export function pathOf(target: string): string {
	let start = 0
	const scheme = target.indexOf("://")
	if (scheme !== -1) {
		const slash = target.indexOf("/", scheme + 3)
		const end = target.search(/[?#]/)
		if (slash === -1 || (end !== -1 && end < slash)) return "/"
		start = slash
	}
	const cut = target.slice(start).search(/[?#]/)
	const path = cut === -1 ? target.slice(start) : target.slice(start, start + cut)
	return path === "" ? "/" : path
}

/** What a per-request logger binds: method, the path without its query, the route id, the request id when set. */
export function requestBindings(
	method: string,
	path: string,
	routeId: string,
	requestId: string | undefined,
): Record<string, string> {
	const bindings: Record<string, string> = { method, path: pathOf(path), routeId }
	if (requestId !== undefined) bindings.requestId = requestId
	return bindings
}
