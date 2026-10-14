/**
 * `HoneyRes`: the `ctx.res` helpers. Each builds a buffered response from a status key, records
 * its raw body for later readers, and types it with a phantom content type and status key. On
 * Node it builds the `HoneyResponse` bag instead of a Fetch `Response`.
 */
import { type CookieOptions, serializeCookie } from "../context/cookie.ts"
import { generatorStream, type ProducerOptions, producerStream } from "../streaming/producer-stream.ts"
import { createHoneyResponse, isHoneyResponse, rawBodyOf, type RawBody, withRawBody } from "./builder.ts"
import type { HeaderMap } from "./out-headers.ts"
import { SSE_HEADERS, type SSEOptions, type SSEStream, sseBody } from "./sse.ts"
import { type StatusKey, statusKeyToCode } from "./status.ts"

export type ResponseOptions = {
	cookies?: Record<string, CookieOptions>
	headers?: Record<string, string>
	status?: number
}

/** What `ctx.res` reads from its request, only when a stream needs it: the context itself is one. */
export type ResLink = { readonly req: Request; readonly signal: AbortSignal }

export type GenerateOptions = ResponseOptions & { contentType?: string }

type Generated = AsyncGenerator<string | Uint8Array, void, unknown> | Generator<string | Uint8Array, void, unknown>

/* phantom brands: they exist only at the type level, never assigned at runtime */
declare const CONTENT_TYPE: unique symbol
declare const STATUS_KEY: unique symbol

/** A native Response branded with its content type and status key at the type level. */
export type TypedResponse<CT extends string = string, SK extends string = string> = Response & {
	readonly [CONTENT_TYPE]: CT
	readonly [STATUS_KEY]: SK
}

/** Cast a Response to a TypedResponse: no runtime cost. */
function typed<CT extends string, SK extends string>(response: Response): TypedResponse<CT, SK> {
	return response as TypedResponse<CT, SK>
}

/* frozen: the Node path hands the map to the bag as its header map */
const JSON_HEADERS = /* @__PURE__ */ Object.freeze({ "content-type": "application/json" })
const TEXT_HEADERS = /* @__PURE__ */ Object.freeze({ "content-type": "text/plain; charset=utf-8" })
const HTML_HEADERS = /* @__PURE__ */ Object.freeze({ "content-type": "text/html; charset=utf-8" })
const CSV_HEADERS = /* @__PURE__ */ Object.freeze({ "content-type": "text/csv; charset=utf-8" })
const XML_HEADERS = /* @__PURE__ */ Object.freeze({ "content-type": "application/xml" })
const BINARY_HEADERS = /* @__PURE__ */ Object.freeze({ "content-type": "application/octet-stream" })

function hasOptions(opts: ResponseOptions | undefined): opts is ResponseOptions {
	return opts?.headers !== undefined || opts?.cookies !== undefined
}

function applyNative(headers: Headers, opts: ResponseOptions | undefined): Headers {
	for (const [name, value] of Object.entries(opts?.headers ?? {})) headers.set(name, value)
	for (const [name, cookie] of Object.entries(opts?.cookies ?? {}))
		headers.append("set-cookie", serializeCookie(name, cookie))
	return headers
}

function applyPlain(headers: HeaderMap, opts: ResponseOptions | undefined): HeaderMap {
	for (const [name, value] of Object.entries(opts?.headers ?? {})) headers[name.toLowerCase()] = value
	if (opts?.cookies) {
		/* append, as `Headers.append` does on the native path: a `set-cookie` in `opts.headers` stays */
		const existing = headers["set-cookie"]
		const cookies = existing === undefined ? [] : [existing].flat()
		for (const [name, cookie] of Object.entries(opts.cookies)) cookies.push(serializeCookie(name, cookie))
		headers["set-cookie"] = cookies
	}
	return headers
}

/** Statuses whose responses never carry a body (Fetch "null body status"). */
function isNullBodyStatus(status: number): boolean {
	return status === 101 || status === 103 || status === 204 || status === 205 || status === 304
}

