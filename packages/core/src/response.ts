import type { CookieOptions } from "./cookie.ts"
import { serializeCookie } from "./cookie.ts"
import type { HoneyError } from "./error.ts"
import { createHoneyResponse, isHoneyResponse } from "./honey-response.ts"
import { generatorStream, producerStream, tagStream, type ProducerOptions } from "./producer-stream.ts"
import type { StatusKey } from "./types.ts"
import { statusKeyToCode } from "./types.ts"

export type { CookieOptions } from "./cookie.ts"
export { serializeCookie } from "./cookie.ts"

export type ResponseOptions = {
	cookies?: Record<string, CookieOptions>
	headers?: Record<string, string>
	status?: number
}

export type SSEEvent = {
	data: object | string
	event: string
	id?: string
	retry?: number
}

export type SSEOptions = ResponseOptions & {
	defaultRetry?: number
	keepalive?: number
	lastEventId?: string
}

export type SSEStream = {
	/** End the stream. Idempotent and synchronous: safe in a `finally`. */
	close(): void
	/** True once the stream ended: closed, or the client went away. */
	readonly closed: boolean
	lastEventId: string | undefined
	/**
	 * Queue an event. Resolves when the client is ready for more. After the stream ended it
	 * rejects with an `AbortError`, which ends an awaiting loop; Honey does not report that
	 * rejection, and an unawaited one never surfaces as an unhandled rejection.
	 */
	send(event: SSEEvent): Promise<void>
	/** Aborts when the client disconnects, the request times out, or the server shuts down. */
	readonly signal: AbortSignal
}

export type ErrorFormatter = (error: HoneyError, defaultShape: Record<string, unknown>) => Record<string, unknown>

function applyResponseOptions(headers: Headers, opts?: ResponseOptions): void {
	if (opts?.headers) {
		for (const [k, v] of Object.entries(opts.headers)) {
			headers.set(k, v)
		}
	}
	if (opts?.cookies) {
		for (const [name, cookieOpts] of Object.entries(opts.cookies)) {
			headers.append("set-cookie", serializeCookie(name, cookieOpts))
		}
	}
}

function applyPlainOptions(headers: Record<string, string | string[]>, opts?: ResponseOptions): void {
	if (opts?.headers) {
		for (const [k, v] of Object.entries(opts.headers)) {
			headers[k.toLowerCase()] = v
		}
	}
	if (opts?.cookies) {
		/* append, as `Headers.append` does on the native path: a `set-cookie` in `opts.headers` stays */
		const existing = headers["set-cookie"]
		const cookies: string[] = existing === undefined ? [] : Array.isArray(existing) ? [...existing] : [existing]
		for (const [name, cookieOpts] of Object.entries(opts.cookies)) {
			cookies.push(serializeCookie(name, cookieOpts))
		}
		headers["set-cookie"] = cookies
	}
}

/** Statuses whose responses never carry a body (Fetch "null body status"). */
function isNullBodyStatus(status: number): boolean {
	return status === 101 || status === 103 || status === 204 || status === 205 || status === 304
}

/* phantom brands — exist only at type level, never assigned at runtime */
declare const CONTENT_TYPE: unique symbol
declare const STATUS_KEY: unique symbol

/** Branded Response — phantom content-type + status-key at type level, native Response at runtime */
export type TypedResponse<CT extends string = string, SK extends string = string> = Response & {
	readonly [CONTENT_TYPE]: CT
	readonly [STATUS_KEY]: SK
}

/** Cast a native Response to TypedResponse — zero runtime cost */
function typed<CT extends string, SK extends string>(response: Response): TypedResponse<CT, SK> {
	return response as TypedResponse<CT, SK>
}

/** Node adapter reads this to `res.end(payload)` without draining the Fetch body. */
const RAW_BODY = Symbol.for("honey.rawBody")

function withRawBody(response: Response, body: string | Uint8Array): Response {
	Object.defineProperty(response, RAW_BODY, { value: body })
	return response
}

