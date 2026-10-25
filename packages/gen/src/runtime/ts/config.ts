export type HeadersContext = {
	method: string
	path: string
}

type HeadersRecord = Record<string, string | undefined>

export type HeadersInit = ((ctx: HeadersContext) => HeadersRecord | Promise<HeadersRecord>) | HeadersRecord

/** What the SDK knows of a read's staleness, handed to the request and response hooks. */
export type RequestMeta = {
	invalidatedBy: string[]
	isStale: boolean
	selector: string
	seqSnapshot: number
}

export type OnRequestContext = {
	body?: BodyInit
	headers: Headers
	invalidatedBy?: string[]
	isStale?: boolean
	method: string
	path: string
	selector?: string
	state: Record<string, unknown>
	url: string
}

export type OnResponseContext = {
	invalidatedBy?: string[]
	isRetry: boolean
	isStale?: boolean
	method: string
	path: string
	readonly request: Request
	response: Response
	/**
	 * Send the request once more and resolve with the new response, whatever its status. On a
	 * request that is itself a retry, it resolves with the current response (one retry max).
	 */
	retry: () => Promise<Response>
	selector?: string
	state: Record<string, unknown>
	url: string
}

/**
 * - `same-origin` (default): follow redirects that stay on the base URL's origin; a cross-origin
 *   redirect is returned unfollowed (a non-2xx result). In browsers, which hide redirect targets
 *   from script, the platform follows and applies CORS to the target.
 * - `follow`: also follow cross-origin redirects. Such a hop carries only `Accept`,
 *   `Accept-Language` and `User-Agent` (no credentials, auth header, configured, per-call or
 *   `onRequest` header) and never replays a body.
 * - `manual` / `error`: passed to `fetch`.
 */
export type RedirectPolicy = "error" | "follow" | "manual" | "same-origin"

/** One `onLog` entry: what happened to which operation (`METHOD /path`), and how long it took. */
export type LogEntry = {
	duration_ms: number
	error?: unknown
	event: "error" | "hook_executed" | "request_start" | "response_received"
	level: "debug" | "error" | "info" | "warn"
	operation: string
	status?: number
}

export type AuthExpiredContext = {
	/** The token the 401 rejected (read from the auth header), so concurrent 401s can share one refresh. */
	rejectedToken: string | null
}

export type ClientConfig = {
	/** Header that carries the token from `onAuthExpired`. Default `Authorization`. */
	authHeaderName?: string
	/** Prefix for that header. Default `"Bearer "`. */
	authHeaderPrefix?: string
	/** Absolute `http(s):` / `ws(s):` URL, or a same-origin path such as `"/api"`. */
	baseURL: string
	buildSearchParams?: (query: Record<string, unknown>) => URLSearchParams
	credentials?: RequestCredentials
	/** Defaults to the environment `fetch`, bound so it is safe to call in browsers. */
	fetch?: typeof fetch
	headers?: HeadersInit
	/** The most characters of a server's error message a ClientError carries. Default 512. */
	maxErrorMessageChars?: number
	/**
	 * The most bytes a response body may hold, decoded, before its read is refused with a ClientError and the body
	 * cancelled: it is read in the chunks it arrives in, never whole. Default 100 MiB. Streams are bounded by their
	 * own per-event caps instead.
	 */
	maxResponseBytes?: number
	mode?: RequestMode
	/**
	 * Called on a 401. Return a fresh token to retry the request once with it (and use it for later
	 * requests); return null or "" to give up. Concurrent 401s share one call. Requests whose body
	 * is a stream are not retried.
	 */
	onAuthExpired?: (ctx: AuthExpiredContext) => Promise<string | null | undefined> | string | null | undefined
	/** Called at each exchange's start, its answer and its failure (v0's entry shape). */
	onLog?: (entry: LogEntry) => void
	onReconnected?: () => void
	onReconnecting?: (attempt: number, transport: string) => void
	onRequest?: Array<(ctx: OnRequestContext) => Promise<void> | void>
	onResponse?: Array<(ctx: OnResponseContext) => Promise<Response | undefined> | Response | undefined>
	/** Redirect handling; see `RedirectPolicy`. Default `"same-origin"`. */
	redirect?: RedirectPolicy
	/** Send an `x-request-id` header on every request. Default `true`; `false` avoids a CORS preflight. */
	requestId?: boolean
	sortSearchParams?: boolean
	/** The most characters one event, or an unterminated line, may hold before the stream errors. Default 1 MiB. */
	sseMaxBufferChars?: number
	state?: Record<string, unknown>
	throwOnError?: boolean
	/** Milliseconds for a whole request, including reading the body. Streams are exempt. */
	timeout?: number
}
