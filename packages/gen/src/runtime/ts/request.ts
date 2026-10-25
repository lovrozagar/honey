import type { ClientConfig } from "./config.ts"
import { ClientError } from "./error.ts"

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