/* pre-allocated header objects — Bun optimizes plain objects better than Headers instances */
const JSON_HEADERS = { "content-type": "application/json" }
const TEXT_HEADERS = { "content-type": "text/plain; charset=utf-8" }
const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" }
const CSV_HEADERS = { "content-type": "text/csv; charset=utf-8" }
const BINARY_HEADERS = { "content-type": "application/octet-stream" }

/** Report a stream producer failure where no logger is wired (a bare `HoneyRes`). */
function reportToConsole(err: unknown): void {
	console.error("honey: stream producer failed", err)
}

export class HoneyRes {
	protected readonly _nodeOut: boolean

	constructor(nodeOut = false) {
		this._nodeOut = nodeOut
	}

	/** Signal and error reporting for streams; the per-request res wires `ctx.signal` and the logger. */
	protected _producer(): ProducerOptions {
		return { report: reportToConsole }
	}

	private _known<CT extends string, SK extends string>(
		statusCode: number,
		headers: Record<string, string>,
		raw: string | Uint8Array,
		opts?: ResponseOptions,
	): TypedResponse<CT, SK> {
		const status = opts?.status ?? statusCode
		if (isNullBodyStatus(status)) {
			/* `new Response(body, { status: 204 })` throws on the native path; fail the same way everywhere */
			throw new TypeError(`A ${status} response cannot have a body; use ctx.res.noContent() or another status`)
		}
		if (this._nodeOut) {
			if (!opts?.headers && !opts?.cookies) {
				return typed(createHoneyResponse({ headers, raw, status }))
			}
			const plain: Record<string, string | string[]> = { ...headers }
			applyPlainOptions(plain, opts)
			return typed(createHoneyResponse({ headers: plain, raw, status }))
		}
		if (!opts?.headers && !opts?.cookies) {
			return typed(withRawBody(new Response(raw as BodyInit, { headers, status }), raw))
		}
		const native = new Headers(headers)
		applyResponseOptions(native, opts)
		return typed(withRawBody(new Response(raw as BodyInit, { headers: native, status }), raw))
	}

	binary<SK extends StatusKey>(
		statusKey: SK,
		body: ArrayBuffer | Uint8Array<ArrayBuffer>,
		opts?: ResponseOptions,
	): TypedResponse<"application/octet-stream", SK> {
		const raw = body instanceof Uint8Array ? body : new Uint8Array(body)
		return this._known(statusKeyToCode[statusKey], BINARY_HEADERS, raw, opts)
	}

	csv<SK extends StatusKey>(statusKey: SK, body: string, opts?: ResponseOptions): TypedResponse<"text/csv", SK> {
		return this._known(statusKeyToCode[statusKey], CSV_HEADERS, body, opts)
	}

	html<SK extends StatusKey>(statusKey: SK, body: string, opts?: ResponseOptions): TypedResponse<"text/html", SK> {
		return this._known(statusKeyToCode[statusKey], HTML_HEADERS, body, opts)
	}

	json<SK extends StatusKey>(
		statusKey: SK,
		data: unknown,
		opts?: ResponseOptions,
	): TypedResponse<"application/json", SK> {
		return this._known(statusKeyToCode[statusKey], JSON_HEADERS, JSON.stringify(data), opts)
	}

	noContent(opts?: ResponseOptions): TypedResponse<"none", "no_content"> {
		if (this._nodeOut) {
			const headers: Record<string, string | string[]> = {}
			applyPlainOptions(headers, opts)
			return typed(createHoneyResponse({ headers, raw: null, status: 204 }))
		}
		const headers = new Headers()
		applyResponseOptions(headers, opts)
		return typed(new Response(null, { headers, status: 204 }))
	}

