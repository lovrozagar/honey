import { bindDefaultFetch, parseClientBaseURL } from "./defaults.ts"
import type { ClientError } from "./error.ts"
import { clientErrorFor } from "./error.ts"
import { interpolatePath } from "./path.ts"
import type { SSEEvent } from "./sse.ts"
import { parseSSEStream } from "./sse.ts"

export { interpolatePath } from "./path.ts"

export type HeadersContext = {
	method: string
	path: string
}

type HeadersRecord = Record<string, string | undefined>

export type HeadersInit = ((ctx: HeadersContext) => HeadersRecord | Promise<HeadersRecord>) | HeadersRecord

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
	 * Send the request once more and resolve with the new response, whatever its status. On
	 * a request that is itself a retry, it resolves with the current response (one retry max).
	 */
	retry: () => Promise<Response>
	selector?: string
	state: Record<string, unknown>
	url: string
}

/**
 * - `same-origin` (default): follow redirects that stay on the base URL's origin; a
 *   cross-origin redirect is returned unfollowed (a non-2xx result). In browsers, which hide
 *   redirect targets from script, the platform follows and applies CORS to the target.
 * - `follow`: also follow cross-origin redirects, without credentials (`Authorization`,
 *   `Cookie`, the auth header, and every configured or per-call header) and without
 *   replaying a body.
 * - `manual` / `error`: passed to `fetch`.
 */
export type RedirectPolicy = "error" | "follow" | "manual" | "same-origin"

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
	mode?: RequestMode
	/**
	 * Called on a 401. Return a fresh token to retry the request once with it (and use it for
	 * later requests); return null or "" to give up. Concurrent 401s share one call. Requests
	 * whose body is a stream are not retried.
	 */
	onAuthExpired?: (ctx: AuthExpiredContext) => Promise<string | null | undefined> | string | null | undefined
	onRequest?: Array<(ctx: OnRequestContext) => Promise<void> | void>
	onResponse?: Array<(ctx: OnResponseContext) => Promise<Response | undefined> | Response | undefined>
	/** Redirect handling; see `RedirectPolicy`. Default `"same-origin"`. */
	redirect?: RedirectPolicy
	/** Send an `x-request-id` header on every request. Default `true`; `false` avoids a CORS preflight. */
	requestId?: boolean
	sortSearchParams?: boolean
	state?: Record<string, unknown>
	throwOnError?: boolean
	/** Milliseconds for a whole request, including reading the body. Streams are exempt. */
	timeout?: number

	/* Realtime hooks — called by the generated runtime module */
	onReconnecting?: (attempt: number, transport: string) => void
	onReconnected?: () => void
}

export type RequestOptions = {
	cookies?: Record<string, string>
	form?: Record<string, unknown>
	headers?: Record<string, string | undefined>
	json?: unknown
	lastEventId?: string
	params?: Record<string, string>
	search?: Record<string, unknown>
	signal?: AbortSignal
	/** Per-call timeout in milliseconds; overrides `config.timeout`, `0` disables it. */
	timeout?: number
}

type Kind = "auto" | "rest" | "stream"

type Sent = {
	/** Release timers and listeners. Call once the body has been read or abandoned. */
	done: () => void
	/** Stop the timeout but keep user cancellation (the response turned out to be a stream). */
	exemptFromTimeout: () => void
	response: Response
}

function coerceParam(v: unknown): string | null {
	if (v === undefined || v === null) return null
	if (v instanceof Date) return v.toISOString()
	if (typeof v === "symbol") return null
	return String(v)
}

function coerceFormValue(key: string, v: unknown): string | null {
	if (v !== null && typeof v === "object" && !(v instanceof Date)) {
		throw new TypeError(
			`Form field ${JSON.stringify(key)}: nested objects cannot be form-encoded; pass a string (e.g. JSON.stringify) or use json`,
		)
	}
	return coerceParam(v)
}

function defaultSearchParams(query: Record<string, unknown>): URLSearchParams {
	const params = new URLSearchParams()
	for (const [k, v] of Object.entries(query)) {
		if (v === undefined || v === null) continue
		if (Array.isArray(v)) {
			for (const item of v) {
				const s = coerceParam(item)
				if (s !== null) params.append(k, s)
			}
		} else {
			const s = coerceParam(v)
			if (s !== null) params.set(k, s)
		}
	}
	return params
}

