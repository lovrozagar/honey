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
	cause?: unknown
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
		super(init.message, init)
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

/** A 2xx whose body is no value of its operation: the text (null past the size cap), the parse error its cause. */
export class DecodeError extends ClientError<string | null> {
	/* a literal, so a declared error with a string body never reads as one */
	override readonly name = "DecodeError"
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
	baseURL?: string | undefined
	/** raw bytes sent as they are, `application/octet-stream` unless a content type is set */
	body?: ArrayBuffer | Blob | ReadableStream<Uint8Array> | Uint8Array | undefined
	cookies?: Record<string, string> | undefined
	form?: Record<string, unknown> | undefined
	headers?: Record<string, string | undefined> | undefined
	/** the `Idempotency-Key` an idempotent operation sends; a fresh one per call otherwise */
	idempotencyKey?: string | undefined
	json?: unknown
	lastEventId?: string | undefined
	params?: Record<string, string> | undefined
	/** resolve the unread `Response` instead of its parsed body (C2); throw mode still throws on non-2xx */
	raw?: boolean | undefined
	search?: Record<string, unknown> | undefined
	signal?: AbortSignal | undefined
	/** Per-call timeout in milliseconds; overrides `config.timeout`, `0` disables it. */
	timeout?: number | undefined
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
	const init: RequestInit = { headers: at.headers, method: at.method }
	if (at.body !== undefined) init.body = at.body
	if (at.signal !== undefined) init.signal = at.signal
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

/** A REST call's answer: its value (the response itself when raw) and the response. */
export type Answer = { data: unknown; response: Response }

/** Object keys of `{ 400: ... }` are `400` or `"400"` depending on the TS version. */
export type StatusOf<K> = K extends number ? K : K extends `${infer N extends number}` ? N : never

/** 0 to N-1 as literals. */
type Upto<N extends number, A extends number[] = []> = A["length"] extends N ? A[number] : Upto<N, [...A, A["length"]]>

/** Each declared status's error, its body typed; the base ClientError at every other error status, 300 to 599. */
type StatusErrors<E> = [E] extends [never]
	? ClientError
	: [keyof E] extends [never]
		? ClientError
		:
				| { [K in keyof E]: ClientError<E[K]> & { readonly status: StatusOf<K> } }[keyof E]
				| (ClientError & { readonly status: Exclude<Exclude<Upto<600>, Upto<300>>, StatusOf<keyof E>> })

/** A safe call's outcome: its data (and declared headers), or the answer's error; the response on both. */
export type Result<T, TErrors = never, THeaders = never> =
	| ([THeaders] extends [never]
			? { ok: true; data: T; response: Response }
			: { ok: true; data: T; headers: THeaders; response: Response })
	| { ok: false; error: StatusErrors<TErrors> | DecodeError; response: Response }

/** How a REST answer is read: parsed or raw, by its declared media type, within the client's limits. */
export type Reading = {
	/**
	 * the non-JSON media type the operation declares: its body is read as that type, empty or not.
	 * `null` when it declares no success body: whatever arrives is discarded and reads as null.
	 */
	declared?: string | null | undefined
	/** the client's limits: an error message's characters, and the bytes a body may hold decoded */
	limits?: Limits | undefined
	method: string
	raw?: boolean | undefined
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
export const MAX_RESPONSE_BYTES: number = 100 * 1024 * 1024

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
			throw new DecodeError({ body: null, message, response, status: response.status })
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
			? (body as Record<string, unknown>)["message"]
			: undefined
	const text =
		typeof message === "string" && message.length > 0
			? `HTTP ${response.status}: ${sanitizeMessage(message, limits.maxErrorMessageChars ?? 512)}`
			: `HTTP ${response.status}`
	return clientErrorFor({ body, message: text, response: preserved, status: response.status })
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
		} catch (cause) {
			const message = "Response body is not valid JSON"
			throw new DecodeError({ body: text, cause, message, response, status: response.status })
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

/**
 * A REST answer read into its value, or the response itself when raw. A non-2xx throws its ClientError, an
 * undecodable 2xx DecodeError, and a body read that fails no answer (f2).
 */
export async function finishRequest(sent: Sent, reading: Reading): Promise<Answer> {
	const { response } = sent
	try {
		if (!response.ok) throw await errorFromResponse(response, reading.limits)
		if (reading.raw) return { data: response, response }
		const max = reading.limits?.maxResponseBytes
		return { data: await parseBody(response, reading.method, reading.declared, max), response }
	} catch (e) {
		throw e instanceof ClientError ? e : sent.failed(e)
	} finally {
		sent.done()
	}
}

/** `answer` as a safe call's Result (bit 21 i): an answer's error its Err; no answer, or none sent, thrown (f2). */
export async function resultOf(answer: Promise<Answer>, names?: readonly string[]): Promise<Result<unknown>> {
	try {
		const { data, response } = await answer
		const ok: Result<unknown> = { data, ok: true, response }
		return names ? Object.assign(ok, { headers: declaredHeaders(response, names) }) : ok
	} catch (e) {
		if (e instanceof ClientError && e.status !== 0) return { error: e, ok: false, response: e.response }
		throw e
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
	body?: BodyInit | undefined
	headers: Headers
	invalidatedBy?: string[] | undefined
	isStale?: boolean | undefined
	method: string
	/** the operation's path template, as the document spells it (`/items/{id}`), never the filled-in URL */
	path: string
	selector?: string | undefined
	state: Record<string, unknown>
	url: string
}

export type OnResponseContext = {
	invalidatedBy?: string[]
	isRetry: boolean
	isStale?: boolean
	method: string
	/** the operation's path template, as the document spells it (`/items/{id}`), never the filled-in URL */
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

/**
 * One `onLog` entry: what happened to which operation and how long it took. `operation` is `METHOD` and the
 * path template, the same spelling a hook's `ctx.path` carries (`GET /items/{id}`).
 */
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
			delete next.body
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

/**
 * `init` as a `Request` can take it: a body that cannot be sent twice is left out, never set to
 * `undefined`, which `RequestInit` does not declare.
 */
function replayable(init: RequestInit): RequestInit {
	if (isReplayable(init.body)) return init
	const { body: _body, ...rest } = init
	return rest
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
			request ??= new Request(at.url.toString(), replayable(init))
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

/** The complete lines at the head of `pending` (CRLF, LF or CR), and what is left after them. */
function completeLines(pending: string): { lines: string[]; rest: string } {
	const lines: string[] = []
	let start = 0
	let end = 0
	while (start < pending.length) {
		end = start
		while (end < pending.length && pending.charCodeAt(end) !== 10 && pending.charCodeAt(end) !== 13) end++
		if (end === pending.length) break
		/* a CR as the last character may be the first half of CRLF */
		if (pending.charCodeAt(end) === 13 && end === pending.length - 1) break
		lines.push(pending.slice(start, end))
		start = end + (pending.charCodeAt(end) === 13 && pending.charCodeAt(end + 1) === 10 ? 2 : 1)
	}
	return { lines, rest: pending.slice(start) }
}

/** The open line as its pieces and their UTF-8 bytes: joining it per chunk was quadratic. */
function openLine(max: number) {
	let pieces: string[] = []
	let bytes = 0
	return {
		/** The lines `text` completes; with no line end, and no CR before it, it extends the open line. */
		take(text: string): string[] {
			const last = pieces[pieces.length - 1]
			if (!/[\r\n]/.test(text) && last?.charCodeAt(last.length - 1) !== 13) {
				pieces.push(text)
				bytes += bytesOf(text, max)
				return []
			}
			const { lines, rest } = completeLines(pieces.join("") + text)
			pieces = rest === "" ? [] : [rest]
			bytes = bytesOf(rest, max)
			return lines
		},
		over: () => bytes > max,
		/** only a CR is open, held back as a possible CRLF's first half */
		lone: () => pieces.length === 1 && pieces[0] === "\r",
	}
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
	opts?: {
		failed?: ((cause: unknown) => unknown) | undefined
		maxLineBytes?: number | undefined
		maxEventBytes?: number | undefined
	},
): AsyncGenerator<SSEEvent, void, undefined> {
	const decoder = new TextDecoder()
	const { failed, maxEventBytes = MAX_EVENT, maxLineBytes: maxLine = MAX_LINE } = opts ?? {}
	const { read, reader } = readerOf(stream, failed)
	const fields = new EventFields(maxEventBytes)
	const open = openLine(maxLine)
	let first = true
	try {
		for (let chunk = await read(); !chunk.done; chunk = await read()) {
			let text = decoder.decode(chunk.value, { stream: true })
			if (first && text.length > 0) {
				if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
				first = false
			}
			for (const line of open.take(text)) {
				if (overLine(line, maxLine)) throw new Error(`SSE line exceeds ${maxLine} bytes`)
				const out = line === "" ? fields.dispatch() : fields.read(line)
				if (out) yield out
			}
			if (open.over()) throw new Error(`SSE line exceeds ${maxLine} bytes`)
		}
		/* a lone CR held back at the end of the stream still ends a blank line; anything else open is discarded */
		if (open.lone()) {
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

/** One request, ready to send: where, with what, and the hooks' view of it. */
type Prepared = { body: BodyInit | undefined; headers: Headers; url: URL }

/** One call: its method, path template and options; `refreshes: false` leaves a 401 to the realtime loop. */
export type Call = { method: string; opts: RequestOptions; path: string; refreshes?: false | undefined }

/** The realtime loop's refresh key, exported by the SDK under no name. */
export const REFRESH_AUTH: unique symbol = /* @__PURE__ */ Symbol("honey.refreshAuth")

/** The send and the config, for the stream functions beside the client. */
export const SEND: unique symbol = /* @__PURE__ */ Symbol("honey.send")
export const CONFIG: unique symbol = /* @__PURE__ */ Symbol("honey.config")

/** One operation of a generated SDK: the call, how it is read, and its stale view for the hooks. */
export type Operation = Call & {
	/** the non-JSON media type the operation declares, read as that type; null when it declares no body */
	declared?: string | null | undefined
	meta?: RequestMeta | undefined
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

	/** @internal */
	get [CONFIG](): ClientConfig {
		return this.#config
	}

	/** @internal One request sent: its hooks run, its auth refreshed, its redirects followed. */
	[SEND](call: Call, kind: RequestKind, meta?: RequestMeta): Promise<Sent> {
		return this.#send(call, kind, meta)
	}

	/** @internal The client's one shared refresh; whether a new token is in place. */
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

	#reading(method: string, opts: RequestOptions): Reading {
		return { limits: this.#config, method, raw: opts.raw }
	}

	/** The parsed body; a non-2xx throws its ClientError (a per-status subclass). */
	async request(method: string, path: string, opts: RequestOptions, meta?: RequestMeta): Promise<unknown> {
		return (await this.requestOperation({ meta, method, opts, path })).data
	}

	/** One REST operation's answer, read as `op` says: parsed, or raw. */
	async requestOperation(op: Operation): Promise<Answer> {
		const sent = await this.#send(op, "rest", op.meta)
		return finishRequest(sent, { ...this.#reading(op.method, op.opts), declared: op.declared })
	}

	buildUrl(path: string, opts: RequestOptions): string {
		return this.#url(path, opts).toString()
	}

	buildPath(path: string, opts: RequestOptions): string {
		const resolved = interpolatePath(path, opts.params)
		const qs = opts.search ? this.#query(opts.search).toString() : ""
		return qs ? `${resolved}?${qs}` : resolved
	}
}

/** An event stream's call: its stale view, and what runs once its answer is ok. */
export type StreamCall = Call & { meta?: RequestMeta | undefined; onOpen?: ((response: Response) => void) | undefined }

/** Whether `response` answers with an event stream. */
export function isEventStream(response: Response): boolean {
	return parseMediaType(response.headers.get("content-type"))?.essence === "text/event-stream"
}

/** An event stream sent when its iteration starts: `open`'s events. */
export const later = (open: () => Promise<Answer>): AsyncIterable<SSEEvent> => ({
	async *[Symbol.asyncIterator]() {
		yield* (await open()).data as AsyncIterable<SSEEvent>
	},
})

/** The events of a sent stream, read as they arrive; the request is done when iteration ends. */
function iterate(http: HTTPClient, sent: Sent): AsyncIterable<SSEEvent> {
	const config = http[CONFIG]
	const caps = { maxEventBytes: config.sseMaxEventBytes, maxLineBytes: config.sseMaxLineBytes }
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

/**
 * One request whose shape is decided by the answer: an event stream becomes an
 * `AsyncIterable<SSEEvent>` (never buffered, exempt from the timeout once headers arrive);
 * anything else is read as in `request`.
 */
export async function requestAuto(
	http: HTTPClient,
	method: string,
	path: string,
	opts: RequestOptions,
): Promise<Answer> {
	const sent = await http[SEND]({ method, opts, path }, "auto")
	if (!sent.response.ok || !isEventStream(sent.response) || opts.raw)
		return finishRequest(sent, { limits: http[CONFIG], method, raw: opts.raw })
	sent.exemptFromTimeout()
	return { data: iterate(http, sent), response: sent.response }
}

export function requestStream(
	http: HTTPClient,
	method: string,
	path: string,
	opts: RequestOptions,
): AsyncIterable<SSEEvent> {
	return streamOperation(http, { method, opts, path })
}

/** An event stream, sent when iteration starts; `onOpen` runs once the answer is ok. */
export function streamOperation(http: HTTPClient, op: StreamCall): AsyncIterable<SSEEvent> {
	return later(() => openStream(http, op))
}

/** An event stream opened: its non-2xx thrown as its ClientError, `onOpen` run, its events read as they arrive. */
export async function openStream(
	http: HTTPClient,
	op: StreamCall,
): Promise<{ data: AsyncIterable<SSEEvent>; response: Response }> {
	const sent = await http[SEND](op, "stream", op.meta)
	/* the timeout bounded the open; the stream itself is never cut by it */
	sent.exemptFromTimeout()
	if (!sent.response.ok) {
		try {
			throw await errorFromResponse(sent.response, http[CONFIG])
		} finally {
			sent.done()
		}
	}
	op.onOpen?.(sent.response)
	return { data: iterate(http, sent), response: sent.response }
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
	protocols?: string | string[] | undefined
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

/** The WebSocket URL of `path`: its HTTP URL under the ws: or wss: scheme. */
export function wsUrl(http: HTTPClient, path: string, opts: RequestOptions): string {
	const url = new URL(http.buildUrl(path, opts))
	if (url.protocol === "https:") url.protocol = "wss:"
	else if (url.protocol === "http:") url.protocol = "ws:"
	return url.toString()
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
	refreshed?: Set<string> | undefined
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
	readonly exact: Map<string, StaleEntry> = new Map()
	readonly patterns: Map<string, Map<string, StaleEntry>> = new Map()
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
	/** how a stream, WebSocket or realtime operation is called; a REST one has none */
	call?: OperationCall
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

/** What a REST call takes; a stream, WebSocket or realtime operation's own call types its input further. */
export type CallInput = RequestOptions

export type OperationFn<I = CallInput> = (input?: I) => unknown

/** The function a non-REST entry is called through: its own adapter, which the service map names. */
export type OperationCall = (core: SdkCore, entry: ServiceEntry, safe: boolean) => OperationFn<never>

const isEntry = (node: unknown): node is ServiceEntry =>
	typeof node === "object" &&
	node !== null &&
	Object.hasOwn(node, "method") &&
	typeof (node as ServiceEntry).method === "string"

/** Only the map's own keys are operations: never `toString`, `constructor` or `then`. */
const childOf = (node: ServiceMapNode, key: string): ServiceMapNode | undefined =>
	Object.hasOwn(node, key) ? (node as Record<string, ServiceMapNode>)[key] : undefined

/** The template the runtime interpolates: a wildcard param's `{name}` becomes the rest-of-path `*name`. */
export function templateOf(entry: ServiceEntry): string {
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
export function optionsFor(entry: ServiceEntry, input: CallInput): RequestOptions {
	const headers: Record<string, string | undefined> = {}
	if (entry.accept) headers["accept"] = entry.accept
	Object.assign(headers, input.headers)
	if (entry.idempotent && !Object.keys(headers).some((k) => k.toLowerCase() === "idempotency-key"))
		headers["Idempotency-Key"] = input.idempotencyKey ?? newClientRequestId()
	return { ...input, headers }
}

/** The client behind a generated SDK class: operations from the service map, read-after-write tracking, dispose. */
export class SdkCore {
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
	meta(selector: string, path: string, method: string): RequestMeta | undefined {
		if (!this.#stale) return undefined
		const { by, isStale } = this.#stale.lookup(selector, path, method, Date.now())
		return { invalidatedBy: by, isStale, selector, seqSnapshot: this.#seq }
	}

	/** Mark what a successful mutation `selector` invalidates. */
	mark(entry: ServiceEntry, params: Record<string, string> | undefined, selector: string): void {
		if (!this.#stale || !entry.invalidate?.length) return
		const now = Date.now()
		const at = { now, seq: ++this.#seq, until: now + (this.#config.invalidation?.staleTime ?? 0) }
		for (const target of resolveInvalidationTargets(entry.invalidate, params)) this.#stale.mark(target, selector, at)
	}

	/** A REST op's answer, its `x-invalidate` targets marked and its stale mark cleared once it is a 2xx. */
	async request(entry: ServiceEntry, input: CallInput): Promise<Answer> {
		const template = templateOf(entry)
		let path: string
		try {
			path = interpolatePath(template, input.params)
		} catch (e) {
			throw e instanceof PathParamError ? pathError(e, entry) : e
		}
		const selector = `${entry.method} ${path}`
		const meta = this.meta(selector, path, entry.method)
		const opts = optionsFor(entry, input)
		const declared = entry.empty ? null : entry.accept
		const settle = () => {
			this.mark(entry, input.params, selector)
			if (meta?.isStale) this.#stale?.clear(selector, path, entry.method, meta.seqSnapshot)
		}
		try {
			const answer = await this.http.requestOperation({ declared, meta, method: entry.method, opts, path: template })
			settle()
			return answer
		} catch (e) {
			/* a 2xx whose body does not decode still changed what it invalidates */
			if (e instanceof DecodeError) settle()
			throw e
		}
	}
}

/** The function an entry is called through, named by its member path; a safe one's REST answer a Result. */
function callable(core: SdkCore, entry: ServiceEntry, name: string, safe: boolean): OperationFn<never> {
	let fn: OperationFn<never>
	/* a stream, WebSocket or realtime op is called through the adapter its entry names */
	if (entry.call) fn = entry.call(core, entry, safe)
	else if (safe) fn = (input?: CallInput) => resultOf(core.request(entry, input ?? {}), entry.headers)
	else fn = async (input?: CallInput) => (await core.request(entry, input ?? {})).data
	Object.defineProperty(fn, "name", { value: name })
	return fn
}

/** A namespace of the map: each read of a key returns the same function or namespace object. */
function namespace(core: SdkCore, node: ServiceMapNode, path: readonly string[], safe: boolean): object {
	const members = new Map<string, unknown>()
	return new Proxy({} as Record<string, unknown>, {
		get(target, key: string | symbol) {
			if (typeof key === "symbol") return Reflect.get(target, key)
			const child = childOf(node, key)
			if (child === undefined) return Reflect.get(target, key)
			return memberOf(core, members, { child, path: [...path, key], safe })
		},
	})
}

type At = { child: ServiceMapNode; path: string[]; safe: boolean }

/** A member at its node and path, the twin's or not, once: a callable for an entry, a namespace object otherwise. */
function memberOf(core: SdkCore, members: Map<string, unknown>, at: At) {
	const key = at.path.join(".")
	let member = members.get(key)
	if (member === undefined) {
		member = isEntry(at.child) ? callable(core, at.child, key, at.safe) : namespace(core, at.child, at.path, at.safe)
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
 * dispatches the entry at `users.create`; the client's own members (`safe`, `state`, `dispose`, `toString`)
 * always win, and a key the map does not hold reads as `undefined`.
 */
export class SDKClient {
	/** the same operations, each answering a Result, never throwing an API answer (bit 21 i) */
	readonly safe: object
	state: Record<string, unknown>
	readonly #core: SdkCore

	constructor(serviceMap: ServiceMap, config: SDKConfig) {
		this.state = config.state ?? {}
		this.#core = new SdkCore({ ...config, state: this.state })
		const core = this.#core
		this.safe = namespace(core, serviceMap, [], true)
		const members = new Map<string, unknown>()
		return new Proxy(this, {
			get(target, key: string | symbol) {
				if (typeof key === "symbol" || key in target) {
					const value: unknown = Reflect.get(target, key)
					return typeof value === "function" ? value.bind(target) : value
				}
				const child = childOf(serviceMap, key)
				return child === undefined ? undefined : memberOf(core, members, { child, path: [key], safe: false })
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

/** An SSE op opened: its stale view for the hooks, and its `x-invalidate` targets marked once the answer is ok. */
async function open(core: SdkCore, entry: ServiceEntry, input: RequestOptions): Promise<Answer> {
	const opts = optionsFor(entry, input)
	const template = templateOf(entry)
	let selector: string | undefined
	let meta: RequestMeta | undefined
	try {
		const path = interpolatePath(template, input.params)
		selector = `${entry.method} ${path}`
		meta = core.meta(selector, path, entry.method)
	} catch {
		/* a bad param fails the stream when it is sent, as for any call */
	}
	const onOpen = () => {
		if (selector !== undefined) core.mark(entry, input.params, selector)
	}
	const { data, response } = await openStream(core.http, { meta, method: entry.method, onOpen, opts, path: template })
	return { data: entry.sse === "json" ? jsonEvents(data) : data, response }
}

/** An event stream: sent when iterated, or opened into a Result by the safe twin. */
export const sseOp: OperationCall = (core, entry, safe) => {
	const opened = (input?: RequestOptions) => open(core, entry, input ?? {})
	return safe
		? (input?: RequestOptions) => resultOf(opened(input))
		: (input?: RequestOptions) => later(() => opened(input))
}

/** A WebSocket call's input: the request's options, the subprotocols, and a resume token. */
type WsInput = RequestOptions & { protocols?: string | string[]; reconnectToken?: string }

/** A WebSocket op: one socket per call, its `x-invalidate` targets marked once it opens. */
export const wsOp: OperationCall =
	(core, entry) =>
	(input: WsInput = {}): TypedWebSocket => {
		const url = new URL(wsUrl(core.http, templateOf(entry), { params: input.params, search: input.search }))
		if (input.reconnectToken) url.searchParams.append("reconnect_token", input.reconnectToken)
		const socket = createTypedWebSocket(url.toString(), { protocols: input.protocols })
		if (entry.invalidate?.length) {
			const selector = `WS ${interpolatePath(templateOf(entry), input.params)}`
			socket.on("open", () => core.mark(entry, input.params, selector))
		}
		return socket
	}