// per-process-constant: text-codec
const encoder = /* @__PURE__ */ new TextEncoder()

function toBytes(chunk: unknown): Uint8Array {
	if (chunk instanceof Uint8Array) return chunk
	if (typeof chunk === "string") return encoder.encode(chunk)
	if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk)
	if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
	throw new TypeError("ctx.res.stream() chunks must be strings, ArrayBuffers or typed arrays")
}

/**
 * A WritableStream over a producer sink. `size()` counts each write as it enters the queue, so
 * `flushed()` waits for every queued write even when the callback returned without closing.
 */
function writableOver(write: (bytes: Uint8Array) => Promise<void>, end: { close(): void; error(e: unknown): void }) {
	let queued = 0
	let written = 0
	let onDrained: (() => void) | undefined
	const writable = new WritableStream<unknown>(
		{
			abort: (reason) => end.error(reason),
			close: () => end.close(),
			write: async (chunk) => {
				try {
					await write(toBytes(chunk))
				} finally {
					written++
					if (written === queued) onDrained?.()
				}
			},
		},
		{
			highWaterMark: 1,
			size: () => {
				queued++
				return 1
			},
		},
	)
	/* a promise only when writes are still queued: most callbacks close or await their writes */
	const pending = (): Promise<void> | undefined =>
		written === queued ? undefined : new Promise<void>((resolve) => (onDrained = resolve))
	return { pending, writable }
}

export class HoneyRes {
	protected readonly nodeOut: boolean
	readonly #link: ResLink | undefined

	/** `link` is the request a per-request res streams for; a bare res has none (no signal, no Last-Event-ID). */
	constructor(nodeOut = false, link?: ResLink) {
		this.nodeOut = nodeOut
		this.#link = link
	}