/**
 * RFC 4122 §4.4 UUID for `x-request-id`. Prefer `crypto.randomUUID` (browser,
 * Node 19+, Bun, Deno, CF Workers). Fall back to `getRandomValues` when
 * `randomUUID` is missing so older runtimes still work without node:crypto.
 */
export function newClientRequestId(): string {
	const c = globalThis.crypto as Crypto | undefined
	if (c && typeof c.randomUUID === "function") return c.randomUUID()
	if (c && typeof c.getRandomValues === "function") {
		const bytes = new Uint8Array(16)
		c.getRandomValues(bytes)
		bytes[6] = (bytes[6]! & 0x0f) | 0x40
		bytes[8] = (bytes[8]! & 0x3f) | 0x80
		let out = ""
		for (let i = 0; i < 16; i++) {
			if (i === 4 || i === 6 || i === 8 || i === 10) out += "-"
			out += bytes[i]!.toString(16).padStart(2, "0")
		}
		return out
	}
	throw new Error("honey: no crypto.randomUUID or crypto.getRandomValues in this runtime")
}

function isFileLike(v: unknown): boolean {
	return (typeof File !== "undefined" && v instanceof File) || (typeof Blob !== "undefined" && v instanceof Blob)
}

function encodeBody(opts: RequestOptions, headers: Headers): BodyInit | undefined {
	if (opts.json !== undefined) {
		headers.set("content-type", "application/json")
		return JSON.stringify(opts.json)
	}
	if (opts.form === undefined) return undefined

	const entries = Object.entries(opts.form)
	const hasFiles = entries.some(
		([, v]) =>
			isFileLike(v) ||
			(typeof FileList !== "undefined" && v instanceof FileList) ||
			(Array.isArray(v) && v.some(isFileLike)),
	)

	/* Both encodings repeat the key for array items, so a field reads the same either way. */
	if (hasFiles) {
		const fd = new FormData()
		for (const [k, v] of entries) {
			if (v === undefined || v === null) continue
			const items =
				typeof FileList !== "undefined" && v instanceof FileList ? Array.from(v) : Array.isArray(v) ? v : [v]
			for (const item of items) {
				if (isFileLike(item)) fd.append(k, item as Blob)
				else {
					const s = coerceFormValue(k, item)
					if (s !== null) fd.append(k, s)
				}
			}
		}
		/* don't set content-type — fetch sets the multipart boundary */
		return fd
	}

	headers.set("content-type", "application/x-www-form-urlencoded")
	const params = new URLSearchParams()
	for (const [k, v] of entries) {
		for (const item of Array.isArray(v) ? v : [v]) {
			const s = coerceFormValue(k, item)
			if (s !== null) params.append(k, s)
		}
	}
	return params.toString()
}

/** A body that can be sent a second time (retry, redirect). Streams are consumed by the first send. */
function isReplayable(body: BodyInit | null | undefined): boolean {
	return !(typeof ReadableStream !== "undefined" && body instanceof ReadableStream)
}