	/**
	 * Return a native Response. `fetch()`, `Fetcher.fetch`, `cache.match`, and `Response.redirect`
	 * return guarded headers that throw on `set`, which breaks response middleware (`requestId`,
	 * `secureHeaders`, `poweredBy`, `serverTiming`). Copy status and headers into a new Response; the
	 * body streams through unread. WebSocket upgrades and responses Honey built pass through as-is.
	 */
	raw(response: Response): TypedResponse {
		if (response.status === 101 || isHoneyResponse(response) || RAW_BODY in response) return typed(response)
		return typed(new Response(response.body, response))
	}

	redirect(url: string, opts?: ResponseOptions): TypedResponse<"none", "found"> {
		if (this._nodeOut) {
			const headers: Record<string, string | string[]> = { location: url }
			applyPlainOptions(headers, opts)
			return typed(createHoneyResponse({ headers, raw: null, status: opts?.status ?? 302 }))
		}
		const headers = new Headers({ location: url })
		applyResponseOptions(headers, opts)
		return typed(new Response(null, { headers, status: opts?.status ?? 302 }))
	}

	sse(callback: (stream: SSEStream) => Promise<void>, opts?: SSEOptions): TypedResponse<"text/event-stream", "ok"> {
		const encoder = new TextEncoder()
		const body = producerStream((sink) => {
			const stream: SSEStream = {
				close: () => sink.close(),
				get closed() {
					return sink.closed
				},
				lastEventId: opts?.lastEventId,
				send(event) {
					if (/[\r\n]/.test(event.event)) {
						throw new Error("SSE event name must not contain newlines")
					}
					if (event.id && /[\r\n]/.test(event.id)) {
						throw new Error("SSE id must not contain newlines")
					}
					const dataStr = typeof event.data === "string" ? event.data : JSON.stringify(event.data)
					const dataLines = dataStr
						.split(/\r\n|\r|\n/)
						.map((line) => `data: ${line}`)
						.join("\n")
					let msg = `event: ${event.event}\n${dataLines}\n`
					if (event.id) msg += `id: ${event.id}\n`
					/** SSE retry must be a non-negative integer per spec — skip if invalid */
					if (event.retry !== undefined && Number.isFinite(event.retry) && event.retry >= 0) {
						msg += `retry: ${Math.floor(event.retry)}\n`
					}
					msg += "\n"
					return sink.write(encoder.encode(msg))
				},
				signal: sink.signal,
			}
			if (opts?.defaultRetry !== undefined) {
				void sink.write(encoder.encode(`retry: ${opts.defaultRetry}\n\n`))
			}
			if (opts?.keepalive !== undefined && opts.keepalive > 0) {
				const heartbeat = encoder.encode(": heartbeat\n\n")
				const timer = setInterval(() => {
					void sink.write(heartbeat)
				}, opts.keepalive)
				sink.onEnd(() => clearInterval(timer))
			}
			return callback(stream)
		}, this._producer())

		/* no `connection: keep-alive`: HTTP/1.1 keeps the connection by default, the header would
		 * override a client's `Connection: close`, and HTTP/2 forbids it */
		const headers = new Headers({
			"cache-control": "no-cache",
			"content-type": "text/event-stream",
		})
		applyResponseOptions(headers, opts)
		return typed(tagStream(new Response(body, { headers, status: opts?.status ?? 200 })))
	}

	/**
	 * Stream a generator's values. A disconnect, `timeout()` or shutdown calls `generator.return()`,
	 * so its `finally` runs; a throw mid-stream breaks the body instead of ending it cleanly.
	 */
	generate(
		generator: AsyncGenerator<string | Uint8Array, void, unknown> | Generator<string | Uint8Array, void, unknown>,
		opts?: { contentType?: string; status?: number },
	): TypedResponse<string, "ok"> {
		const headers = new Headers({
			"content-type": opts?.contentType ?? "application/octet-stream",
		})
		const body = generatorStream(generator, this._producer())
		return typed(tagStream(new Response(body, { headers, status: opts?.status ?? 200 })))
	}

