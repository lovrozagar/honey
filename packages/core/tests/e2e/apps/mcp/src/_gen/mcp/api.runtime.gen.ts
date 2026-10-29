/** A `Content-Type`, read as far as the client needs it: its essence, type and structured suffix. */
export type MediaType = {
	/** `type/subtype`, lowercased, without parameters */
	essence: string
	/** the structured-syntax suffix (`json` for `application/vnd.api+json`), or `null` */
	suffix: string | null
	type: string
}

/* RFC 9110 token characters */
const MEDIA_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** `value` as a media type; `null` when it is missing or not `token/token`. */
export function parseMediaType(value: string | null | undefined): MediaType | null {
	if (value === null || value === undefined) return null
	const semi = value.indexOf(";")
	const head = (semi === -1 ? value : value.slice(0, semi)).trim()
	const slash = head.indexOf("/")
	if (slash === -1) return null
	const type = head.slice(0, slash).toLowerCase()
	const subtype = head.slice(slash + 1).toLowerCase()
	if (!MEDIA_TOKEN.test(type) || !MEDIA_TOKEN.test(subtype)) return null
	const plus = subtype.lastIndexOf("+")
	const suffix = plus > 0 && plus < subtype.length - 1 ? subtype.slice(plus + 1) : null
	return { essence: `${type}/${subtype}`, suffix, type }
}

/** JSON bodies: `application/json` and any `+json` type. */
export function isJsonMediaType(mt: MediaType | null): boolean {
	return mt !== null && (mt.essence === "application/json" || mt.suffix === "json")
}

/** Text-like bodies: `text/*`, `application/xml`, and any `+xml` type. */
export function isTextMediaType(mt: MediaType | null): boolean {
	return mt !== null && (mt.type === "text" || mt.essence === "application/xml" || mt.suffix === "xml")
}

/** Absolute client bases: http(s) and ws(s). Case-insensitive per WHATWG. */
const ABSOLUTE_CLIENT_URL = /^(?:https?|wss?):\/\//i

export function invalidBaseURLError(baseURL: string): Error {
	return new Error(
		`Invalid baseURL ${JSON.stringify(baseURL)}: expected an absolute http(s): or ws(s): URL. Path-only values such as "/api" resolve against location.origin in browsers.`,
	)
}

/**
 * Honor `config.fetch` as-is. If omitted, bind the environment fetch so storing it on a client
 * field does not throw `Illegal invocation` in browsers.
 */
export function bindDefaultFetch(custom?: typeof fetch): typeof fetch {
	if (custom) return custom
	const nativeFetch = globalThis.fetch
	return typeof nativeFetch === "function" ? nativeFetch.bind(globalThis) : (nativeFetch as typeof fetch)
}

function currentLocationOrigin(): string | undefined {
	let origin: unknown
	try {
		origin = globalThis.location?.origin
	} catch {
		/* a sandboxed location that throws on read: there is no origin to resolve against */
		return undefined
	}
	if (typeof origin !== "string" || origin === "" || origin === "null") return undefined
	if (!ABSOLUTE_CLIENT_URL.test(origin)) return undefined
	return origin
}

/**
 * Parse `baseURL`. Absolute `http(s):` / `ws(s):` URLs are unchanged. Path-only values such as
 * `/api` resolve against `location.origin` when present.
 */
export function parseClientBaseURL(baseURL: string): URL {
	if (ABSOLUTE_CLIENT_URL.test(baseURL)) return new URL(baseURL)
	const origin = currentLocationOrigin()
	if (origin !== undefined) {
		try {
			return new URL(baseURL, origin)
		} catch {
			throw invalidBaseURLError(baseURL)
		}
	}
	throw invalidBaseURLError(baseURL)
}

/**
 * Headers a request may carry to another origin when a `redirect: "follow"` client follows a
 * cross-origin redirect. Everything else is dropped on that hop: credentials, the auth header and
 * every header set from config, per call or by an `onRequest` hook, whatever its name. An
 * allowlist, so a header added later never leaks by default (H18.10).
 */
export const CROSS_ORIGIN_SAFE_HEADERS: readonly string[] = ["accept", "accept-language", "user-agent"]

/** The headers to send on a cross-origin hop: only the allowlisted ones from `headers`. */
export function crossOriginHeaders(headers: Headers): Headers {
	const out = new Headers()
	for (const name of CROSS_ORIGIN_SAFE_HEADERS) {
		const value = headers.get(name)
		if (value !== null) out.set(name, value)
	}
	return out
}

export type ClientErrorInit<TBody = unknown> = {
	body: TBody
	message: string
	response: Response
	status: number
}

/** A non-2xx answer: its status, the parsed body (JSON when it parses, else text) and the response. */
export class ClientError<TBody = unknown> extends Error {
	readonly body: TBody
	readonly response: Response
	readonly status: number

	constructor(init: ClientErrorInit<TBody>) {
		super(init.message)
		/* V8 only, and not in every lib: read it as optional so the runtime compiles anywhere */
		;(Error as { captureStackTrace?: (target: object, ctor?: unknown) => void }).captureStackTrace?.(this, new.target)
		this.name = "ClientError"
		this.body = init.body
		this.response = init.response
		this.status = init.status
	}
}

export class BadRequestError<TBody = unknown> extends ClientError<TBody> {
	override name = "BadRequestError"
}
export class UnauthorizedError<TBody = unknown> extends ClientError<TBody> {
	override name = "UnauthorizedError"
}
export class ForbiddenError<TBody = unknown> extends ClientError<TBody> {
	override name = "ForbiddenError"
}
export class NotFoundError<TBody = unknown> extends ClientError<TBody> {
	override name = "NotFoundError"
}
export class ConflictError<TBody = unknown> extends ClientError<TBody> {
	override name = "ConflictError"
}
export class UnprocessableEntityError<TBody = unknown> extends ClientError<TBody> {
	override name = "UnprocessableEntityError"
}
export class RateLimitError<TBody = unknown> extends ClientError<TBody> {
	override name = "RateLimitError"
}
export class InternalServerError<TBody = unknown> extends ClientError<TBody> {
	override name = "InternalServerError"
}
export class BadGatewayError<TBody = unknown> extends ClientError<TBody> {
	override name = "BadGatewayError"
}
export class ServiceUnavailableError<TBody = unknown> extends ClientError<TBody> {
	override name = "ServiceUnavailableError"
}
export class GatewayTimeoutError<TBody = unknown> extends ClientError<TBody> {
	override name = "GatewayTimeoutError"
}

const STATUS_ERRORS: Readonly<Record<number, new (init: ClientErrorInit) => ClientError>> = {
	400: BadRequestError,
	401: UnauthorizedError,
	403: ForbiddenError,
	404: NotFoundError,
	409: ConflictError,
	422: UnprocessableEntityError,
	429: RateLimitError,
	500: InternalServerError,
	502: BadGatewayError,
	503: ServiceUnavailableError,
	504: GatewayTimeoutError,
}

/** The most specific error class for a status: `UnauthorizedError` for 401, `ClientError` otherwise. */
export function clientErrorFor<TBody>(init: ClientErrorInit<TBody>): ClientError<TBody> {
	const Cls = (Object.hasOwn(STATUS_ERRORS, init.status) ? STATUS_ERRORS[init.status] : undefined) ?? ClientError
	return new Cls(init) as ClientError<TBody>
}

export function isClientError<T = unknown>(e: unknown): e is ClientError<T> {
	return e instanceof ClientError
}

/** A request with no answer; the platform error is its `cause`. */
export class APIConnectionError extends Error {
	override name = "APIConnectionError"
}

/** A send or body read with no answer as APIConnectionError, its cause the platform's; an abort's as it is (f2). */
export function noAnswer(cause: unknown, url: unknown, init?: RequestInit): unknown {
	if (init?.signal?.aborted) return cause
	const { origin, pathname } = new URL(String(url))
	return new APIConnectionError(`${init?.method} ${origin}${pathname}: the connection failed`, { cause })
}

/** A fetch failure as APIConnectionError; an abort's as it is. */
export function connectionErrors(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
	if (typeof fetch !== "function") return fetch
	/* asserted, as Bun's fetch type also names `preconnect` */
	return (async (input, init) => {
		try {
			return await fetch(input, init)
		} catch (cause) {
			throw noAnswer(cause, input, init)
		}
	}) as typeof globalThis.fetch
}

/**
 * Client-side path templates. Two spellings are accepted, segment by segment:
 *
 * - Honey route patterns: `:name` (or `:name?`) takes a whole segment, `*name` (or `*`) takes the
 *   rest of the path. Names follow the router grammar, so `:user-id` is one parameter.
 * - OpenAPI templates: `{name}` anywhere inside a segment (`/ops/{id}:cancel`).
 *
 * Values are percent-encoded. A value that would change the path's shape once a URL parser
 * normalizes it (`""`, `.`, `..`) is rejected, so `{ id: ".." }` can never retarget a request to
 * the parent resource and `{ org: "" }` can never turn `/:org/:repo` into `//repo`.
 */

/** A fresh `{name}` placeholder matcher: a global regex carries `lastIndex`, so none is shared. */
const braces = () => /\{([^{}/]+)\}/g

export class PathParamError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "PathParamError"
	}
}

function paramValue(params: Record<string, unknown>, key: string): string | undefined {
	const raw = Object.hasOwn(params, key) ? params[key] : undefined
	if (raw === undefined || raw === null) return undefined
	return typeof raw === "string" ? raw : String(raw)
}

function encodeSegmentValue(key: string, value: string): string {
	if (value === "" || value === "." || value === "..") {
		throw new PathParamError(
			`Invalid path param ${JSON.stringify(key)}: ${JSON.stringify(value)} is not a path segment`,
		)
	}
	return encodeURIComponent(value)
}

/** A wildcard value may span segments; each one is encoded and validated on its own. */
function encodeWildcardValue(key: string, value: string): string {
	if (value === "") return ""
	return value
		.split("/")
		.map((part) => encodeSegmentValue(key, part))
		.join("/")
}

/** One `:name`/`:name?` segment, `null` when an optional one is left out. */
function paramSegment(seg: string, params: Record<string, unknown>): string | null {
	const optional = seg.endsWith("?")
	const name = optional ? seg.slice(1, -1) : seg.slice(1)
	const value = paramValue(params, name)
	if (value !== undefined) return encodeSegmentValue(name, value)
	if (optional) return null
	throw new PathParamError(`Missing path param: ${name}`)
}

/** The trailing `*`/`*name` segment: an unnamed one may be left empty. */
function wildcardSegment(seg: string, params: Record<string, unknown>): string {
	const name = seg.length > 1 ? seg.slice(1) : "*"
	const value = paramValue(params, name)
	if (value !== undefined) return encodeWildcardValue(name, value)
	if (seg.length === 1) return ""
	throw new PathParamError(`Missing path param: ${name}`)
}

export function interpolatePath(path: string, params: Record<string, unknown> = {}): string {
	const segments = path.split("/")
	const out: string[] = []
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i] as string
		if (seg.length > 1 && seg.charCodeAt(0) === 58 /* : */) {
			const value = paramSegment(seg, params)
			if (value !== null) out.push(value)
		} else if (seg.charCodeAt(0) === 42 /* * */ && i === segments.length - 1) out.push(wildcardSegment(seg, params))
		else {
			out.push(
				seg.replace(braces(), (_, name: string) => {
					const value = paramValue(params, name)
					if (value === undefined) throw new PathParamError(`Missing path param: ${name}`)
					return encodeSegmentValue(name, value)
				}),
			)
		}
	}
	return out.join("/")
}

/** True when the template still has a placeholder in either spelling. */
export function hasPlaceholder(path: string): boolean {
	for (const seg of path.split("/")) {
		if (seg.length > 1 && seg.charCodeAt(0) === 58) return true
		if (seg.charCodeAt(0) === 42) return true
		if (braces().test(seg)) return true
	}
	return false
}

/**
 * Substitute the params that are present and leave the others as placeholders. Used for
 * invalidation targets, where a partially resolved target is still a narrower pattern.
 */
export function interpolatePartial(path: string, params: Record<string, unknown>): string {
	return path
		.split("/")
		.map((seg, i, all) => {
			if (seg.length > 1 && seg.charCodeAt(0) === 58) {
				const optional = seg.endsWith("?")
				const name = optional ? seg.slice(1, -1) : seg.slice(1)
				const value = paramValue(params, name)
				return value === undefined ? seg : encodeSegmentValue(name, value)
			}
			if (seg.charCodeAt(0) === 42 && i === all.length - 1) {
				const value = paramValue(params, seg.length > 1 ? seg.slice(1) : "*")
				return value === undefined ? seg : encodeWildcardValue(seg.slice(1), value)
			}
			return seg.replace(braces(), (match, name: string) => {
				const value = paramValue(params, name)
				return value === undefined ? match : encodeSegmentValue(name, value)
			})
		})
		.join("/")
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** The regex source of one literal segment, its `{name}` placeholders matching one segment's text. */
function literalSource(seg: string): string {
	let source = ""
	let last = 0
	const brace = braces()
	for (let m = brace.exec(seg); m !== null; m = brace.exec(seg)) {
		source += `${escapeRegExp(seg.slice(last, m.index))}[^/]+`
		last = m.index + m[0].length
	}
	return source + escapeRegExp(seg.slice(last))
}

/** Compile a template to a regex over concrete paths, using the same segment grammar; the caller caches it. */
export function compilePattern(pattern: string): RegExp {
	const segments = pattern.split("/")
	let source = ""
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i] as string
		const sep = i === 0 ? "" : "/"
		if (seg.length > 1 && seg.charCodeAt(0) === 58) source += seg.endsWith("?") ? `(?:${sep}[^/]+)?` : `${sep}[^/]+`
		else if (seg.charCodeAt(0) === 42 && i === segments.length - 1) source += `(?:${sep}.*)?`
		else source += sep + literalSource(seg)
	}
	return new RegExp(`^${source}$`)
}