	/** Producers end with the request; their failures break the body (the logger is wired at bit 07). */
	#producer(): ProducerOptions {
		const link = this.#link
		return link === undefined ? {} : { signal: () => link.signal }
	}

	/** A streamed body under `base` headers plus the options' headers and cookies. */
	#streamed(body: ReadableStream<Uint8Array>, base: Readonly<Record<string, string>>, opts?: ResponseOptions) {
		const headers = hasOptions(opts) ? applyNative(new Headers(base), opts) : base
		return new Response(body, { headers, status: opts?.status ?? 200 })
	}

	/** A response with a body and no extra headers. */
	#known<CT extends string, SK extends string>(
		code: number,
		headers: Readonly<Record<string, string>>,
		raw: RawBody,
		opts?: ResponseOptions,
	): TypedResponse<CT, SK> {
		const status = opts?.status ?? code
		/* `new Response(body, { status: 204 })` throws on the native path; fail the same way everywhere */
		if (isNullBodyStatus(status)) {
			throw new TypeError(`A ${status} response cannot have a body; use ctx.res.noContent() or another status`)
		}
		if (this.nodeOut) {
			const map = hasOptions(opts) ? applyPlain({ ...headers }, opts) : (headers as HeaderMap)
			return typed(createHoneyResponse({ headers: map, raw, status }))
		}
		const init = hasOptions(opts) ? applyNative(new Headers(headers), opts) : headers
		return typed(withRawBody(new Response(raw as BodyInit, { headers: init, status }), raw))
	}

	/** A response with no body. */
	#empty(status: number, headers: Record<string, string>, opts?: ResponseOptions): Response {
		if (this.nodeOut) return createHoneyResponse({ headers: applyPlain(headers, opts), raw: null, status })
		return new Response(null, { headers: applyNative(new Headers(headers), opts), status })
	}

	csv<SK extends StatusKey>(statusKey: SK, body: string, opts?: ResponseOptions): TypedResponse<"text/csv", SK> {
		return this.#known(statusKeyToCode[statusKey], CSV_HEADERS, body, opts)
	}

	html<SK extends StatusKey>(statusKey: SK, body: string, opts?: ResponseOptions): TypedResponse<"text/html", SK> {
		return this.#known(statusKeyToCode[statusKey], HTML_HEADERS, body, opts)
	}

	json<SK extends StatusKey>(
		statusKey: SK,
		data: unknown,
		opts?: ResponseOptions,
	): TypedResponse<"application/json", SK> {
		return this.#known(statusKeyToCode[statusKey], JSON_HEADERS, JSON.stringify(data), opts)
	}

	noContent(opts?: ResponseOptions): TypedResponse<"none", "no_content"> {
		return typed(this.#empty(204, {}, opts))
	}

	/**
	 * Return a native Response. `fetch()`, `Fetcher.fetch`, `cache.match`, and `Response.redirect`
	 * return guarded headers that throw on `set`, which breaks response middleware. Copy status and
	 * headers into a new Response; the body streams through unread. WebSocket upgrades and responses
	 * Honey built pass through as-is. A response whose body was already read is a bug, usually one
	 * kept across requests: it throws instead of answering 200 with an unreadable body (H18.18).
	 */
	raw(response: Response): TypedResponse {
		if (response.bodyUsed)
			throw new TypeError("raw(): this response's body was already read — build a new Response per request")
		if (response.status === 101 || isHoneyResponse(response) || rawBodyOf(response) !== null) return typed(response)
		return typed(new Response(response.body, response))
	}

	/**
	 * Stream a generator's values. A disconnect or the request ending calls `generator.return()`,
	 * so its `finally` runs; a throw mid-stream breaks the body instead of ending it cleanly.
	 */
	generate(generator: Generated, opts?: GenerateOptions): TypedResponse<string, "ok"> {
		const base = opts?.contentType === undefined ? BINARY_HEADERS : { "content-type": opts.contentType }
		return typed(this.#streamed(generatorStream(generator, this.#producer()), base, opts))
	}

	/** An event stream; the client resumes from its `Last-Event-ID` unless `lastEventId` is given. */
	sse(
		callback: (stream: SSEStream) => Promise<void>,
		opts?: ResponseOptions & SSEOptions,
	): TypedResponse<"text/event-stream", "ok"> {
		const lastEventId = opts?.lastEventId ?? this.#link?.req.headers.get("last-event-id") ?? undefined
		const body = sseBody(callback, { ...opts, lastEventId }, this.#producer())
		return typed(this.#streamed(body, SSE_HEADERS, opts))
	}

	/**
	 * Write the body through a `WritableStream`. The callback starts when the body is first read
	 * (never for HEAD); `signal` aborts when the client leaves or the request ends. Returning ends
	 * the body once queued writes flush, closed or not; throwing breaks it, even with a writer held.
	 */
	stream(
		callback: (writable: WritableStream, signal: AbortSignal) => Promise<void>,
		opts?: ResponseOptions,
	): TypedResponse<"application/octet-stream", "ok"> {
		const body = producerStream(async (sink) => {
			const { pending, writable } = writableOver((bytes) => sink.write(bytes), sink)
			await callback(writable, sink.signal)
			const flushing = pending()
			if (flushing !== undefined) await Promise.race([flushing, new Promise<void>((resolve) => sink.onEnd(resolve))])
		}, this.#producer())
		return typed(this.#streamed(body, BINARY_HEADERS, opts))
	}

	redirect(url: string, opts?: ResponseOptions): TypedResponse<"none", "found"> {
		return typed(this.#empty(opts?.status ?? 302, { location: url }, opts))
	}

	text<SK extends StatusKey>(statusKey: SK, body: string, opts?: ResponseOptions): TypedResponse<"text/plain", SK> {
		return this.#known(statusKeyToCode[statusKey], TEXT_HEADERS, body, opts)
	}

	xml<SK extends StatusKey>(statusKey: SK, body: string, opts?: ResponseOptions): TypedResponse<"application/xml", SK> {
		return this.#known(statusKeyToCode[statusKey], XML_HEADERS, body, opts)
	}
}