	/**
	 * Write the body through a `WritableStream`. The callback starts when the body is first read
	 * (never for HEAD); `signal` aborts when the client disconnects, the request times out, or the
	 * server shuts down. Returning ends the body after queued writes flush, whether or not the
	 * writable was closed; throwing breaks it, even while the callback holds a writer.
	 */
	stream(
		callback: (writable: WritableStream, signal: AbortSignal) => Promise<void>,
		opts?: ResponseOptions,
	): TypedResponse<"application/octet-stream", "ok"> {
		const encoder = new TextEncoder()
		const body = producerStream(async (sink) => {
			/* `size()` runs as each chunk enters the writable's queue: it counts writes not yet flushed */
			let queued = 0
			let flushed = 0
			let onFlushed: (() => void) | null = null
			const writable = new WritableStream<unknown>(
				{
					abort(reason) {
						sink.error(reason)
					},
					close() {
						sink.close()
					},
					async write(chunk) {
						try {
							await sink.write(toBytes(chunk, encoder))
						} finally {
							flushed++
							if (flushed === queued) onFlushed?.()
						}
					},
				},
				{
					highWaterMark: 1,
					size() {
						queued++
						return 1
					},
				},
			)
			await callback(writable, sink.signal)
			if (sink.closed) return
			if (flushed < queued) {
				await new Promise<void>((resolve) => {
					onFlushed = resolve
					sink.onEnd(resolve)
				})
			}
		}, this._producer())
		const headers = new Headers()
		applyResponseOptions(headers, opts)
		return typed(tagStream(new Response(body, { headers, status: opts?.status ?? 200 })))
	}

	text<SK extends StatusKey>(statusKey: SK, body: string, opts?: ResponseOptions): TypedResponse<"text/plain", SK> {
		return this._known(statusKeyToCode[statusKey], TEXT_HEADERS, body, opts)
	}

	xml<SK extends StatusKey>(statusKey: SK, body: string, opts?: ResponseOptions): TypedResponse<"application/xml", SK> {
		return this._known(statusKeyToCode[statusKey], { "content-type": "application/xml" }, body, opts)
	}
}

function toBytes(chunk: unknown, encoder: TextEncoder): Uint8Array {
	if (chunk instanceof Uint8Array) return chunk
	if (typeof chunk === "string") return encoder.encode(chunk)
	if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk)
	if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
	throw new TypeError("ctx.res.stream() chunks must be strings, ArrayBuffers or typed arrays")
}

export type CustomErrorFormatter = (error: HoneyError, data: Record<string, unknown>) => Record<string, unknown>

export function createErrorResponse(
	error: HoneyError,
	defaultFormatter: ErrorFormatter,
	customFormatter?: CustomErrorFormatter | null,
): Response {
	let body: Record<string, unknown>

	if (error.data !== undefined) {
		/* custom schema error — apply customErrorFormatter if set, else use data as-is */
		const rawData = error.data as Record<string, unknown>
		if (customFormatter) {
			try {
				body = customFormatter(error, rawData)
			} catch {
				body = rawData
			}
		} else {
			body = rawData
		}
	} else {
		/* standard error — build default shape, apply defaultErrorFormatter */
		const defaultShape: Record<string, unknown> = {
			error_key: error.errorKey,
			fields: error.fields,
			message: error.message,
			status: error.status,
			status_key: error.statusKey,
			success: false,
		}
		try {
			body = defaultFormatter(error, defaultShape)
		} catch {
			/* formatter crashed — fall back to default shape */
			body = defaultShape
		}
	}

	const headers: Record<string, string> = { "content-type": "application/json" }
	if (error.headers) {
		for (const [k, v] of Object.entries(error.headers)) {
			headers[k] = v
		}
	}
	const payload = JSON.stringify(body)
	return withRawBody(
		new Response(payload, {
			headers,
			status: error.status,
		}),
		payload,
	)
}