function mediaEssence(response: Response): string {
	return (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
}

function isJsonType(ct: string): boolean {
	return ct === "application/json" || ct.endsWith("+json")
}

function isTextType(ct: string): boolean {
	return ct.startsWith("text/") || ct === "application/xml" || ct.endsWith("+xml")
}

export function isEventStream(response: Response): boolean {
	return mediaEssence(response) === "text/event-stream"
}

/* oxlint-disable-next-line no-control-regex -- intentional strip of ASCII control characters */
const CONTROL_RE = /[\x00-\x1f\x7f]/g

function sanitizeMessage(message: string): string {
	return message.replace(CONTROL_RE, "").slice(0, 512)
}

/** Read an error body: JSON when it parses, else the text, else null. Never throws on the body. */
async function readErrorBody(response: Response): Promise<unknown> {
	let text: string
	try {
		text = await response.text()
	} catch {
		return null
	}
	if (text.length === 0) return null
	try {
		return JSON.parse(text)
	} catch {
		return text
	}
}

async function errorFromResponse(response: Response): Promise<ClientError> {
	const preserved = response.clone()
	const body = await readErrorBody(response)
	const msgVal =
		typeof body === "object" && body !== null && "message" in body
			? (body as Record<string, unknown>).message
			: undefined
	const message = typeof msgVal === "string" && msgVal.length > 0 ? sanitizeMessage(msgVal) : `HTTP ${response.status}`
	return clientErrorFor({ body, message, response: preserved, status: response.status })
}

/**
 * Safe-mode error value: the server's error object when the body is a JSON object, else the
 * `ClientError` itself, so `error` is truthy for every non-2xx and always carries `status`.
 */
function safeErrorValue(error: ClientError): unknown {
	const body = error.body
	return typeof body === "object" && body !== null && !Array.isArray(body) ? body : error
}

function timeoutError(ms: number): Error {
	return typeof DOMException === "function"
		? new DOMException(`Request timed out after ${ms} ms`, "TimeoutError")
		: Object.assign(new Error(`Request timed out after ${ms} ms`), { name: "TimeoutError" })
}

/** Browsers hide redirect targets from script (`opaqueredirect`), so the platform must follow. */
function platformFollowsRedirects(): boolean {
	const g = globalThis as { document?: unknown; WorkerGlobalScope?: unknown }
	return typeof g.document !== "undefined" || typeof g.WorkerGlobalScope !== "undefined"
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 20
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"]

export class HTTPClient {
	private _config: ClientConfig
	private _fetch: typeof fetch
	private _base: URL | undefined
	private _token: string | null = null
	private _refreshing: Promise<string | null> | null = null

	constructor(config: ClientConfig) {
		this._config = config
		this._fetch = bindDefaultFetch(config.fetch)
	}

	/** The base URL, parsed once. */
	private get base(): URL {
		this._base ??= parseClientBaseURL(this._config.baseURL)
		return this._base
	}

	private get authName(): string {
		return this._config.authHeaderName ?? "Authorization"
	}

	private get authPrefix(): string {
		return this._config.authHeaderPrefix ?? "Bearer "
	}

	/** Resolve `path` against the base URL, keeping the base path and query, and assert it stays there. */
	private _url(path: string, opts: RequestOptions): URL {
		const resolvedPath = opts.params ? interpolatePath(path, opts.params) : interpolatePath(path)
		const base = this.base
		const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`
		const relative = resolvedPath.startsWith("/") ? resolvedPath.slice(1) : resolvedPath
		const url = new URL(base.href)
		url.pathname = `${basePath}${relative}`
		url.hash = ""
		/* Params are validated, so this only fires on a malformed template; never send it anywhere else. */
		if (url.origin !== base.origin || !url.pathname.startsWith(basePath.slice(0, -1))) {
			throw new Error(`Request path ${JSON.stringify(path)} resolves outside the base URL`)
		}
		if (opts.search) {
			const serializer = this._config.buildSearchParams ?? defaultSearchParams
			const params = serializer(opts.search)
			if (this._config.sortSearchParams) params.sort()
			for (const [k, v] of params.entries()) url.searchParams.append(k, v)
		}
		return url
	}

	private async _headers(opts: RequestOptions, ctx: HeadersContext): Promise<Headers> {
		const headers = new Headers()
		const config = this._config

		if (config.headers) {
			const resolved = typeof config.headers === "function" ? await config.headers(ctx) : config.headers
			for (const [k, v] of Object.entries(resolved)) {
				if (v !== undefined) headers.set(k, v)
			}
		}

		/* a refreshed token replaces the configured one; per-call headers still win */
		if (this._token !== null) headers.set(this.authName, `${this.authPrefix}${this._token}`)

		if (opts.headers) {
			for (const [k, v] of Object.entries(opts.headers)) {
				if (v !== undefined) headers.set(k, v)
			}
		}

		if (opts.cookies) {
			const existing = headers.get("cookie")
			const pairs = Object.entries(opts.cookies)
				.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
				.join("; ")
			if (pairs) {
				headers.set("cookie", existing ? `${existing}; ${pairs}` : pairs)
			}
		}

		/* auto correlation id — config/per-call win; onRequest may overwrite later */
		if (config.requestId !== false && !headers.has("x-request-id")) {
			headers.set("x-request-id", newClientRequestId())
		}

		return headers
	}

	/** One combined signal for the user's abort and the timeout, alive until `done()`. */
	private _signal(
		opts: RequestOptions,
		kind: Kind,
	): { done: () => void; exemptFromTimeout: () => void; signal: AbortSignal | undefined } {
		const userSignal = opts.signal
		const timeout = kind === "stream" ? undefined : (opts.timeout ?? this._config.timeout)
		if (!timeout || timeout <= 0) {
			return { done: () => {}, exemptFromTimeout: () => {}, signal: userSignal }
		}

		const ctrl = new AbortController()
		const timer = setTimeout(() => ctrl.abort(timeoutError(timeout)), timeout)
		;(timer as unknown as { unref?: () => void }).unref?.()
		const onUserAbort = () => ctrl.abort(userSignal?.reason)
		if (userSignal?.aborted) ctrl.abort(userSignal.reason)
		else userSignal?.addEventListener("abort", onUserAbort, { once: true })
		return {
			done: () => {
				clearTimeout(timer)
				userSignal?.removeEventListener("abort", onUserAbort)
			},
			exemptFromTimeout: () => clearTimeout(timer),
			signal: ctrl.signal,
		}
	}

	/** Share one `onAuthExpired` call between concurrent 401s; reuse a token another request already got. */
	private _refresh(rejectedToken: string | null): Promise<string | null> {
		if (this._token !== null && rejectedToken !== this._token) return Promise.resolve(this._token)
		if (this._refreshing) return this._refreshing
		const hook = this._config.onAuthExpired
		if (!hook) return Promise.resolve(null)
		this._refreshing = Promise.resolve()
			.then(() => hook({ rejectedToken }))
			.then((token) => {
				this._token = typeof token === "string" && token.length > 0 ? token : null
				return this._token
			})
			.finally(() => {
				this._refreshing = null
			})
		return this._refreshing
	}

	private async _fetchWithRedirects(url: URL, init: RequestInit): Promise<Response> {
		const policy = this._config.redirect ?? "same-origin"
		if (policy === "manual" || policy === "error" || platformFollowsRedirects()) {
			return this._fetch(url.toString(), policy === "same-origin" ? init : { ...init, redirect: policy })
		}

		const origin = this.base.origin
		let current = url
		let currentInit: RequestInit = { ...init, redirect: "manual" }
		for (let hop = 0; ; hop++) {
			const response = await this._fetch(current.toString(), currentInit)
			const location = response.headers.get("location")
			if (!REDIRECT_STATUSES.has(response.status) || location === null || hop >= MAX_REDIRECTS) return response

			let target: URL
			try {
				target = new URL(location, current)
			} catch {
				return response
			}
			if (target.protocol !== "http:" && target.protocol !== "https:") return response
			const crossOrigin = target.origin !== origin
			if (crossOrigin && policy !== "follow") return response

			const nextInit: RequestInit = { ...currentInit, headers: new Headers(currentInit.headers) }
			const keepsBody = response.status === 307 || response.status === 308
			if (keepsBody) {
				if (currentInit.body != null && (crossOrigin || !isReplayable(currentInit.body))) return response
			} else {
				/* 303, and 301/302 for POST: the browser behavior is GET without a body */
				const method = (currentInit.method ?? "GET").toUpperCase()
				if (response.status === 303 ? method !== "HEAD" : method === "POST") {
					nextInit.method = "GET"
					nextInit.body = undefined
					;(nextInit.headers as Headers).delete("content-type")
				}
			}
			if (crossOrigin) {
				const headers = nextInit.headers as Headers
				for (const name of CREDENTIAL_HEADERS) headers.delete(name)
				headers.delete(this.authName)
				for (const name of this._customHeaderNames()) headers.delete(name)
			}
			await response.body?.cancel().catch(() => {})
			current = target
			currentInit = nextInit
		}
	}

	/** Names of headers set by `config.headers` (static form) — stripped on a cross-origin hop. */
	private _customHeaderNames(): string[] {
		const h = this._config.headers
		return h && typeof h !== "function" ? Object.keys(h) : []
	}

	/** Build, send and post-process one request: hooks, auth refresh, redirects. */
	private async _send(
		method: string,
		path: string,
		opts: RequestOptions,
		kind: Kind,
		meta?: RequestMeta,
		isRetry = false,
	): Promise<Sent> {
		const url = this._url(path, opts)
		const headers = await this._headers(opts, { method, path })
		if (kind === "stream") {
			headers.set("accept", "text/event-stream")
			if (opts.lastEventId) headers.set("last-event-id", opts.lastEventId)
		}
		let body = encodeBody(opts, headers)

		if (this._config.onRequest) {
			const reqCtx: OnRequestContext = {
				body,
				headers,
				method,
				path,
				state: this._config.state ?? {},
				url: url.toString(),
			}
			if (meta) {
				reqCtx.invalidatedBy = meta.invalidatedBy
				reqCtx.isStale = meta.isStale
				reqCtx.selector = meta.selector
			}
			for (const hook of this._config.onRequest) {
				await hook(reqCtx)
			}
			body = reqCtx.body
		}

		const { signal, done, exemptFromTimeout } = this._signal(opts, kind)
		const cleanups: Array<() => void> = [done]
		const finish = () => {
			for (const fn of cleanups.splice(0)) fn()
		}
		const init: RequestInit = { body, headers, method, signal }
		if (this._config.credentials) init.credentials = this._config.credentials
		if (this._config.mode) init.mode = this._config.mode
		/* a stream body needs half-duplex on Node's fetch */
		if (body !== undefined && !isReplayable(body)) (init as RequestInit & { duplex?: string }).duplex = "half"

		try {
			signal?.throwIfAborted()
			let response = await this._fetchWithRedirects(url, init)

			if (response.status === 401 && this._config.onAuthExpired && !isRetry && isReplayable(body)) {
				const sent = headers.get(this.authName)
				const rejectedToken = sent?.startsWith(this.authPrefix) ? sent.slice(this.authPrefix.length) : (sent ?? null)
				const token = await this._refresh(rejectedToken)
				if (token !== null) {
					const retryHeaders = new Headers(headers)
					retryHeaders.set(this.authName, `${this.authPrefix}${token}`)
					init.headers = retryHeaders
					await response.body?.cancel().catch(() => {})
					response = await this._fetchWithRedirects(url, { ...init })
				}
			}

			if (this._config.onResponse) {
				let request: Request | undefined
				const resCtx: OnResponseContext = {
					isRetry,
					method,
					path,
					get request() {
						/* built on demand: constructing a Request per response is not free */
						request ??= new Request(url.toString(), { ...init, body: isReplayable(body) ? body : undefined })
						return request
					},
					response,
					retry: async () => {
						if (isRetry) return resCtx.response
						const again = await this._send(method, path, opts, kind, meta, true)
						cleanups.push(again.done)
						return again.response
					},
					state: this._config.state ?? {},
					url: url.toString(),
				}
				if (meta) {
					resCtx.invalidatedBy = meta.invalidatedBy
					resCtx.isStale = meta.isStale
					resCtx.selector = meta.selector
				}
				for (const hook of this._config.onResponse) {
					const result = await hook(resCtx)
					if (result instanceof Response) {
						response = result
						resCtx.response = result
					}
				}
			}

			return { done: finish, exemptFromTimeout, response }
		} catch (e) {
			finish()
			throw e
		}
	}

	private async _parseBody(response: Response, method: string): Promise<unknown> {
		if (
			response.status === 204 ||
			response.status === 205 ||
			response.status === 304 ||
			method.toUpperCase() === "HEAD"
		) {
			await response.body?.cancel().catch(() => {})
			return null
		}
		const ct = mediaEssence(response)
		if (isJsonType(ct)) {
			const text = await response.text()
			if (text.length === 0) return null
			try {
				return JSON.parse(text)
			} catch {
				throw clientErrorFor({
					body: text,
					message: "Response body is not valid JSON",
					response,
					status: response.status,
				})
			}
		}
		if (isTextType(ct)) return response.text()
		const buffer = await response.arrayBuffer()
		return buffer.byteLength === 0 ? null : buffer
	}

	/** Read the response of a REST call into a value (throw mode) or a result tuple (safe mode). */
	private async _finish(sent: Sent, method: string, shouldThrow: boolean): Promise<unknown> {
		const { response } = sent
		try {
			if (!response.ok) {
				const error = await errorFromResponse(response)
				if (shouldThrow) throw error
				return { data: null, error: safeErrorValue(error), response: error.response, status: response.status }
			}
			if (shouldThrow) return await this._parseBody(response, method)
			try {
				const data = await this._parseBody(response, method)
				return { data, error: null, response, status: response.status }
			} catch (e) {
				return { data: null, error: e, response, status: response.status }
			}
		} finally {
			sent.done()
		}
	}

	private _iterate(sent: Sent): AsyncIterable<SSEEvent> {
		return {
			async *[Symbol.asyncIterator]() {
				try {
					if (!sent.response.body) return
					yield* parseSSEStream(sent.response.body)
				} finally {
					sent.done()
				}
			},
		}
	}

	/** Throw mode — throws ClientError (a per-status subclass) on non-2xx */
	async request(method: string, path: string, opts: RequestOptions, _requestMeta?: RequestMeta): Promise<unknown> {
		const sent = await this._send(method, path, opts, "rest", _requestMeta)
		return this._finish(sent, method, true)
	}

	/** Safe mode — returns { data, error, response, status }; `error` is truthy for every non-2xx */
	async requestSafe(
		method: string,
		path: string,
		opts: RequestOptions,
		_requestMeta?: RequestMeta,
	): Promise<{
		data: unknown
		error: unknown
		response: Response
		status: number
	}> {
		const sent = await this._send(method, path, opts, "rest", _requestMeta)
		return this._finish(sent, method, false) as Promise<{
			data: unknown
			error: unknown
			response: Response
			status: number
		}>
	}

	/**
	 * One request whose shape is decided by the response: an event stream becomes an
	 * `AsyncIterable<SSEEvent>` (never buffered, exempt from the timeout once headers arrive);
	 * anything else is parsed as in `request` / `requestSafe`.
	 */
	async requestAuto(method: string, path: string, opts: RequestOptions, shouldThrow: boolean): Promise<unknown> {
		const sent = await this._send(method, path, opts, "auto")
		if (sent.response.ok && isEventStream(sent.response)) {
			sent.exemptFromTimeout()
			return this._iterate(sent)
		}
		return this._finish(sent, method, shouldThrow)
	}

	requestStream(method: string, path: string, opts: RequestOptions): AsyncIterable<SSEEvent> {
		return {
			[Symbol.asyncIterator]: () => this._doStream(method, path, opts),
		}
	}

	private async *_doStream(
		method: string,
		path: string,
		opts: RequestOptions,
	): AsyncGenerator<SSEEvent, void, undefined> {
		const sent = await this._send(method, path, opts, "stream")
		if (!sent.response.ok) {
			try {
				throw await errorFromResponse(sent.response)
			} finally {
				sent.done()
			}
		}
		yield* this._iterate(sent)
	}

	buildUrl(path: string, opts: RequestOptions): string {
		return this._url(path, opts).toString()
	}

	buildPath(path: string, opts: RequestOptions): string {
		const resolved = opts.params ? interpolatePath(path, opts.params) : interpolatePath(path)

		if (!opts.search) return resolved

		const serializer = this._config.buildSearchParams ?? defaultSearchParams
		const params = serializer(opts.search)
		if (this._config.sortSearchParams) params.sort()

		const qs = params.toString()
		return qs ? `${resolved}?${qs}` : resolved
	}

	buildWSUrl(path: string, opts: RequestOptions): string {
		const url = this._url(path, opts)
		if (url.protocol === "https:") url.protocol = "wss:"
		else if (url.protocol === "http:") url.protocol = "ws:"
		return url.toString()
	}
}