/** What one call sends beyond the path: its parameters, headers, body and timing. */
export type RequestOptions = {
	/** a base URL for this call alone, in place of `config.baseURL` (C2) */
	baseURL?: string
	/** raw bytes sent as they are, `application/octet-stream` unless a content type is set */
	body?: ArrayBuffer | Blob | ReadableStream<Uint8Array> | Uint8Array
	cookies?: Record<string, string>
	form?: Record<string, unknown>
	headers?: Record<string, string | undefined>
	/** the `Idempotency-Key` an idempotent operation sends; a fresh one per call otherwise */
	idempotencyKey?: string
	json?: unknown
	lastEventId?: string
	params?: Record<string, string>
	/** resolve the unread `Response` instead of its parsed body (C2); throw mode still throws on non-2xx */
	raw?: boolean
	search?: Record<string, unknown>
	signal?: AbortSignal
	/** Per-call timeout in milliseconds; overrides `config.timeout`, `0` disables it. */
	timeout?: number
}

/** How a request is read: by its answer (`auto`), as a value (`rest`) or as an event stream (`stream`). */
export type RequestKind = "auto" | "rest" | "stream"

/** A query or form value as text: a Date by its ISO string; nothing for null, undefined or a symbol. */
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

/** The query of `query`: an array repeats its key, null and undefined are left out. */
export function defaultSearchParams(query: Record<string, unknown>): URLSearchParams {
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

/* RFC 9110's token: what a header name may hold */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** `value` for the header `name`, else a TypeError naming the header, never the value (Node's Headers quotes it). */
export function headerValue(name: string, value: string): string {
	if (!TOKEN.test(name)) throw new TypeError(`the ${name} header cannot be sent`)
	for (let i = 0; i < value.length; i++) {
		const cp = value.charCodeAt(i)
		if ((cp < 0x20 && cp !== 0x09) || cp === 0x7f) throw new TypeError(`the ${name} header's value cannot be sent`)
	}
	return value
}

/** Each of `layers` over the last, checked; `cookies` joined on; a fresh `x-request-id` unless one is set. */
export function headersOf(
	layers: Record<string, string | undefined>[],
	cookies: Record<string, string> = {},
	requestId: boolean,
): Headers {
	const headers = new Headers()
	for (const layer of layers)
		for (const [k, v] of Object.entries(layer)) if (v !== undefined) headers.set(k, headerValue(k, v))
	const pairs = Object.entries(cookies)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join("; ")
	if (pairs) {
		const existing = headers.get("cookie")
		headers.set("cookie", existing ? `${existing}; ${pairs}` : pairs)
	}
	if (requestId && !headers.has("x-request-id")) headers.set("x-request-id", newClientRequestId())
	return headers
}

/**
 * RFC 4122 §4.4 UUID for `x-request-id`: `crypto.randomUUID` where it exists, else
 * `getRandomValues`, so older runtimes still work without node:crypto.
 */
export function newClientRequestId(): string {
	const c = globalThis.crypto as Crypto | undefined
	if (c && typeof c.randomUUID === "function") return c.randomUUID()
	if (c && typeof c.getRandomValues === "function") {
		const bytes = c.getRandomValues(new Uint8Array(16))
		bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40
		bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80
		let out = ""
		for (let i = 0; i < 16; i++) {
			if (i === 4 || i === 6 || i === 8 || i === 10) out += "-"
			out += (bytes[i] as number).toString(16).padStart(2, "0")
		}
		return out
	}
	throw new Error("honey: no crypto.randomUUID or crypto.getRandomValues in this runtime")
}

function isFileLike(v: unknown): boolean {
	return (typeof File !== "undefined" && v instanceof File) || (typeof Blob !== "undefined" && v instanceof Blob)
}

function isFileList(v: unknown): v is ArrayLike<File> {
	return typeof FileList !== "undefined" && v instanceof FileList
}

/** A form with a file in it, as multipart: fetch sets the boundary, so no content type is set here. */
function multipartBody(entries: [string, unknown][]): FormData {
	const fd = new FormData()
	for (const [k, v] of entries) {
		if (v === undefined || v === null) continue
		const items = isFileList(v) ? Array.from(v) : Array.isArray(v) ? v : [v]
		for (const item of items) {
			if (isFileLike(item)) fd.append(k, item as Blob)
			else {
				const s = coerceFormValue(k, item)
				if (s !== null) fd.append(k, s)
			}
		}
	}
	return fd
}

/** The body `opts` declares, setting its content type on `headers`; both encodings repeat a key per array item. */
export function encodeBody(opts: RequestOptions, headers: Headers): BodyInit | undefined {
	if (opts.body !== undefined) {
		if (!headers.has("content-type")) headers.set("content-type", "application/octet-stream")
		return opts.body as BodyInit
	}
	if (opts.json !== undefined) {
		headers.set("content-type", "application/json")
		try {
			return JSON.stringify(opts.json)
		} catch (e) {
			/* nothing was sent: a status-0 error, a result in safe mode like any other failure */
			const message = `JSON serialization failed: ${e instanceof Error ? e.message : String(e)}`
			throw new ClientError({ body: opts.json, message, response: Response.error(), status: 0 })
		}
	}
	if (opts.form === undefined) return undefined
	const entries = Object.entries(opts.form)
	if (entries.some(([, v]) => isFileLike(v) || isFileList(v) || (Array.isArray(v) && v.some(isFileLike)))) {
		return multipartBody(entries)
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
export function isReplayable(body: BodyInit | null | undefined): boolean {
	return !(typeof ReadableStream !== "undefined" && body instanceof ReadableStream)
}

function timeoutError(ms: number): Error {
	return typeof DOMException === "function"
		? new DOMException(`Request timed out after ${ms} ms`, "TimeoutError")
		: Object.assign(new Error(`Request timed out after ${ms} ms`), { name: "TimeoutError" })
}

/** A request's signal: the caller's abort, the client's and the timeout as one, alive until `done()`. */
export type RequestSignal = {
	/** release the timer and the listeners; call once the body has been read or abandoned */
	done: () => void
	/** stop the timeout but keep the cancellations (the answer turned out to be a stream) */
	exemptFromTimeout: () => void
	signal: AbortSignal | undefined
}

/**
 * The signal for one request, aborting with the first of `sources` (the caller's, the client's
 * dispose) or the timeout: a stream has no timeout; `timeout` 0 or less disables it. Listeners,
 * not `AbortSignal.any`: a combined signal only weakly held can be collected before it fires.
 */
export function requestSignal(
	sources: readonly (AbortSignal | undefined)[],
	timeout: number | undefined,
): RequestSignal {
	const signals = sources.filter((signal): signal is AbortSignal => signal !== undefined)
	const timed = timeout !== undefined && timeout > 0
	if (!timed && signals.length <= 1) return { done: () => {}, exemptFromTimeout: () => {}, signal: signals[0] }
	const ctrl = new AbortController()
	const timer = timed ? setTimeout(() => ctrl.abort(timeoutError(timeout)), timeout) : undefined
	;(timer as unknown as { unref?: () => void } | undefined)?.unref?.()
	const listeners = signals.map((signal) => {
		const onAbort = () => ctrl.abort(signal.reason)
		if (signal.aborted) ctrl.abort(signal.reason)
		else signal.addEventListener("abort", onAbort, { once: true })
		return () => signal.removeEventListener("abort", onAbort)
	})
	return {
		done: () => {
			clearTimeout(timer)
			for (const remove of listeners) remove()
		},
		exemptFromTimeout: () => clearTimeout(timer),
		signal: ctrl.signal,
	}
}

/** The fetch init for one send: credentials and mode from the config, half-duplex for a stream body. */
export function requestInit(
	at: { body: BodyInit | undefined; headers: Headers; method: string; signal: AbortSignal | undefined },
	config: Pick<ClientConfig, "credentials" | "mode">,
): RequestInit {
	const init: RequestInit = { ...at }
	if (config.credentials) init.credentials = config.credentials
	if (config.mode) init.mode = config.mode
	/* a stream body needs half-duplex on Node's fetch */
	if (at.body !== undefined && !isReplayable(at.body)) (init as RequestInit & { duplex?: string }).duplex = "half"
	return init
}

/** A sent request: its answer, and how to release what it holds once the body is read. */
export type Sent = {
	done: () => void
	exemptFromTimeout: () => void
	/** a failed body read's error (noAnswer) */
	failed: (cause: unknown) => unknown
	response: Response
}

/** A safe-mode result: `error` is truthy for every non-2xx and always carries `status`. */
export type SafeResult = { data: unknown; error: unknown; response: Response; status: number }

export function isEventStream(response: Response): boolean {
	return parseMediaType(response.headers.get("content-type"))?.essence === "text/event-stream"
}

/** How a REST answer is read: thrown or as a result, parsed or raw, and which response headers to keep (A2). */
export type Reading = {
	/**
	 * the non-JSON media type the operation declares: its body is read as that type, empty or not.
	 * `null` when it declares no success body: whatever arrives is discarded and reads as null.
	 */
	declared?: string | null
	headers?: readonly string[]
	/** the client's limits: an error message's characters, and the bytes a body may hold decoded */
	limits?: Limits
	method: string
	raw?: boolean
	shouldThrow: boolean
}

/** A server's message as an Error may carry it: ASCII control characters stripped, `max` characters at most. */
function sanitizeMessage(message: string, max: number): string {
	let out = ""
	for (const ch of message) {
		const code = ch.charCodeAt(0)
		if (code > 31 && code !== 127) out += ch
	}
	return out.slice(0, max)
}

/** What a client bounds an answer to: its error message's characters, and its body's decoded bytes. */
export type Limits = { readonly maxErrorMessageChars?: number; readonly maxResponseBytes?: number }

/** The most bytes a body may hold, decoded, before its read is refused: 100 MiB, as every other SDK's. */
export const MAX_RESPONSE_BYTES = 100 * 1024 * 1024

/** `response`'s body, read in the chunks it arrives in, refused past `max` decoded bytes with the body cancelled. */
async function bodyBytes(response: Response, max = MAX_RESPONSE_BYTES): Promise<Uint8Array> {
	const reader = response.body?.getReader()
	if (reader === undefined) return new Uint8Array(0)
	const chunks: Uint8Array[] = []
	let size = 0
	for (let next = await reader.read(); !next.done; next = await reader.read()) {
		size += next.value.byteLength
		if (size > max) {
			/* not awaited: a cloned body's branch settles its cancel only once its twin cancels too */
			reader.cancel().catch(() => {
				/* the refusal stands whether or not the body cancels cleanly */
			})
			const sent = response.headers.get("content-length")
			const what = [response.headers.get("content-type") ?? "no content type", sent && `${sent} bytes`]
			const message = `Response body is over the ${max}-byte cap (${what.filter(Boolean).join(", ")})`
			throw clientErrorFor({ body: null, message, response, status: response.status })
		}
		chunks.push(next.value)
	}
	const bytes = new Uint8Array(size)
	let at = 0
	for (const chunk of chunks) {
		bytes.set(chunk, at)
		at += chunk.byteLength
	}
	return bytes
}

/** `response`'s body as UTF-8 text, bounded as bodyBytes reads it. */
const bodyText = async (response: Response, max?: number) => new TextDecoder().decode(await bodyBytes(response, max))

/**
 * Read an error body: JSON when it parses, else the text, else null; one past `max` bytes reads as null, and its
 * `preserved` twin is cancelled with it, so the body's source stops.
 */
async function readErrorBody(response: Response, preserved: Response, max?: number): Promise<unknown> {
	let text: string
	try {
		text = await bodyText(response, max)
	} catch {
		/* an unreadable body still answers with its status */
		preserved.body?.cancel().catch(() => {
			/* the twin may already be gone */
		})
		return null
	}
	if (text.length === 0) return null
	try {
		return JSON.parse(text)
	} catch {
		/* not JSON: the text itself is the body */
		return text
	}
}

/** The typed error a non-2xx answer becomes, its response kept readable, its body and message bounded by `limits`. */
export async function errorFromResponse(response: Response, limits: Limits = {}): Promise<ClientError> {
	const preserved = response.clone()
	const body = await readErrorBody(response, preserved, limits.maxResponseBytes)
	const message =
		typeof body === "object" && body !== null && "message" in body
			? (body as Record<string, unknown>).message
			: undefined
	const text =
		typeof message === "string" && message.length > 0
			? `HTTP ${response.status}: ${sanitizeMessage(message, limits.maxErrorMessageChars ?? 512)}`
			: `HTTP ${response.status}`
	return clientErrorFor({ body, message: text, response: preserved, status: response.status })
}

/** The safe-mode error: the server's error object when the body is a JSON object, else the ClientError. */
function safeErrorValue(error: ClientError): unknown {
	const body = error.body
	return typeof body === "object" && body !== null && !Array.isArray(body) ? body : error
}

/** A body with no content to read: 204/205/304 and every answer to HEAD. */
function hasNoBody(response: Response, method: string): boolean {
	return response.status === 204 || response.status === 205 || response.status === 304 || method === "HEAD"
}

/**
 * A 2xx body as a value. An operation declaring no body (`declared` null) reads as null, as a 204
 * does. A declared text or binary answer reads as that type, so an empty one is `""` or zero bytes;
 * otherwise by its content type: JSON parsed, text as text, anything else as bytes (A1), and null
 * when empty.
 */
export async function parseBody(
	response: Response,
	method: string,
	declared?: string | null,
	max?: number,
): Promise<unknown> {
	if (declared === null || hasNoBody(response, method.toUpperCase())) {
		await response.body?.cancel().catch(() => {
			/* nothing to read: a cancel that fails changes nothing */
		})
		return null
	}
	if (declared !== undefined) {
		if (isTextMediaType(parseMediaType(declared))) return bodyText(response, max)
		return bodyBytes(response, max)
	}
	const type = parseMediaType(response.headers.get("content-type"))
	if (isJsonMediaType(type)) {
		const text = await bodyText(response, max)
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
	if (isTextMediaType(type)) return bodyText(response, max)
	const bytes = await bodyBytes(response, max)
	return bytes.byteLength === 0 ? null : bytes
}

/** The declared response headers (A2), by lower-case name, each one only when the answer carries it. */
function declaredHeaders(response: Response, names: readonly string[]): Record<string, string> {
	const out: Record<string, string> = {}
	for (const name of names) {
		const value = response.headers.get(name)
		if (value !== null) out[name] = value
	}
	return out
}

/** A safe-mode success, with the declared headers when the operation declares any. */
function success(data: unknown, response: Response, names: readonly string[] | undefined): SafeResult {
	const result: SafeResult = { data, error: null, response, status: response.status }
	if (names) Object.assign(result, { headers: declaredHeaders(response, names) })
	return result
}

/** Read the answer of a REST call into its value (throw mode), a result (safe mode), or the raw response. */
export async function finishRequest(sent: Sent, reading: Reading): Promise<unknown> {
	const { response } = sent
	const { method, shouldThrow } = reading
	try {
		if (!response.ok) {
			if (reading.raw && !shouldThrow) return response
			const error = await errorFromResponse(response, reading.limits)
			if (shouldThrow) throw error
			return { data: null, error: safeErrorValue(error), response: error.response, status: response.status }
		}
		if (reading.raw) return response
		const max = reading.limits?.maxResponseBytes
		if (shouldThrow) return await parseBody(response, method, reading.declared, max)
		try {
			return success(await parseBody(response, method, reading.declared, max), response, reading.headers)
		} catch (e) {
			return { data: null, error: e, response, status: response.status }
		}
	} finally {
		sent.done()
	}
}

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
	/** The header for `onAuthExpired`'s token: unset, the API's scheme's; set, its prefix is yours (unset: none). */
	authHeaderName?: string
	/** That header's prefix; set alone, the scheme's header keeps it. */
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
	/** The most UTF-8 bytes one event-stream line may hold before the stream errors. Default 1 MiB. */
	sseMaxLineBytes?: number
	/** The most UTF-8 bytes one event's data may hold, its joining newlines counted. Default 8 MiB. */
	sseMaxEventBytes?: number
	state?: Record<string, unknown>
	throwOnError?: boolean
	/** Milliseconds for a whole request, including reading the body; a stream's only up to its headers. */
	timeout?: number
}

const REDIRECT_STATUSES: readonly number[] = [301, 302, 303, 307, 308]
const MAX_REDIRECTS = 20

/** Browsers hide redirect targets from script (`opaqueredirect`), so the platform must follow. */
function platformFollowsRedirects(): boolean {
	const g = globalThis as { document?: unknown; WorkerGlobalScope?: unknown }
	return typeof g.document !== "undefined" || typeof g.WorkerGlobalScope !== "undefined"
}

/** The request for the next hop, or `null` when this redirect must be returned unfollowed. */
function nextHop(response: Response, init: RequestInit, crossOrigin: boolean): RequestInit | null {
	const next: RequestInit = { ...init, headers: new Headers(init.headers) }
	if (response.status === 307 || response.status === 308) {
		/* a body is replayed only to the same origin, and only when it can be sent twice */
		if (init.body != null && (crossOrigin || !isReplayable(init.body))) return null
	} else {
		/* 303, and 301/302 for POST: the browser behavior is GET without a body */
		const method = (init.method ?? "GET").toUpperCase()
		if (response.status === 303 ? method !== "HEAD" : method === "POST") {
			next.method = "GET"
			next.body = undefined
			;(next.headers as Headers).delete("content-type")
		}
	}
	if (crossOrigin) next.headers = crossOriginHeaders(next.headers as Headers)
	return next
}

/** Where a redirect leads, when it is one this client follows: http(s), and same-origin unless `follow`. */
function redirectTarget(response: Response, current: URL, origin: string, policy: RedirectPolicy): URL | null {
	const location = response.headers.get("location")
	if (!REDIRECT_STATUSES.includes(response.status) || location === null) return null
	let target: URL
	try {
		target = new URL(location, current)
	} catch {
		/* an unparseable Location is returned as the answer it is */
		return null
	}
	if (target.protocol !== "http:" && target.protocol !== "https:") return null
	return target.origin !== origin && policy !== "follow" ? null : target
}

/**
 * Send `init` to `url`, following redirects as `policy` says: hop by hop, so a cross-origin hop
 * carries only the safe headers and never a body.
 */
export async function fetchFollowing(
	fetch: typeof globalThis.fetch,
	url: URL,
	init: RequestInit,
	{ origin, policy }: { origin: string; policy: RedirectPolicy },
): Promise<Response> {
	if (policy === "manual" || policy === "error" || platformFollowsRedirects()) {
		return fetch(url.toString(), policy === "same-origin" ? init : { ...init, redirect: policy })
	}
	let current = url
	let currentInit: RequestInit = { ...init, redirect: "manual" }
	for (let hop = 0; ; hop++) {
		const response = await fetch(current.toString(), currentInit)
		const target = hop >= MAX_REDIRECTS ? null : redirectTarget(response, current, origin, policy)
		const next = target === null ? null : nextHop(response, currentInit, target.origin !== origin)
		if (target === null || next === null) return response
		await response.body?.cancel().catch(() => {
			/* the redirect's own body is never read */
		})
		current = target
		currentInit = next
	}
}

/** Where a response hook runs: the request as sent, its answer, and how to send it again. */
export type ResponseAt = {
	init: RequestInit
	isRetry: boolean
	meta: RequestMeta | undefined
	method: string
	path: string
	response: Response
	retry: () => Promise<Response>
	state: Record<string, unknown>
	url: URL
}

/** `ctx` with the read's stale view, when the SDK tracks one. */
function withMeta<T extends object>(ctx: T, meta: RequestMeta | undefined): T {
	if (meta) Object.assign(ctx, { invalidatedBy: meta.invalidatedBy, isStale: meta.isStale, selector: meta.selector })
	return ctx
}

/** Let each `onRequest` hook see the request and change it; resolves to the body it now sends. */
export async function runRequestHooks(
	hooks: NonNullable<ClientConfig["onRequest"]>,
	ctx: OnRequestContext,
	meta: RequestMeta | undefined,
): Promise<BodyInit | undefined> {
	withMeta(ctx, meta)
	for (const hook of hooks) await hook(ctx)
	return ctx.body
}

/** Let each `onResponse` hook see the answer and replace it. */
export async function runResponseHooks(
	hooks: NonNullable<ClientConfig["onResponse"]>,
	at: ResponseAt,
): Promise<Response> {
	let request: Request | undefined
	const { init } = at
	const ctx: OnResponseContext = {
		isRetry: at.isRetry,
		method: at.method,
		path: at.path,
		get request() {
			/* built on demand: constructing a Request per response is not free */
			request ??= new Request(at.url.toString(), { ...init, body: isReplayable(init.body) ? init.body : undefined })
			return request
		},
		response: at.response,
		retry: () => (at.isRetry ? Promise.resolve(ctx.response) : at.retry()),
		state: at.state,
		url: at.url.toString(),
	}
	withMeta(ctx, at.meta)
	for (const hook of hooks) {
		const result = await hook(ctx)
		if (result instanceof Response) ctx.response = result
	}
	return ctx.response
}

/** The `onLog` entries of one exchange: its start now, then its answer or its failure, each with its duration. */
export function exchangeLog(
	onLog: ((entry: LogEntry) => void) | undefined,
	operation: string,
): { answered: (response: Response) => void; failed: (error: unknown) => void } {
	const start = Date.now()
	onLog?.({ duration_ms: 0, event: "request_start", level: "debug", operation })
	const took = () => Date.now() - start
	return {
		answered: (response) => {
			const level = response.status >= 400 ? "warn" : "info"
			onLog?.({ duration_ms: took(), event: "response_received", level, operation, status: response.status })
		},
		failed: (error) => {
			const status = (error as { status?: unknown } | null)?.status
			const entry: LogEntry = { duration_ms: took(), error, event: "error", level: "error", operation }
			onLog?.(typeof status === "number" ? { ...entry, status } : entry)
		},
	}
}

/** One server-sent event; `data` is the raw text, or the parsed value when the operation declares JSON events. */
export type SSEEvent<T = string> = {
	data: T
	event?: string
	/** The last event ID (sticky across events, as `EventSource.lastEventId`). Absent while empty. */
	id?: string
	retry?: number
}

/* the siblings' caps, in UTF-8 bytes */
const MAX_LINE = 1 << 20
const MAX_EVENT = 8 << 20

/** `text`'s UTF-8 bytes, counted until past `max`. */
function bytesOf(text: string, max = Infinity): number {
	let bytes = 0
	for (let i = 0; i < text.length && bytes <= max; i++) {
		const unit = text.charCodeAt(i)
		bytes += unit < 0x80 ? 1 : unit < 0x800 || (unit >= 0xd800 && unit < 0xe000) ? 2 : 3
	}
	return bytes
}

/** Whether `line` is over `max` UTF-8 bytes; a third of `max` in code units is within it, uncounted. */
const overLine = (line: string, max: number) => line.length * 3 > max && bytesOf(line, max) > max

/** One event being read: its fields as they arrive, dispatched on a blank line. */
class EventFields {
	readonly #max: number
	#data: string[] = []
	#size = 0
	#hasData = false
	#event: string | undefined
	#lastId = ""
	#retry: number | undefined

	constructor(max: number) {
		this.#max = max
	}

	/** The event so far, when it has data; every field but the sticky id resets. */
	dispatch(): SSEEvent | undefined {
		const out = this.#hasData ? ({ data: this.#data.join("\n") } as SSEEvent) : undefined
		if (out) {
			if (this.#event !== undefined && this.#event !== "") out.event = this.#event
			if (this.#lastId !== "") out.id = this.#lastId
			if (this.#retry !== undefined) out.retry = this.#retry
			this.#retry = undefined
		}
		this.#data = []
		this.#size = 0
		this.#hasData = false
		this.#event = undefined
		return out
	}

	/** One `field: value` line; a comment or an unknown field changes nothing. */
	read(line: string): void {
		if (line.charCodeAt(0) === 58 /* : */) return
		const colon = line.indexOf(":")
		const field = colon === -1 ? line : line.slice(0, colon)
		let value = colon === -1 ? "" : line.slice(colon + 1)
		if (value.charCodeAt(0) === 32) value = value.slice(1)
		if (field === "data") {
			this.#size += bytesOf(value) + (this.#hasData ? 1 : 0)
			if (this.#size > this.#max) throw new Error(`SSE event exceeds ${this.#max} bytes`)
			this.#data.push(value)
			this.#hasData = true
		} else if (field === "event") this.#event = value
		else if (field === "id") {
			if (!value.includes("\0")) this.#lastId = value
		} else if (field === "retry" && /^\d+$/.test(value)) this.#retry = Number(value)
	}
}

/**
 * The complete lines at the head of `pending` (CRLF, LF or CR), what is left after them, and how
 * much of that rest is already known to hold no line end. `from` is that count from the last call:
 * the scan resumes there, so a long line arriving in many chunks is read once, not once per chunk.
 */
function completeLines(pending: string, from: number): { lines: string[]; rest: string; scanned: number } {
	const lines: string[] = []
	let start = 0
	let end = from
	while (start < pending.length) {
		end = Math.max(end, start)
		while (end < pending.length && pending.charCodeAt(end) !== 10 && pending.charCodeAt(end) !== 13) end++
		if (end === pending.length) break
		/* a CR as the last character may be the first half of CRLF */
		if (pending.charCodeAt(end) === 13 && end === pending.length - 1) break
		lines.push(pending.slice(start, end))
		start = end + (pending.charCodeAt(end) === 13 && pending.charCodeAt(end + 1) === 10 ? 2 : 1)
	}
	return { lines, rest: pending.slice(start), scanned: Math.max(end - start, 0) }
}

/** `stream`'s reader, and a read whose failure throws `failed`'s error for it. */
function readerOf(stream: ReadableStream<Uint8Array>, failed = (cause: unknown) => cause) {
	const reader = stream.getReader()
	const read = () =>
		/* no answer (f2) */
		reader.read().catch((cause) => {
			throw failed(cause)
		})
	return { read, reader }
}

/**
 * Parse a `text/event-stream` body per the WHATWG "event stream interpretation" rules: lines end
 * at CRLF, LF or CR; a leading BOM is skipped; `id` persists until changed and an `id` holding NUL
 * is ignored; `retry` counts only when all ASCII digits; an event still open when the stream ends
 * is discarded. A line over `maxLineBytes` (1 MiB) or an event's data over `maxEventBytes` (8 MiB), in UTF-8 bytes,
 * throws after every event completed before it, as does a failed read, by `failed`. Leaving a `for await` early (a
 * break, return or throw) cancels the body's reader, which frees the connection.
 */
export async function* parseSSEStream(
	stream: ReadableStream<Uint8Array>,
	opts?: { failed?: (cause: unknown) => unknown; maxLineBytes?: number; maxEventBytes?: number },
): AsyncGenerator<SSEEvent, void, undefined> {
	const decoder = new TextDecoder()
	const { failed, maxEventBytes = MAX_EVENT, maxLineBytes: maxLine = MAX_LINE } = opts ?? {}
	const { read, reader } = readerOf(stream, failed)
	const fields = new EventFields(maxEventBytes)
	let pending = ""
	let scanned = 0
	let first = true
	try {
		for (let chunk = await read(); !chunk.done; chunk = await read()) {
			pending += decoder.decode(chunk.value, { stream: true })
			if (first && pending.length > 0) {
				if (pending.charCodeAt(0) === 0xfeff) pending = pending.slice(1)
				first = false
			}
			const complete = completeLines(pending, scanned)
			pending = complete.rest
			scanned = complete.scanned
			const { lines } = complete
			for (const line of lines) {
				if (overLine(line, maxLine)) throw new Error(`SSE line exceeds ${maxLine} bytes`)
				const out = line === "" ? fields.dispatch() : fields.read(line)
				if (out) yield out
			}
			if (overLine(pending, maxLine)) throw new Error(`SSE line exceeds ${maxLine} bytes`)
		}
		/* a lone CR held back at the end of the stream still ends a blank line; anything else open is discarded */
		if (pending === "\r") {
			const out = fields.dispatch()
			if (out) yield out
		}
	} finally {
		await reader.cancel().catch(() => {
			/* the stream is done either way */
		})
		reader.releaseLock()
	}
}

/**
 * An operation's WebSocket. Its dial runs no onRequest or onResponse hook, and a refused handshake's 401 is its error,
 * with no onAuthExpired refresh. The platform WebSocket exposes no ping and no message cap, so this socket has neither.
 */
export type TypedWebSocket = {
	close(code?: number, reason?: string): void
	off(event: "binary" | "close" | "error" | "message" | "open", handler: (...args: never[]) => void): void
	/** Binary frames, as `ArrayBuffer`. Text frames go to `"message"`. */
	on(event: "binary", handler: (data: ArrayBuffer) => void): void
	on(event: "close", handler: (code: number, reason: string) => void): void
	on(event: "error", handler: (error: unknown) => void): void
	/** Text frames. */
	on(event: "message", handler: (data: string) => void): void
	on(event: "open", handler: () => void): void
	readonly readyState: number
	/**
	 * Strings, `ArrayBuffer`, typed arrays and `Blob` are sent as-is; any other value is JSON-encoded.
	 * Sends before the socket opens are queued; after it closes they are dropped.
	 */
	send(data: ArrayBuffer | ArrayBufferView | Blob | object | string): void
}

export type WSOptions = {
	protocols?: string | string[]
}

type Payload = Blob | string | Uint8Array<ArrayBuffer>
type Handler = (...args: never[]) => void

const WS_EVENTS: readonly string[] = ["binary", "close", "error", "message", "open"]

/** The DOM listener that hands `event` to `handler` in its typed shape. */
function wrapListener(event: string, handler: Handler): EventListener {
	const call = handler as (...args: unknown[]) => void
	if (event === "message") {
		return (e) => {
			const data = (e as MessageEvent).data
			if (typeof data === "string") call(data)
		}
	}
	if (event === "binary") {
		return (e) => {
			const data = (e as MessageEvent).data
			if (data instanceof ArrayBuffer) call(data)
		}
	}
	if (event === "open") return () => call()
	if (event === "close") return (e) => call((e as CloseEvent).code, (e as CloseEvent).reason)
	return (e) => call(e)
}

/** `data` as a frame: text and Blobs as they are, bytes copied, anything else as JSON. */
function toPayload(data: ArrayBuffer | ArrayBufferView | Blob | object | string): Payload {
	if (typeof data === "string") return data
	if (typeof Blob !== "undefined" && data instanceof Blob) return data
	if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
		const view =
			data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
		const copy = new Uint8Array(view.byteLength)
		copy.set(view)
		return copy
	}
	return JSON.stringify(data)
}

/** A WebSocket with typed events, a send queue until it opens, and nothing sent once it closes. */
class TypedSocket {
	readonly #ws: WebSocket
	/* user handler → wrapped listener, per event, so one handler can be registered for several events */
	readonly #listeners = new Map<string, WeakMap<Handler, EventListener>>()
	readonly #queue: Payload[] = []
	#state: "closed" | "connecting" | "open" = "connecting"

	constructor(ws: WebSocket) {
		this.#ws = ws
		ws.binaryType = "arraybuffer"
		ws.addEventListener("open", () => {
			this.#state = "open"
			for (const msg of this.#queue) ws.send(msg)
			this.#queue.length = 0
		})
		ws.addEventListener("close", () => {
			this.#state = "closed"
			this.#queue.length = 0
		})
	}

	get readyState(): number {
		return this.#ws.readyState
	}

	close(code?: number, reason?: string): void {
		this.#state = "closed"
		this.#queue.length = 0
		this.#ws.close(code, reason)
	}

	on(event: string, handler: Handler): void {
		if (!WS_EVENTS.includes(event)) return
		const byHandler = this.#listeners.get(event) ?? new WeakMap<Handler, EventListener>()
		this.#listeners.set(event, byHandler)
		const target = event === "binary" ? "message" : event
		const previous = byHandler.get(handler)
		if (previous) this.#ws.removeEventListener(target, previous)
		const wrapped = wrapListener(event, handler)
		byHandler.set(handler, wrapped)
		this.#ws.addEventListener(target, wrapped)
	}

	off(event: string, handler: Handler): void {
		const byHandler = this.#listeners.get(event)
		const wrapped = byHandler?.get(handler)
		if (!wrapped) return
		this.#ws.removeEventListener(event === "binary" ? "message" : event, wrapped)
		byHandler?.delete(handler)
	}

	send(data: ArrayBuffer | ArrayBufferView | Blob | object | string): void {
		if (this.#state === "closed") return
		const payload = toPayload(data)
		if (this.#state === "connecting") this.#queue.push(payload)
		else this.#ws.send(payload)
	}
}

export function createTypedWebSocket(
	url: string,
	opts?: WSOptions,
	WebSocketImpl: typeof WebSocket = WebSocket,
): TypedWebSocket {
	const ws = opts?.protocols ? new WebSocketImpl(url, opts.protocols) : new WebSocketImpl(url)
	const socket = new TypedSocket(ws)
	const typed: TypedWebSocket = {
		close: (code, reason) => socket.close(code, reason),
		off: (event, handler) => socket.off(event, handler),
		on: ((event: string, handler: Handler) => socket.on(event, handler)) as TypedWebSocket["on"],
		get readyState() {
			return socket.readyState
		},
		send: (data) => socket.send(data),
	}
	Object.defineProperty(typed, "_ws", { enumerable: false, value: ws })
	return typed
}

/**
 * The realtime resume protocol's client side (H8): the frames a server sends, the errors a
 * connection ends with, the transport adapters a consumer plugs in, the keepalive loop and the
 * fallback chain that picks the first transport to answer `ready`.
 */

export type ServerFrame =
	| { data: unknown; id?: string; reconnectToken?: string; t: "msg" }
	| { t: "pong" }
	| { reason: string; t: "bye" }
	| { reconnectToken: string; t: "ready" }

export class RealtimeError extends Error {
	readonly reason: string

	constructor(message: string, reason: string) {
		super(message)
		this.reason = reason
		this.name = "RealtimeError"
	}
}

export class RealtimeConnectError extends RealtimeError {
	override name = "RealtimeConnectError"
}

export class RealtimeKickedError extends RealtimeError {
	override name = "RealtimeKickedError"
}

export class RealtimeAbortError extends RealtimeError {
	override name = "RealtimeAbortError"
}

export type Transport = "longpoll" | "sse" | "ws"

export type ConnectionState = "closed" | "connected" | "connecting" | "draining" | "idle" | "reconnecting"

export type TransportOpts = {
	headers?: Record<string, string>
	lastEventId?: string
	reconnectToken?: string
	signal?: AbortSignal
}

/** One live transport: the adapter calls `onFrame`, `onClose` and `onError`; the client replaces them. */
export type TransportConnection = {
	close(): void
	onClose: (reason: string) => void
	onError: (err: unknown) => void
	onFrame: (frame: ServerFrame) => void
	send(data: string): Promise<void> | void
}

/** A swallowed callback: a consumer's hook must never break the reconnect loop. */
export function safely(fn: (() => void) | undefined): void {
	try {
		fn?.()
	} catch {
		/* the consumer's callback threw; the connection carries on */
	}
}

export type TransportAdapter = {
	connect(url: string, opts: TransportOpts): TransportConnection
}

/** The transport the adapter at `index` of a chain stands for: WebSocket, then SSE, then long polling. */
export function transportAt(index: number): Transport {
	if (index === 0) return "ws"
	return index === 1 ? "sse" : "longpoll"
}

export type KeepaliveOptions = {
	interval?: number
	onDead: () => void
	sendPing: () => void
	timeout?: number
	transport: Transport
}

export type KeepaliveLoop = { onFrame(): void; onPong(): void; start(): void; stop(): void }

/**
 * A connection's liveness: over WebSocket a ping every `interval` and dead after `timeout` without
 * a pong; over SSE dead after `timeout` without a frame; long polling needs none.
 */
class Keepalive implements KeepaliveLoop {
	readonly #opts: KeepaliveOptions
	#ping: ReturnType<typeof setInterval> | null = null
	#dead: ReturnType<typeof setTimeout> | null = null

	constructor(opts: KeepaliveOptions) {
		this.#opts = opts
	}

	#armDead(): void {
		if (this.#dead !== null) clearTimeout(this.#dead)
		this.#dead = setTimeout(() => this.#opts.onDead(), this.#opts.timeout ?? 60_000)
	}

	start(): void {
		this.stop()
		const { transport } = this.#opts
		if (transport === "longpoll") return
		if (transport === "ws") this.#ping = setInterval(() => this.#opts.sendPing(), this.#opts.interval ?? 25_000)
		this.#armDead()
	}

	stop(): void {
		if (this.#ping !== null) clearInterval(this.#ping)
		if (this.#dead !== null) clearTimeout(this.#dead)
		this.#ping = null
		this.#dead = null
	}

	onPong(): void {
		if (this.#dead !== null) this.#armDead()
	}

	onFrame(): void {
		if (this.#opts.transport === "sse" && this.#dead !== null) this.#armDead()
	}
}

export function createKeepaliveLoop(opts: KeepaliveOptions): KeepaliveLoop {
	return new Keepalive(opts)
}

/** The keepalive `set` gives `transport` (WebSocket 20 s unless set, SSE none; 0 none), dead an interval after a ping. */
export function keepaliveOf(
	set: number | undefined,
	transport: Transport,
	conn: { send(data: string): void },
	onDead: () => void,
): KeepaliveLoop | null {
	const interval = set ?? (transport === "ws" ? 20_000 : 0)
	if (interval <= 0) return null
	const sendPing = () => conn.send(JSON.stringify({ t: "ping" }))
	return createKeepaliveLoop({ interval, onDead, sendPing, timeout: 2 * interval, transport })
}

/** Dial `adapter` and resolve once it sends `ready`; reject on an error, a close or `timeout`. */
export function dialReady(
	adapter: TransportAdapter,
	target: { opts: TransportOpts; url: string },
	timeout: number,
): Promise<TransportConnection> {
	return new Promise((resolve, reject) => {
		const conn = adapter.connect(target.url, target.opts)
		const timer = setTimeout(() => {
			conn.close()
			reject(new Error("timeout"))
		}, timeout)
		const onFrame = conn.onFrame
		conn.onFrame = (frame) => {
			if (frame.t !== "ready") return onFrame(frame)
			clearTimeout(timer)
			conn.onFrame = onFrame
			resolve(conn)
		}
		conn.onError = (err) => {
			clearTimeout(timer)
			conn.close()
			reject(err)
		}
		conn.onClose = (reason) => {
			clearTimeout(timer)
			reject(new Error(reason))
		}
	})
}

/** The dial statuses no retry changes, most specific highest; a WebSocket refused without a status ranks lowest. */
const RANK: Record<number, number> = { 400: 3, 401: 6, 403: 5, 404: 1, 405: 1, 410: 2, 422: 4 }
const rank = (err: unknown) =>
	RANK[(err as { status?: number } | null)?.status ?? 0] ?? Number((err as RealtimeError)?.reason === "upgrade_refused")
export const refused = (err: unknown): boolean => rank(err) > 0
/** Dial 0, 1, … until one opens; else the last transient failure, or the most specific refusal. A 401 refreshes once. */
export async function walkChain<T>(
	count: number,
	dial: (index: number) => Promise<T>,
	opened: (index: number) => unknown,
	refresh?: () => Promise<boolean>,
): Promise<T> {
	let transient: unknown
	let refusal: unknown
	for (let i = 0; i < count; i++) {
		try {
			const conn = await dial(i)
			opened(i)
			return conn
		} catch (err) {
			if (rank(err) === 6 && refresh) {
				const fresh = await refresh()
				refresh = undefined
				if (fresh) {
					;[i, transient, refusal] = [-1, undefined, undefined]
					continue
				}
			}
			if (!refused(err)) transient = err
			else if (rank(err) > rank(refusal)) refusal = err
		}
	}
	throw transient ?? refusal
}

export type FallbackChain = {
	connect(url: string, transportOpts: TransportOpts): Promise<{ conn: TransportConnection; transport: Transport }>
	readonly provenTransport: Transport | null
}

/** Try each transport in order until one is ready; remember the one that worked and try it first next time. */
class Chain implements FallbackChain {
	readonly #transports: TransportAdapter[]
	readonly #timeout: number
	#proven: number | null = null

	constructor(opts: { timeout?: number; transports: TransportAdapter[] }) {
		this.#transports = opts.transports
		this.#timeout = opts.timeout ?? 3000
	}

	get provenTransport(): Transport | null {
		return this.#proven === null ? null : transportAt(this.#proven)
	}

	async #dial(url: string, opts: TransportOpts) {
		const proven = this.#proven
		if (proven !== null && proven < this.#transports.length) {
			try {
				const conn = await dialReady(this.#transports[proven] as TransportAdapter, { opts, url }, this.#timeout)
				return { conn, transport: transportAt(proven) }
			} catch {
				/* the proven transport failed: fall through to the whole chain */
			}
		}
		for (let i = 0; i < this.#transports.length; i++) {
			try {
				const conn = await dialReady(this.#transports[i] as TransportAdapter, { opts, url }, this.#timeout)
				this.#proven = i
				return { conn, transport: transportAt(i) }
			} catch {
				/* try the next one */
			}
		}
		throw new RealtimeConnectError("All transports failed", "all_failed")
	}

	connect(url: string, opts: TransportOpts): Promise<{ conn: TransportConnection; transport: Transport }> {
		const attempt =
			this.#transports.length === 0
				? Promise.reject(new RealtimeConnectError("No transports configured", "no_transports"))
				: this.#dial(url, opts)
		/* a caller that never awaits the attempt must not see an unhandled rejection */
		attempt.catch(() => {})
		return attempt
	}
}

export function createFallbackChain(opts: { timeout?: number; transports: TransportAdapter[] }): FallbackChain {
	return new Chain(opts)
}

export type ResumableConnectionOpts = {
	fallbackTimeout?: number
	/** Each dial's headers; a function is read on every dial, so a rotated token reaches the reconnect. */
	headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>)
	/** Ping every this many ms (WebSocket 20 s, SSE none, unless set; 0: none); one unanswered as long reconnects. */
	keepaliveInterval?: number
	lastEventId?: string
	/** Reconnects after a drop before the stream ends; 0 retries forever. Default 5. */
	maxReconnectAttempts?: number
	onReconnected?: () => void
	onReconnecting?: (attempt: number, transport: Transport) => void
	reconnectDelayMs?: number
	reconnectToken?: string
	signal?: AbortSignal
	transports: TransportAdapter[]
	url: string
}

export type ResumableConnection<T = unknown> = {
	close(reason?: string): void
	readonly provenTransport: Transport | null
	/** Resolves once sent; over SSE and long-poll a POST, rejecting with its error. */
	send(data: unknown): Promise<void>
	/** `send`'s raw form: `text` as it is, a text frame or a POSTed text/plain body. */
	sendText(text: string): Promise<void>
	readonly state: ConnectionState
	[Symbol.asyncIterator](): AsyncIterableIterator<T>
}

type QueueEntry = { type: "done" } | { error: unknown; type: "error" } | { type: "value"; value: unknown }

/**
 * One logical stream over reconnecting transports: messages arrive in order through the async
 * iterator, a drop reconnects (proven transport first, then the chain) and resumes from the last
 * message id with the server's reconnect token.
 */
export class Resumable implements ResumableConnection {
	readonly #opts: ResumableConnectionOpts
	readonly #refresh: (() => Promise<boolean>) | undefined
	readonly #queue: QueueEntry[] = []
	#pending: { reject: (err: unknown) => void; resolve: (result: IteratorResult<unknown>) => void } | null = null
	#state: ConnectionState = "idle"
	#conn: TransportConnection | null = null
	#keepalive: KeepaliveLoop | null = null
	#attempts = 0
	#proven: number | null = null
	#lastEventId: string | undefined
	#reconnectToken: string | undefined
	#started = false
	#closed = false
	/** the dial and reconnect timers still pending: `close()` clears them, so nothing outlives the connection */
	readonly #timers = new Set<ReturnType<typeof setTimeout>>()
	/** the transport being dialed, closed with the connection */
	#dialing: TransportConnection | null = null

	constructor(opts: ResumableConnectionOpts, refresh?: () => Promise<boolean>) {
		this.#opts = opts
		this.#refresh = refresh
		this.#lastEventId = opts.lastEventId
		this.#reconnectToken = opts.reconnectToken
		if (opts.signal?.aborted) this.#end()
		else opts.signal?.addEventListener("abort", () => this.#abort(), { once: true })
	}

	get state(): ConnectionState {
		return this.#state
	}

	get provenTransport(): Transport | null {
		return this.#proven === null ? null : transportAt(this.#proven)
	}

	#end(): void {
		this.#state = "closed"
		this.#closed = true
		for (const timer of this.#timers) clearTimeout(timer)
		this.#timers.clear()
		const dialing = this.#dialing
		this.#dialing = null
		dialing?.close()
	}

	/** Run `fn` after `ms`, unless the connection closes first; the timer never holds the process open. */
	#later(fn: () => void, ms: number): () => void {
		const timer = setTimeout(() => {
			this.#timers.delete(timer)
			fn()
		}, ms)
		;(timer as unknown as { unref?: () => void }).unref?.()
		this.#timers.add(timer)
		return () => {
			clearTimeout(timer)
			this.#timers.delete(timer)
		}
	}

	#enqueue(entry: QueueEntry): void {
		const pending = this.#pending
		if (!pending) {
			this.#queue.push(entry)
			return
		}
		this.#pending = null
		if (entry.type === "value") pending.resolve({ done: false, value: entry.value })
		else if (entry.type === "done") pending.resolve({ done: true, value: undefined })
		else pending.reject(entry.error)
	}

	#detach(): void {
		this.#keepalive?.stop()
		this.#keepalive = null
		const conn = this.#conn
		if (!conn) return
		this.#conn = null
		conn.onFrame = () => {}
		conn.onError = () => {}
		conn.onClose = () => {}
		try {
			conn.close()
		} catch {
			/* an adapter's close is best-effort */
		}
	}

	#abort(): void {
		if (this.#state === "closed") return
		this.#end()
		this.#detach()
		this.#enqueue({ error: new RealtimeAbortError("Connection aborted", "aborted"), type: "error" })
	}

	/** A frame on a ready connection: a message, a new reconnect token, a pong or the server's goodbye. */
	#onFrame(frame: ServerFrame): void {
		this.#keepalive?.onFrame()
		if (frame.t === "msg") {
			this.#lastEventId = frame.id ?? this.#lastEventId
			this.#reconnectToken = frame.reconnectToken || this.#reconnectToken
			this.#enqueue({ type: "value", value: frame.data })
		} else if (frame.t === "ready") this.#reconnectToken = frame.reconnectToken || this.#reconnectToken
		else if (frame.t === "pong") this.#keepalive?.onPong()
		else {
			this.#detach()
			this.#reconnect()
		}
	}

	/** Dial adapter `index` with this dial's headers (a function's read now); resolve when ready, frames wired first. */
	#dial(index: number): Promise<TransportConnection> {
		const given = this.#opts.headers
		if (typeof given === "function") return Promise.resolve(given()).then((headers) => this.#dialWith(index, headers))
		return this.#dialWith(index, given)
	}

	#dialWith(index: number, headers: Record<string, string> | undefined): Promise<TransportConnection> {
		return new Promise((resolve, reject) => {
			if (this.#closed) return reject(new RealtimeConnectError("the connection is closed", "closed"))
			const adapter = this.#opts.transports[index] as TransportAdapter
			const opts = { headers, lastEventId: this.#lastEventId, reconnectToken: this.#reconnectToken }
			const conn = adapter.connect(this.#opts.url, { ...opts, signal: this.#opts.signal })
			this.#dialing = conn
			let ready = false
			const cancel = this.#later(() => {
				this.#dialing = null
				conn.close()
				reject(new RealtimeConnectError("transport open timeout", "timeout"))
			}, this.#opts.fallbackTimeout ?? 3000)
			const fail = (error: unknown) => {
				cancel()
				if (this.#dialing === conn) this.#dialing = null
				if (!ready) return reject(error)
				this.#detach()
				if (refused(error)) this.#refuse(error)
				else this.#reconnect()
			}
			conn.onFrame = (frame) => {
				/* a message before ready is kept; a goodbye before ready is the server refusing the open */
				if (ready || frame.t === "msg" || frame.t === "pong") return this.#onFrame(frame)
				if (frame.t === "bye") {
					conn.close()
					return fail(new RealtimeConnectError(`transport refused: ${frame.reason}`, "bye"))
				}
				ready = true
				cancel()
				this.#dialing = null
				/* the connection from its ready frame on, so a drop before the caller resumes is seen */
				this.#conn = conn
				this.#reconnectToken = frame.reconnectToken || this.#reconnectToken
				resolve(conn)
			}
			conn.onError = (err) => {
				if (!ready) conn.close()
				fail(err)
			}
			conn.onClose = (reason) =>
				fail(new RealtimeConnectError(`transport closed before ready: ${reason}`, "closed_early"))
		})
	}

	/** The proven transport first, then walkChain. */
	#open(): Promise<TransportConnection> {
		const { transports } = this.#opts
		if (transports.length === 0)
			return Promise.reject(new RealtimeConnectError("No transports configured", "no_transports"))
		const walk = () =>
			walkChain(
				transports.length,
				(i) => this.#dial(i),
				(i) => (this.#proven = i),
				this.#refresh,
			)
		return this.#proven === null ? walk() : this.#dial(this.#proven).catch(walk)
	}

	#watch(conn: TransportConnection): void {
		if (this.#proven === null) return
		this.#keepalive = keepaliveOf(this.#opts.keepaliveInterval, transportAt(this.#proven), conn, () => {
			this.#detach()
			this.#reconnect()
		})
		this.#keepalive?.start()
	}

	async #connect(): Promise<void> {
		if (this.#closed) return
		if (this.#state === "idle") this.#state = "connecting"
		try {
			const conn = await this.#open()
			/* closed, or dropped between its ready frame and here (a reconnect is already scheduled) */
			if (this.#closed || this.#conn !== conn) return
			this.#state = "connected"
			this.#attempts = 0
			this.#watch(conn)
			safely(this.#opts.onReconnected)
		} catch (err) {
			if (refused(err)) this.#refuse(err)
			else this.#reconnect()
		}
	}

	/** End the connection with a refusal no retry changes. */
	#refuse(err: unknown): void {
		this.#end()
		this.#enqueue({ error: err, type: "error" })
	}

	/** After a drop or a failed open: wait, then dial again; past the attempt cap the stream ends. */
	#reconnect(): void {
		if (this.#closed) return
		this.#attempts += 1
		const max = this.#opts.maxReconnectAttempts ?? 5
		if (max > 0 && this.#attempts > max) {
			this.#end()
			this.#enqueue({ type: "done" })
			return
		}
		this.#state = "reconnecting"
		/* a drop means that transport is not healthy: the next attempt walks the whole chain */
		this.#proven = null
		const attempt = this.#attempts
		safely(() => this.#opts.onReconnecting?.(attempt, transportAt(0)))
		this.#later(() => void this.#connect(), this.#opts.reconnectDelayMs ?? 1000)
	}

	send(data: unknown): Promise<void> {
		return this.sendText(JSON.stringify(data))
	}

	async sendText(text: string): Promise<void> {
		if (!this.#closed) await this.#conn?.send(text)
	}

	close(_reason?: string): void {
		if (this.#state === "closed") return
		this.#end()
		this.#detach()
		this.#enqueue({ type: "done" })
	}

	#next(): Promise<IteratorResult<unknown>> {
		if (!this.#started && !this.#closed) {
			this.#started = true
			this.#state = "connecting"
			void this.#connect()
		}
		const entry = this.#queue.shift()
		if (entry?.type === "value") return Promise.resolve({ done: false, value: entry.value })
		if (entry?.type === "error") return Promise.reject(entry.error)
		if (entry || this.#closed) return Promise.resolve({ done: true, value: undefined })
		const next = new Promise<IteratorResult<unknown>>((resolve, reject) => {
			this.#pending = { reject, resolve }
		})
		next.catch(() => {})
		return next
	}

	[Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
		const iterator: AsyncIterableIterator<unknown> = {
			next: () => this.#next(),
			[Symbol.asyncIterator]: () => iterator,
		}
		return iterator
	}
}

export function createResumableConnection(opts: ResumableConnectionOpts): ResumableConnection {
	return new Resumable(opts)
}

/** One request, ready to send: where, with what, and the hooks' view of it. */
type Prepared = { body: BodyInit | undefined; headers: Headers; url: URL }

/** One call: its method, path template and options; `refreshes: false` leaves a 401 to the realtime loop. */
type Call = { method: string; opts: RequestOptions; path: string; refreshes?: false }

/** The realtime loop's refresh key, exported by the SDK under no name. */
export const REFRESH_AUTH = /* @__PURE__ */ Symbol("honey.refreshAuth")

/** One operation of a generated SDK: the call, how it is read, and its stale view for the hooks. */
export type Operation = Call & {
	/** the non-JSON media type the operation declares, read as that type; null when it declares no body */
	declared?: string | null
	headers?: readonly string[]
	meta?: RequestMeta
	shouldThrow: boolean
}

/** Ignore a failed cancel: the body is being discarded either way. */
const discard = (response: Response) =>
	response.body?.cancel().catch(() => {
		/* discarded */
	})

export class HTTPClient {
	readonly #config: ClientConfig
	readonly #fetch: typeof fetch
	#base: URL | undefined
	#token: string | null = null
	#refreshing: Promise<string | null> | null = null

	readonly #disposal: AbortSignal | undefined

	/** `disposal` aborts every request in flight and refuses later ones (a generated SDK's `dispose()`). */
	constructor(config: ClientConfig, disposal?: AbortSignal) {
		this.#config = config
		this.#fetch = connectionErrors(bindDefaultFetch(config.fetch))
		this.#disposal = disposal
	}

	/** The base URL, parsed once; a per-call base (C2) is parsed for that call. */
	#baseFor(opts: RequestOptions): URL {
		if (opts.baseURL !== undefined) return parseClientBaseURL(opts.baseURL)
		this.#base ??= parseClientBaseURL(this.#config.baseURL)
		return this.#base
	}

	get #authName(): string {
		return this.#config.authHeaderName ?? "Authorization"
	}

	get #authPrefix(): string {
		return this.#config.authHeaderPrefix ?? (this.#config.authHeaderName === undefined ? "Bearer " : "")
	}

	#query(search: Record<string, unknown>): URLSearchParams {
		const params = (this.#config.buildSearchParams ?? defaultSearchParams)(search)
		if (this.#config.sortSearchParams) params.sort()
		return params
	}

	/** Resolve `path` against the base URL, keeping the base path and query, and assert it stays there. */
	#url(path: string, opts: RequestOptions): URL {
		const resolved = interpolatePath(path, opts.params)
		const base = this.#baseFor(opts)
		const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`
		const url = new URL(base.href)
		url.pathname = `${basePath}${resolved.startsWith("/") ? resolved.slice(1) : resolved}`
		url.hash = ""
		/* params are validated, so this only fires on a malformed template; never send it anywhere else */
		if (url.origin !== base.origin || !url.pathname.startsWith(basePath.slice(0, -1))) {
			throw new Error(`Request path ${JSON.stringify(path)} resolves outside the base URL`)
		}
		if (opts.search) for (const [k, v] of this.#query(opts.search).entries()) url.searchParams.append(k, v)
		return url
	}

	async #headers(opts: RequestOptions, ctx: HeadersContext): Promise<Headers> {
		const configured = this.#config.headers
		const resolved = typeof configured === "function" ? await configured(ctx) : configured
		/* a refreshed token replaces the configured one; per-call headers still win */
		const auth = this.#token === null ? {} : { [this.#authName]: `${this.#authPrefix}${this.#token}` }
		return headersOf([resolved ?? {}, auth, opts.headers ?? {}], opts.cookies, this.#config.requestId !== false)
	}

	/** Share one `onAuthExpired` call between concurrent 401s; reuse a token another request already got. */
	#refresh(rejectedToken: string | null): Promise<string | null> {
		if (this.#token !== null && rejectedToken !== this.#token) return Promise.resolve(this.#token)
		if (this.#refreshing) return this.#refreshing
		const hook = this.#config.onAuthExpired
		if (!hook) return Promise.resolve(null)
		this.#refreshing = Promise.resolve()
			.then(() => hook({ rejectedToken }))
			.then((token) => {
				this.#token = typeof token === "string" && token.length > 0 ? token : null
				return this.#token
			})
			.finally(() => {
				this.#refreshing = null
			})
		return this.#refreshing
	}

	/** The client's one shared refresh; whether a new token is in place. */
	async [REFRESH_AUTH](): Promise<boolean> {
		return (await this.#refresh(this.#token)) !== null
	}

	/** Build the request and let the `onRequest` hooks see and change it. */
	async #prepare({ method, opts, path }: Call, kind: RequestKind, meta?: RequestMeta) {
		const url = this.#url(path, opts)
		const headers = await this.#headers(opts, { method, path })
		if (kind === "stream") {
			headers.set("accept", "text/event-stream")
			if (opts.lastEventId) headers.set("last-event-id", opts.lastEventId)
		}
		const prepared: Prepared = { body: encodeBody(opts, headers), headers, url }
		if (!this.#config.onRequest) return prepared
		const ctx = { body: prepared.body, headers, method, path, state: this.#config.state ?? {}, url: url.toString() }
		prepared.body = await runRequestHooks(this.#config.onRequest, ctx, meta)
		return prepared
	}

	/** Send, following redirects; on a 401 with a refresh hook, retry once with the fresh token. */
	async #transmit(url: URL, init: RequestInit, isRetry: boolean): Promise<Response> {
		const options = { origin: url.origin, policy: this.#config.redirect ?? "same-origin" }
		const response = await fetchFollowing(this.#fetch, url, init, options)
		if (response.status !== 401 || !this.#config.onAuthExpired || isRetry || !isReplayable(init.body)) return response
		const sent = (init.headers as Headers).get(this.#authName)
		const rejected = sent?.startsWith(this.#authPrefix) ? sent.slice(this.#authPrefix.length) : (sent ?? null)
		const token = await this.#refresh(rejected)
		if (token === null) return response
		const headers = new Headers(init.headers)
		headers.set(this.#authName, `${this.#authPrefix}${token}`)
		init.headers = headers
		await discard(response)
		return fetchFollowing(this.#fetch, url, { ...init }, options)
	}

	/** Build, send and post-process one request: hooks, auth refresh, redirects. */
	async #send(call: Call, kind: RequestKind, meta?: RequestMeta, isRetry = false): Promise<Sent> {
		const { method, opts, path } = call
		const { body, headers, url } = await this.#prepare(call, kind, meta)
		const timeout = opts.timeout ?? this.#config.timeout
		const { done, exemptFromTimeout, signal } = requestSignal([opts.signal, this.#disposal], timeout)
		const cleanups: Array<() => void> = [done]
		const finish = () => {
			for (const fn of cleanups.splice(0)) fn()
		}
		const init = requestInit({ body, headers, method, signal }, this.#config)
		const log = exchangeLog(this.#config.onLog, `${method.toUpperCase()} ${path}`)
		try {
			signal?.throwIfAborted()
			let response = await this.#transmit(url, init, isRetry || call.refreshes === false)
			log.answered(response)
			if (this.#config.onResponse) {
				const retry = async () => {
					const again = await this.#send(call, kind, meta, true)
					cleanups.push(again.done)
					return again.response
				}
				const state = this.#config.state ?? {}
				const at = { init, isRetry, meta, method, path, response, retry, state, url }
				response = await runResponseHooks(this.#config.onResponse, at)
			}
			return { done: finish, exemptFromTimeout, failed: (cause) => noAnswer(cause, url, init), response }
		} catch (e) {
			finish()
			log.failed(e)
			throw e
		}
	}

	#iterate(sent: Sent): AsyncIterable<SSEEvent> {
		const caps = { maxEventBytes: this.#config.sseMaxEventBytes, maxLineBytes: this.#config.sseMaxLineBytes }
		return {
			async *[Symbol.asyncIterator]() {
				try {
					if (sent.response.body) yield* parseSSEStream(sent.response.body, { ...caps, failed: sent.failed })
				} finally {
					sent.done()
				}
			},
		}
	}

	#reading(method: string, opts: RequestOptions, shouldThrow: boolean): Reading {
		return { limits: this.#config, method, raw: opts.raw, shouldThrow }
	}

	/** Throw mode: the parsed body, or a ClientError (a per-status subclass) on non-2xx. */
	async request(method: string, path: string, opts: RequestOptions, meta?: RequestMeta): Promise<unknown> {
		return this.requestOperation({ meta, method, opts, path, shouldThrow: true })
	}

	/** Safe mode: `{ data, error, response, status }`; `error` is truthy for every non-2xx. */
	async requestSafe(method: string, path: string, opts: RequestOptions, meta?: RequestMeta): Promise<SafeResult> {
		return this.requestOperation({ meta, method, opts, path, shouldThrow: false }) as Promise<SafeResult>
	}

	/** One REST operation, read as `op` says: thrown or safe, raw, with its declared response headers (A2). */
	async requestOperation(op: Operation): Promise<unknown> {
		const { declared, headers, meta, method, opts, shouldThrow } = op
		let sent: Sent
		try {
			sent = await this.#send(op, "rest", meta)
		} catch (e) {
			/* a request that could not be built (status 0) is a safe-mode result like any other failure */
			if (shouldThrow || !(e instanceof ClientError)) throw e
			return { data: null, error: e, response: e.response, status: e.status }
		}
		return finishRequest(sent, { ...this.#reading(method, opts, shouldThrow), declared, headers })
	}

	/**
	 * One request whose shape is decided by the answer: an event stream becomes an
	 * `AsyncIterable<SSEEvent>` (never buffered, exempt from the timeout once headers arrive);
	 * anything else is read as in `request` / `requestSafe`.
	 */
	async requestAuto(method: string, path: string, opts: RequestOptions, shouldThrow: boolean): Promise<unknown> {
		const sent = await this.#send({ method, opts, path }, "auto")
		if (!sent.response.ok || !isEventStream(sent.response) || opts.raw)
			return finishRequest(sent, this.#reading(method, opts, shouldThrow))
		sent.exemptFromTimeout()
		return this.#iterate(sent)
	}

	requestStream(method: string, path: string, opts: RequestOptions, meta?: RequestMeta): AsyncIterable<SSEEvent> {
		return this.streamOperation({ meta, method, opts, path })
	}

	/** An event stream, sent when iteration starts; `onOpen` runs once the answer is ok. */
	streamOperation(op: Call & { meta?: RequestMeta; onOpen?: (response: Response) => void }): AsyncIterable<SSEEvent> {
		const send = () => this.#send(op, "stream", op.meta)
		const limits = this.#config
		const iterate = (sent: Sent) => this.#iterate(sent)
		return {
			async *[Symbol.asyncIterator]() {
				const sent = await send()
				/* the timeout bounded the open; the stream itself is never cut by it */
				sent.exemptFromTimeout()
				if (!sent.response.ok) {
					try {
						throw await errorFromResponse(sent.response, limits)
					} finally {
						sent.done()
					}
				}
				op.onOpen?.(sent.response)
				yield* iterate(sent)
			},
		}
	}

	buildUrl(path: string, opts: RequestOptions): string {
		return this.#url(path, opts).toString()
	}

	buildPath(path: string, opts: RequestOptions): string {
		const resolved = interpolatePath(path, opts.params)
		const qs = opts.search ? this.#query(opts.search).toString() : ""
		return qs ? `${resolved}?${qs}` : resolved
	}

	buildWSUrl(path: string, opts: RequestOptions): string {
		const url = this.#url(path, opts)
		if (url.protocol === "https:") url.protocol = "wss:"
		else if (url.protocol === "http:") url.protocol = "ws:"
		return url.toString()
	}
}

type Target = { http: HTTPClient; opts: RequestOptions; path: string }

export type RealtimeOptions = Omit<ResumableConnectionOpts, "headers" | "signal" | "transports" | "url">

/** A payload's JSON when it parses, else its text. */
function payloadOf(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return text
	}
}

/** A payload's frame: `last_event_id` or `id` the cursor (a transport's id first), `reconnect_token` the token. */
function frameOf(data: unknown, id?: string): Extract<ServerFrame, { t: "msg" }> {
	const fields = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>
	const cursor = [fields.last_event_id, fields.id].find((v) => typeof v === "string" || typeof v === "number")
	const reconnectToken = typeof fields.reconnect_token === "string" ? fields.reconnect_token : undefined
	return { data, id: id ?? (cursor === undefined ? undefined : String(cursor)), reconnectToken, t: "msg" }
}

const ready = (opts: TransportOpts): ServerFrame => ({ reconnectToken: opts.reconnectToken ?? "", t: "ready" })

/** The cursor in the query: the reconnect token, and the last event id when `withId`. */
function cursorOpts(at: Target, opts: TransportOpts, withId: boolean): RequestOptions {
	const search = { ...at.opts.search }
	if (opts.reconnectToken) search.reconnect_token = opts.reconnectToken
	if (withId && opts.lastEventId) search.last_event_id = opts.lastEventId
	return { ...at.opts, search }
}

function connection(close: () => void, send: (data: string) => Promise<void> | void): TransportConnection {
	return { close, onClose: () => {}, onError: () => {}, onFrame: () => {}, send }
}

/** An HTTP transport: `run` until closed; a send POSTs through the client. */
function httpConnection(at: Target, run: (conn: TransportConnection, signal: AbortSignal) => Promise<void>) {
	const abort = new AbortController()
	const post = (data: string) => {
		const value = payloadOf(data)
		const text = { body: new TextEncoder().encode(data), headers: { ...at.opts.headers, "content-type": "text/plain" } }
		return at.http.request("POST", at.path, { ...at.opts, ...(value === data ? text : { json: value }) }).then(() => {})
	}
	const conn = connection(() => abort.abort(), post)
	run(conn, abort.signal).catch((err: unknown) => abort.signal.aborted || conn.onError(err))
	return conn
}

/** The platform WebSocket: no credential; a failure before open is a refused upgrade. */
function wsAdapter(at: Target): TransportAdapter {
	return {
		connect(_url, opts) {
			const refused = () => new RealtimeConnectError("the WebSocket upgrade failed", "upgrade_refused")
			if (typeof WebSocket === "undefined") {
				const absent = connection(
					() => {},
					() => {},
				)
				queueMicrotask(() => absent.onError(refused()))
				return absent
			}
			const socket = createTypedWebSocket(at.http.buildWSUrl(at.path, cursorOpts(at, opts, true)))
			const conn = connection(
				() => socket.close(),
				(data) => socket.send(data),
			)
			let open = false
			socket.on("open", () => {
				open = true
				conn.onFrame(ready(opts))
			})
			socket.on("message", (text) => conn.onFrame(frameOf(payloadOf(text))))
			socket.on("error", (err) => conn.onError(open ? err : refused()))
			socket.on("close", (code, reason) => (open ? conn.onClose(reason || `${code}`) : conn.onError(refused())))
			return conn
		},
	}
}

/** An event stream through the client, Last-Event-ID the cursor; any other answer fails it. */
function sseAdapter(at: Target): TransportAdapter {
	return {
		connect: (_url, opts) =>
			httpConnection(at, async (conn, signal) => {
				let stream = false
				const events = at.http.streamOperation({
					method: "GET",
					onOpen: (response) => {
						stream = isEventStream(response)
						if (stream) conn.onFrame(ready(opts))
					},
					opts: { ...cursorOpts(at, opts, false), lastEventId: opts.lastEventId, signal },
					path: at.path,
					refreshes: false,
				})
				for await (const event of events)
					if (stream) conn.onFrame(frameOf(payloadOf(event.data), event.id || undefined))
				if (stream) conn.onClose("end")
				else conn.onError(new RealtimeConnectError("the answer is no event stream", "not_event_stream"))
			}),
	}
}

/** GETs through the client, the cursor in the query; a 204 polls again. */
function pollAdapter(at: Target): TransportAdapter {
	return {
		connect: (_url, opts) =>
			httpConnection(at, async (conn, signal) => {
				const cursor = { ...opts }
				for (let polls = 0; !signal.aborted; polls++) {
					const poll = { ...cursorOpts(at, cursor, true), signal }
					const data = await at.http.requestOperation({
						method: "GET",
						opts: poll,
						path: at.path,
						refreshes: false,
						shouldThrow: true,
					})
					if (polls === 0) conn.onFrame(ready(opts))
					if (data === null || data === undefined || data === "") continue
					const frame = frameOf(data)
					cursor.lastEventId = frame.id ?? cursor.lastEventId
					cursor.reconnectToken = frame.reconnectToken || cursor.reconnectToken
					conn.onFrame(frame)
				}
			}),
	}
}

/** An x-realtime op's chain, as Go's: WebSocket, SSE, long-poll; no JSON keepalive unless set. */
export function realtimeConnection(http: HTTPClient, path: string, input: RequestOptions & RealtimeOptions) {
	const { baseURL, cookies, headers, params, search, signal, ...opts } = input
	const at = { http, opts: { baseURL, cookies, headers, params, search }, path }
	const transports = [wsAdapter(at), sseAdapter(at), pollAdapter(at)]
	return new Resumable({ keepaliveInterval: 0, ...opts, signal, transports, url: path }, () => http[REFRESH_AUTH]())
}

/**
 * Resolve invalidation targets by substituting the mutation's params. Params that are absent stay
 * placeholders, so a partially resolved target is a narrower pattern, never dropped: `PUT
 * /orgs/{org}` invalidating `GET /orgs/:org/members/:id` marks `GET /orgs/acme/members/:id`.
 */
export function resolveInvalidationTargets(
	targets: readonly string[],
	params: Record<string, string> | undefined,
): string[] {
	return targets.map((target) => {
		const space = target.indexOf(" ")
		if (space === -1 || !params) return target
		try {
			return `${target.slice(0, space)} ${interpolatePartial(target.slice(space + 1), params)}`
		} catch {
			/* a param value that is not a path segment cannot address a resource; keep the pattern */
			return target
		}
	})
}

/* Bound memory: which concrete paths have already refreshed against a pattern-level mark, and the
   compiled patterns, are capped; the marks and their sources are capped by `StaleLimits`. */
const MAX_REFRESHED = 1024
const MAX_PATTERNS = 1024

type StaleEntry = {
	by: Set<string>
	/** concrete paths that have read once since this pattern was marked (pattern entries only) */
	refreshed?: Set<string>
	seq: number
	until: number
}

/** Drop the oldest value of an insertion-ordered set once it holds `max`. */
function capped<T>(set: Set<T>, max: number): void {
	if (set.size < max) return
	const oldest = set.values().next().value
	if (oldest !== undefined) set.delete(oldest)
}

/** How many exact marks the index keeps, and how many mutations each mark remembers. */
export type StaleLimits = { maxEntries: number; maxSources: number }

/**
 * Stale marks, split by kind so a concrete key is never re-read as a pattern (a path may contain
 * `:`), and a lookup scans only patterns for its own method.
 */
export class StaleIndex {
	readonly exact = new Map<string, StaleEntry>()
	readonly patterns = new Map<string, Map<string, StaleEntry>>()
	readonly #compiled = new Map<string, RegExp>()
	readonly #limits: StaleLimits

	constructor(limits: StaleLimits) {
		this.#limits = limits
	}

	/** Whether `path` matches the route pattern `pattern` (`:name`, `{name}`, `*`), literal text escaped. */
	matches(path: string, pattern: string): boolean {
		let re = this.#compiled.get(pattern)
		if (re === undefined) {
			if (this.#compiled.size >= MAX_PATTERNS) this.#compiled.delete(this.#compiled.keys().next().value as string)
			re = compilePattern(pattern)
			this.#compiled.set(pattern, re)
		}
		return re.test(path)
	}

	/** Mark `target` stale on behalf of `mutation`, until `at.until`. */
	mark(target: string, mutation: string, at: { now: number; seq: number; until: number }): void {
		const { seq, until } = at
		const space = target.indexOf(" ")
		const method = target.slice(0, space)
		const isPattern = hasPlaceholder(target.slice(space + 1))
		let table = this.exact
		if (isPattern) {
			table = this.patterns.get(method) ?? new Map()
			this.patterns.set(method, table)
		}
		const existing = table.get(target)
		if (!existing) {
			table.set(target, { by: new Set([mutation]), refreshed: isPattern ? new Set() : undefined, seq, until })
			if (!isPattern) this.#bound(at.now)
			return
		}
		existing.by.delete(mutation)
		capped(existing.by, this.#limits.maxSources)
		existing.by.add(mutation)
		existing.until = until
		existing.seq = seq
		/* a new mutation re-marks every instance */
		existing.refreshed?.clear()
	}

	/** Past `maxEntries` exact marks, drop the expired ones, then the oldest live ones. */
	#bound(now: number): void {
		const { maxEntries } = this.#limits
		if (this.exact.size <= maxEntries) return
		for (const [key, entry] of this.exact) if (entry.until <= now) this.exact.delete(key)
		for (const key of this.exact.keys()) {
			if (this.exact.size <= maxEntries) return
			this.exact.delete(key)
		}
	}

	lookup(selector: string, path: string, method: string, now: number): { by: string[]; isStale: boolean } {
		const by = new Set<string>()
		const exact = this.exact.get(selector)
		if (exact && exact.until > now) for (const m of exact.by) by.add(m)
		else if (exact) this.exact.delete(selector)
		for (const [key, entry] of this.patterns.get(method) ?? []) {
			if (entry.until <= now) this.patterns.get(method)?.delete(key)
			else if (!entry.refreshed?.has(path) && this.matches(path, key.slice(key.indexOf(" ") + 1))) {
				for (const m of entry.by) by.add(m)
			}
		}
		return { by: [...by], isStale: by.size > 0 }
	}

	/**
	 * A successful stale read clears the mark for that resource only: the exact entry, and this
	 * concrete path's share of any pattern entry. Marks newer than the read's snapshot stay.
	 */
	clear(selector: string, path: string, method: string, snapshot: number): void {
		const exact = this.exact.get(selector)
		if (exact && exact.seq <= snapshot) this.exact.delete(selector)
		for (const [key, entry] of this.patterns.get(method) ?? []) {
			if (entry.seq > snapshot || !entry.refreshed) continue
			if (!this.matches(path, key.slice(key.indexOf(" ") + 1))) continue
			capped(entry.refreshed, MAX_REFRESHED)
			entry.refreshed.add(path)
		}
	}
}

/**
 * The app-typed client's types. They read the app's `$routes` phantom structurally, so the
 * emitted client imports nothing from honey (D3): `InferRoutes`, the path params and a schema's
 * output type are spelled here as honey spells them.
 */

/** An app's routes: the `$routes` phantom its type carries. */
export type InferRoutes<T> = T extends { readonly $routes: infer R } ? R : never

/** One problem with one input field, as the error envelope lists it. */
export type FieldError = { error_key: string; message: string; path: string }

/** The type a Standard schema produces once it validated a value. */
type SchemaOutput<T> = T extends { readonly "~standard": { readonly types?: infer TTypes } }
	? NonNullable<TTypes> extends { readonly output: infer O }
		? O
		: unknown
	: unknown

type ParamKey<T extends string> = T extends `${infer Name}?` ? Name : T

/** A route pattern's param names: `:name` (optional or not), a named wildcard, an unnamed one as `*`. */
type ParamKeys<Path extends string> = Path extends `${string}:${infer Param}/${infer Rest}`
	? ParamKey<Param> | ParamKeys<`/${Rest}`>
	: Path extends `${string}:${infer Param}`
		? ParamKey<Param>
		: Path extends `${string}*${infer Name}`
			? Name extends ""
				? "*"
				: Name
			: never

/** Paths that register `M`. */
export type PathsForMethod<TRoutes, M extends string> = {
	[P in keyof TRoutes & string]: M extends keyof TRoutes[P] ? P : never
}[keyof TRoutes & string]

/** One route's record, when the app has it. */
type RouteOf<TRoutes, P extends string, M extends string> = P extends keyof TRoutes
	? M extends keyof TRoutes[P]
		? TRoutes[P][M]
		: never
	: never

/** What a call sends: the route's `request` (each source's schema input, `readableStream()` unwrapped). */
export type InputFor<TRoutes, P extends string, M extends string> =
	RouteOf<TRoutes, P, M> extends { request: infer I } ? ([I] extends [never] ? {} : I) : {}

export type OutputDefFor<TRoutes, P extends string, M extends string> =
	RouteOf<TRoutes, P, M> extends { output: infer O } ? O : never

/** Statuses whose answer never carries a body (204, 205, 304): the client reads each as null. */
type NullBodyStatus = "no_content" | "not_modified" | "reset_content"

/** The statuses a declaration names under each key (a media type, `headers`, `redirect`). */
type StatusesOf<O> = { [K in keyof O]: keyof NonNullable<O[K]> }[keyof O]

/** Media type `CT`'s statuses that carry a body. */
type BodyStatuses<O, CT extends string> = CT extends keyof O ? Exclude<keyof O[CT], NullBodyStatus> : never

/** Whether media type `CT` declares a status that carries a body. */
type Answers<O, CT extends string> = [BodyStatuses<O, CT>] extends [never] ? false : true

/**
 * A body's value: JSON by its schemas, text types as text, octet-stream as bytes (A1); `unknown`
 * when a status carries a body no media type here types; `never` when none carries one.
 */
type BodyValue<O> =
	Answers<O, "application/json"> extends true
		? O extends { "application/json": infer JsonMap }
			? SchemaOutput<JsonMap[BodyStatuses<O, "application/json"> & keyof JsonMap]>
			: never
		: true extends
					| Answers<O, "text/plain">
					| Answers<O, "text/html">
					| Answers<O, "text/csv">
					| Answers<O, "application/xml">
			? string
			: Answers<O, "application/octet-stream"> extends true
				? Uint8Array<ArrayBuffer>
				: [Exclude<StatusesOf<O>, NullBodyStatus>] extends [never]
					? never
					: unknown

/** What a declaration answers with: its body's value, `null` for each declared no-content status. */
type DeclaredValue<O> = BodyValue<O> | ([Extract<StatusesOf<O>, NullBodyStatus>] extends [never] ? never : null)

/**
 * The value a route answers with, `unknown` when it declares no status: undeclared is not empty,
 * the handler's body comes back.
 */
export type OutputFor<TRoutes, P extends string, M extends string> =
	OutputDefFor<TRoutes, P, M> extends infer O
		? [O] extends [never]
			? unknown
			: [DeclaredValue<O>] extends [never]
				? unknown
				: DeclaredValue<O>
		: unknown

/** Whether a route answers an event stream. */
export type IsSSE<TRoutes, P extends string, M extends string> =
	OutputDefFor<TRoutes, P, M> extends infer O ? (O extends { "text/event-stream": unknown } ? true : false) : false

type ErrorsByStatusFor<TRoutes, P extends string, M extends string> =
	RouteOf<TRoutes, P, M> extends { errorsByStatus: infer S } ? S : never

/** honey's error envelope, as a route without a schema of its own answers an error. */
export type ErrorEnvelope<TStatus extends number = number, TKey extends string = string> = {
	error_key: TKey
	fields: Record<string, FieldError[]>
	message: string
	status: TStatus
	status_key: string
	success: false
}

/** `null` in a route's errorsByStatus means the default envelope, not a null body. */
type ResolveErrorBody<S extends number, T> = T extends null ? ErrorEnvelope<S> : T

/** Object keys of `{ 400: ... }` are `400` or `"400"` depending on the TS version. */
type StatusCode<K> = K extends number ? K : K extends `${infer N extends number}` ? N : never

type HasStatusErrors<T> = [StatusCode<keyof T>] extends [never] ? false : true

type ErrorVariants<TErrorsByStatus> = {
	[K in keyof TErrorsByStatus]: StatusCode<K> extends never
		? never
		: {
				data: null
				error: ResolveErrorBody<StatusCode<K>, TErrorsByStatus[K]>
				response: Response
				status: StatusCode<K>
			}
}[keyof TErrorsByStatus]

/**
 * A safe-mode result: `error` is the parsed body, not a ClientError. When the errors are known by
 * status, the typed branch covers every declared status, so `if (error)` / `if (!error)` narrow.
 */
export type ClientResult<TData, TErrorsByStatus = never> =
	| { data: TData; error: null; response: Response; status: number }
	| (HasStatusErrors<TErrorsByStatus> extends false
			? { data: null; error: unknown; response: Response; status: number }
			: ErrorVariants<TErrorsByStatus>)

/** What a call resolves to, by transport and throw mode. */
export type ReturnFor<TRoutes, P extends string, M extends string, TThrow extends boolean = true> =
	IsSSE<TRoutes, P, M> extends true
		? AsyncIterable<SSEEvent>
		: TThrow extends true
			? Promise<OutputFor<TRoutes, P, M>>
			: Promise<ClientResult<OutputFor<TRoutes, P, M>, ErrorsByStatusFor<TRoutes, P, M>>>

/** A path's params, required whenever the pattern names one. */
type ParamsInput<P extends string> = [ParamKeys<P>] extends [never] ? {} : { params: { [K in ParamKeys<P>]: string } }

/** The call input: the route's declared input with the path's params. */
export type ClientInput<TRoutes, P extends string, M extends string> = InputFor<TRoutes, P, M> & ParamsInput<P>

export type ErrorsFor<TRoutes, P extends string, M extends string> =
	RouteOf<TRoutes, P, M> extends { errors: infer E extends string } ? E : never

type RequiresAllOptional<T> = {
	[K in keyof T]-?: undefined extends T[K] ? true : false
}[keyof T] extends true
	? true
	: Partial<T> extends T
		? true
		: false

/** The input is optional when it is empty or every key is optional. */
type OptionalInput<T> = keyof T extends never
	? [input?: T]
	: [RequiresAllOptional<T>] extends [true]
		? [input?: T]
		: [input: T]

type Method<TRoutes, TThrow extends boolean, M extends string> = <P extends PathsForMethod<TRoutes, M>>(
	path: P,
	...input: OptionalInput<ClientInput<TRoutes, P, M>>
) => ReturnFor<TRoutes, P, M, TThrow>

type PathHelper<TRoutes> = <P extends keyof TRoutes & string>(
	path: P,
	input?: { params?: Record<string, string>; search?: Record<string, unknown> },
) => string

/** The typed client: `TThrow` decides whether calls resolve to values or results. */
export type HoneyClient<TRoutes, TThrow extends boolean = false> = {
	$isClientError: (e: unknown) => e is ClientError
	$path: PathHelper<TRoutes>
	$url: PathHelper<TRoutes>
	delete: Method<TRoutes, TThrow, "delete">
	get: Method<TRoutes, TThrow, "get">
	patch: Method<TRoutes, TThrow, "patch">
	post: Method<TRoutes, TThrow, "post">
	put: Method<TRoutes, TThrow, "put">
	ws(
		path: string,
		input?: {
			params?: Record<string, string>
			protocols?: string | string[]
			reconnectToken?: string
			search?: Record<string, unknown>
		},
	): TypedWebSocket
}

const HTTP_METHODS: readonly string[] = ["delete", "get", "patch", "post", "put"]

/** What a path-addressed helper (`$url`, `$path`, `ws`) reads of its input. */
type PathInput = {
	params?: Record<string, string>
	protocols?: string | string[]
	reconnectToken?: string
	search?: Record<string, unknown>
}

function isAsyncIterable(value: unknown): value is AsyncIterable<SSEEvent> {
	return typeof value === "object" && value !== null && Symbol.asyncIterator in value
}

/**
 * One call, one request, consumed either way:
 * - `await api.get(...)` sends it; an event-stream response resolves to an
 *   `AsyncIterable<SSEEvent>` (never buffered), anything else to the parsed body or result.
 * - `for await (... of api.get(...))` before the call has started sends it as a stream request
 *   (`accept: text/event-stream`, no timeout).
 * - iterating after awaiting reuses the same response instead of sending again.
 */
function lazyCall(
	http: HTTPClient,
	call: { method: string; opts: RequestOptions; path: string; shouldThrow: boolean },
) {
	const { method, opts, path, shouldThrow } = call
	let mode: "auto" | "idle" | "sse" = "idle"
	let auto: Promise<unknown> | undefined
	const runAuto = (): Promise<unknown> => {
		auto ??= http.requestAuto(method, path, opts, shouldThrow)
		return auto
	}
	const lazy = new Promise((resolve, reject) => {
		queueMicrotask(() => {
			if (mode === "sse") return
			mode = "auto"
			runAuto().then(resolve, reject)
		})
	})
	Object.defineProperty(lazy, Symbol.asyncIterator, {
		value() {
			if (mode === "idle") {
				mode = "sse"
				return http.requestStream(method, path, opts)[Symbol.asyncIterator]()
			}
			return (async function* () {
				const result = await runAuto()
				if (isAsyncIterable(result)) {
					yield* result
					return
				}
				const error = (result as { error?: unknown } | null)?.error
				if (error) throw error instanceof Error ? error : new Error("Request failed")
				throw new TypeError(`${method} ${path} did not respond with an event stream`)
			})()
		},
	})
	return lazy
}

/** The helpers that sit beside the methods: `$isClientError`, `$url`, `$path` and `ws`. */
function helper(http: HTTPClient, prop: string): unknown {
	if (prop === "$isClientError") return isClientError
	if (prop === "$url") return (path: string, input?: PathInput) => http.buildUrl(path, input ?? {})
	if (prop === "$path") return (path: string, input?: PathInput) => http.buildPath(path, input ?? {})
	if (prop !== "ws") return undefined
	return (path: string, input?: PathInput): TypedWebSocket => {
		let url = http.buildWSUrl(path, { params: input?.params, search: input?.search })
		if (input?.reconnectToken)
			url += `${url.includes("?") ? "&" : "?"}reconnect_token=${encodeURIComponent(input.reconnectToken)}`
		return createTypedWebSocket(url, { protocols: input?.protocols })
	}
}

export function createClient<T>(config: ClientConfig & { throwOnError: true }): HoneyClient<InferRoutes<T>, true>
export function createClient<T>(
	config: Omit<ClientConfig, "throwOnError"> & { throwOnError?: false },
): HoneyClient<InferRoutes<T>, false>
export function createClient<T, TThrow extends boolean>(
	config: ClientConfig & { throwOnError?: TThrow },
): HoneyClient<InferRoutes<T>, TThrow>
export function createClient<T, TThrow extends boolean = false>(
	config: ClientConfig & { throwOnError?: TThrow },
): HoneyClient<InferRoutes<T>, TThrow> {
	const http = new HTTPClient(config)
	return new Proxy({} as HoneyClient<InferRoutes<T>, TThrow>, {
		get(_target, prop: string | symbol) {
			/* not a thenable, and printable: `await client` and `String(client)` must not hit the method table */
			if (prop === Symbol.toStringTag) return "HoneyClient"
			if (typeof prop === "symbol" || prop === "then") return undefined
			if (prop === "toString" || prop === "toJSON") return () => "[object HoneyClient]"
			if (!HTTP_METHODS.includes(prop)) return helper(http, prop)
			const shouldThrow = config.throwOnError === true
			return (path: string, input?: RequestOptions) =>
				lazyCall(http, { method: prop.toUpperCase(), opts: input ?? {}, path, shouldThrow })
		},
	})
}

/** One operation as the service map holds it: where it goes and how its answer is read. */
export type ServiceEntry = {
	/** the declared non-JSON media type, sent as `Accept` */
	accept?: string
	/** the operation declares no success body: a 2xx answer is null, its body reached only through `raw` */
	empty?: boolean
	/** the declared response headers, lower case (A2) */
	headers?: readonly string[]
	idempotent?: boolean
	invalidate?: readonly string[]
	method: string
	params?: readonly string[]
	/** the OpenAPI path template, `{param}` kept */
	path: string
	realtime?: boolean
	/** an event stream; `"json"` when its events carry JSON `data` the client parses */
	sse?: boolean | "json"
	/** the param that spans segments (`x-honey-wildcard`) */
	wildcard?: string
	ws?: boolean
}

export type ServiceMapNode = ServiceEntry | { readonly [key: string]: ServiceMapNode }

export type ServiceMap = { readonly [key: string]: ServiceMapNode }

/** Read-after-write tracking: a mutation's `x-invalidate` targets read as stale for `staleTime` ms. */
export type InvalidationConfig = {
	/** how many mutations a stale mark remembers in `invalidatedBy`. Default 16. */
	maxSourcesPerTarget?: number
	/** how many exact stale marks are kept; past it expired, then the oldest, marks go. Default 1000. */
	staleMaxEntries?: number
	staleTime: number
}

export type SDKConfig = ClientConfig & { invalidation?: InvalidationConfig }

/** What a call takes beyond `RequestOptions`: a WebSocket's protocols and resume token. */
type CallInput = RequestOptions & RealtimeOptions & { protocols?: string | string[] }

type OperationFn = (input?: CallInput) => unknown

const isEntry = (node: unknown): node is ServiceEntry =>
	typeof node === "object" &&
	node !== null &&
	Object.hasOwn(node, "method") &&
	typeof (node as ServiceEntry).method === "string"

/** Only the map's own keys are operations: never `toString`, `constructor` or `then`. */
const childOf = (node: ServiceMapNode, key: string): ServiceMapNode | undefined =>
	Object.hasOwn(node, key) ? (node as Record<string, ServiceMapNode>)[key] : undefined

/** The template the runtime interpolates: a wildcard param's `{name}` becomes the rest-of-path `*name`. */
function templateOf(entry: ServiceEntry): string {
	return entry.wildcard === undefined ? entry.path : entry.path.replace(`{${entry.wildcard}}`, `*${entry.wildcard}`)
}

/** A call whose path params cannot form a path, as a status-0 ClientError: no request was sent. */
function pathError(e: PathParamError, entry: ServiceEntry): ClientError {
	return new ClientError({
		body: null,
		message: `${e.message} for ${entry.method} ${entry.path}`,
		response: Response.error(),
		status: 0,
	})
}

/** The per-call options an entry adds: its `Accept` and an `Idempotency-Key`. */
function optionsFor(entry: ServiceEntry, input: CallInput): RequestOptions {
	const headers: Record<string, string | undefined> = {}
	if (entry.accept) headers.accept = entry.accept
	Object.assign(headers, input.headers)
	if (entry.idempotent && !Object.keys(headers).some((k) => k.toLowerCase() === "idempotency-key"))
		headers["Idempotency-Key"] = input.idempotencyKey ?? newClientRequestId()
	return { ...input, headers }
}

/** Each event with its `data` parsed as JSON; an event that does not parse fails the stream, naming it. */
function jsonEvents(events: AsyncIterable<SSEEvent>): AsyncIterable<SSEEvent<unknown>> {
	return {
		async *[Symbol.asyncIterator]() {
			for await (const event of events) {
				let data: unknown
				try {
					data = JSON.parse(event.data)
				} catch (e) {
					const name = event.id === undefined ? "an event" : `event ${JSON.stringify(event.id)}`
					const message = `SSE ${name} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`
					throw new ClientError({ body: event.data, message, response: Response.error(), status: 0 })
				}
				yield { ...event, data }
			}
		},
	}
}

/** The client behind a generated SDK class: operations from the service map, read-after-write tracking, dispose. */
class SdkCore {
	readonly http: HTTPClient
	readonly #config: SDKConfig
	readonly #disposal = new AbortController()
	#stale: StaleIndex | null
	#seq = 0

	constructor(config: SDKConfig) {
		this.#config = config
		this.http = new HTTPClient(config, this.#disposal.signal)
		this.#stale = this.#newIndex()
	}

	#newIndex(): StaleIndex | null {
		const invalidation = this.#config.invalidation
		if (!invalidation || invalidation.staleTime <= 0) return null
		const maxSources = Math.max(invalidation.maxSourcesPerTarget ?? 16, 1)
		return new StaleIndex({ maxEntries: invalidation.staleMaxEntries ?? 1000, maxSources })
	}

	dispose(): void {
		this.#disposal.abort(new Error("The client was disposed"))
		this.#stale = this.#newIndex()
	}

	/** The stale view of the read `selector` before it is sent. */
	#meta(selector: string, path: string, method: string): RequestMeta | undefined {
		if (!this.#stale) return undefined
		const { by, isStale } = this.#stale.lookup(selector, path, method, Date.now())
		return { invalidatedBy: by, isStale, selector, seqSnapshot: this.#seq }
	}

	/** Mark what a successful mutation `selector` invalidates. */
	#mark(entry: ServiceEntry, params: Record<string, string> | undefined, selector: string): void {
		if (!this.#stale || !entry.invalidate?.length) return
		const now = Date.now()
		const at = { now, seq: ++this.#seq, until: now + (this.#config.invalidation?.staleTime ?? 0) }
		for (const target of resolveInvalidationTargets(entry.invalidate, params)) this.#stale.mark(target, selector, at)
	}

	async request(entry: ServiceEntry, input: CallInput): Promise<unknown> {
		const shouldThrow = this.#config.throwOnError === true
		const template = templateOf(entry)
		let path: string
		try {
			path = interpolatePath(template, input.params)
		} catch (e) {
			if (!(e instanceof PathParamError)) throw e
			const error = pathError(e, entry)
			if (shouldThrow) throw error
			return { data: null, error, response: error.response, status: 0 }
		}
		const selector = `${entry.method} ${path}`
		const meta = this.#meta(selector, path, entry.method)
		const opts = optionsFor(entry, input)
		const declared = entry.empty ? null : entry.accept
		const op = { declared, headers: entry.headers, meta, method: entry.method, opts, path: template, shouldThrow }
		const result = await this.http.requestOperation(op)
		const status = result instanceof Response ? result.status : (result as { status?: number } | null)?.status
		if (shouldThrow || (status !== undefined && status >= 200 && status < 300)) {
			this.#mark(entry, input.params, selector)
			if (meta?.isStale) this.#stale?.clear(selector, path, entry.method, meta.seqSnapshot)
		}
		return result
	}

	/** An SSE op: its stale view for the hooks, and its `x-invalidate` targets marked once the answer is ok. */
	stream(entry: ServiceEntry, input: CallInput): AsyncIterable<unknown> {
		const opts = optionsFor(entry, input)
		const template = templateOf(entry)
		let selector: string | undefined
		let meta: RequestMeta | undefined
		try {
			const path = interpolatePath(template, input.params)
			selector = `${entry.method} ${path}`
			meta = this.#meta(selector, path, entry.method)
		} catch {
			/* a bad param fails the stream when it is sent, as for any call */
		}
		const onOpen = () => {
			if (selector !== undefined) this.#mark(entry, input.params, selector)
		}
		const events = this.http.streamOperation({ meta, method: entry.method, onOpen, opts, path: template })
		return entry.sse === "json" ? jsonEvents(events) : events
	}

	/** An x-realtime op: one resumable connection, dialed through the client. */
	realtime(entry: ServiceEntry, input: CallInput): ResumableConnection {
		return realtimeConnection(this.http, templateOf(entry), input)
	}

	connect(entry: ServiceEntry, input: CallInput): TypedWebSocket {
		const url = new URL(this.http.buildWSUrl(templateOf(entry), { params: input.params, search: input.search }))
		if (input.reconnectToken) url.searchParams.append("reconnect_token", input.reconnectToken)
		const socket = createTypedWebSocket(url.toString(), { protocols: input.protocols })
		if (entry.invalidate?.length) {
			const selector = `WS ${interpolatePath(templateOf(entry), input.params)}`
			socket.on("open", () => this.#mark(entry, input.params, selector))
		}
		return socket
	}
}

/** The function an entry is called through, named by its dotted member path for stack traces. */
function callable(core: SdkCore, entry: ServiceEntry, name: string): OperationFn {
	let fn: OperationFn
	/* a realtime op is one resumable connection; any other dispatches by its transport */
	if (entry.realtime) fn = (input) => core.realtime(entry, input ?? {})
	else if (entry.ws) fn = (input) => core.connect(entry, input ?? {})
	else if (entry.sse) fn = (input) => core.stream(entry, input ?? {})
	else fn = (input) => core.request(entry, input ?? {})
	Object.defineProperty(fn, "name", { value: name })
	return fn
}

/** A namespace of the map: each read of a key returns the same function or namespace object. */
function namespace(core: SdkCore, node: ServiceMapNode, path: readonly string[]): object {
	const members = new Map<string, unknown>()
	return new Proxy({} as Record<string, unknown>, {
		get(target, key: string | symbol) {
			if (typeof key === "symbol") return Reflect.get(target, key)
			const child = childOf(node, key)
			if (child === undefined) return Reflect.get(target, key)
			return memberOf(core, members, { child, path: [...path, key] })
		},
	})
}

/** A member, once: a callable for an entry, a namespace object otherwise. */
function memberOf(core: SdkCore, members: Map<string, unknown>, at: { child: ServiceMapNode; path: string[] }) {
	const key = at.path.join(".")
	let member = members.get(key)
	if (member === undefined) {
		member = isEntry(at.child) ? callable(core, at.child, key) : namespace(core, at.child, at.path)
		members.set(key, member)
	}
	return member
}

/** `config` with the API's auth scheme as its header pair's default. */
export function schemeAuth<T extends ClientConfig>(config: T, headerName: string, prefix: string): T {
	if (config.authHeaderName !== undefined) return config
	return { ...config, authHeaderName: headerName, authHeaderPrefix: config.authHeaderPrefix ?? prefix }
}

/**
 * A generated SDK's base class. The instance is a Proxy over the service map: `sdk.users.create(input)`
 * dispatches the entry at `users.create`; the client's own members (`state`, `dispose`, `toString`)
 * always win, and a key the map does not hold reads as `undefined`.
 */
export class SDKClient {
	state: Record<string, unknown>
	readonly #core: SdkCore

	constructor(serviceMap: ServiceMap, config: SDKConfig) {
		this.state = config.state ?? {}
		this.#core = new SdkCore({ ...config, state: this.state })
		const core = this.#core
		const members = new Map<string, unknown>()
		return new Proxy(this, {
			get(target, key: string | symbol) {
				if (typeof key === "symbol" || key in target) {
					const value: unknown = Reflect.get(target, key)
					return typeof value === "function" ? value.bind(target) : value
				}
				const child = childOf(serviceMap, key)
				return child === undefined ? undefined : memberOf(core, members, { child, path: [key] })
			},
		})
	}

	/** Printable: `String(sdk)` is `[object <SdkName>]`. */
	get [Symbol.toStringTag](): string {
		return this.constructor.name
	}

	/** Abort every call in flight, refuse later ones, and drop the stale marks. */
	dispose(): void {
		this.#core.dispose()
	}
}
