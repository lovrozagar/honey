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
	"x-csrf-token": true,
	"x-xsrf-token": true,
})

/* a name with a token, secret, API key, password or session as a whole dash-separated part */
const SENSITIVE_PART = /(?:^|-)(?:token|secret|api-?key|password|session)(?:$|-)/i

/**
 * A header whose value is a credential, a cookie or a session: never logged, never a span
 * attribute. One definition for the request log, spans and curlLogger's redaction.
 */
export function isSensitiveHeader(name: string): boolean {
	return Object.hasOwn(SENSITIVE, name.toLowerCase()) || SENSITIVE_PART.test(name)
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

/** The ids a request may carry: its request id, and its trace's ids when it is traced. */
export type RequestIds = {
	readonly requestId?: string | undefined
	readonly trace?: { readonly spanId: string; readonly traceId: string } | null
}

/**
 * What a per-request logger binds: method, the path without its query, the route id, the request
 * id when set, and the trace's ids when the request is traced (so a line joins its trace).
 */
export function requestBindings(
	method: string,
	path: string,
	routeId: string,
	{ requestId, trace }: RequestIds = {},
): Record<string, string> {
	const bindings: Record<string, string> = { method, path: pathOf(path), routeId }
	if (requestId !== undefined) bindings.requestId = requestId
	if (trace != null) {
		bindings.trace_id = trace.traceId
		bindings.span_id = trace.spanId
	}
	return bindings
}
