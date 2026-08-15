import type { CookieOptions } from "./cookie.ts"
import { serializeCookie } from "./cookie.ts"
import type { HoneyError } from "./error.ts"
import { createHoneyResponse } from "./honey-response.ts"
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
	close(): void
	lastEventId: string | undefined
	send(event: SSEEvent): Promise<void>
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
		const cookies: string[] = []
		for (const [name, cookieOpts] of Object.entries(opts.cookies)) {
			cookies.push(serializeCookie(name, cookieOpts))
		}
		headers["set-cookie"] = cookies
	}
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

export class HoneyRes {
	protected readonly _nodeOut: boolean

	constructor(nodeOut = false) {
		this._nodeOut = nodeOut
	}

	private _known<CT extends string, SK extends string>(
		status: number,
		headers: Record<string, string>,
		raw: string | Uint8Array,
		opts?: ResponseOptions,
	): TypedResponse<CT, SK> {
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

	raw(response: Response): TypedResponse {
		return typed(response)
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
		const { readable, writable } = new TransformStream()
		const writer = writable.getWriter()
		const encoder = new TextEncoder()
		let keepaliveTimer: ReturnType<typeof setInterval> | undefined

		let closed = false
		const sseStream: SSEStream = {
			close() {
				if (closed) return
				closed = true
				if (keepaliveTimer !== undefined) clearInterval(keepaliveTimer)
				writer.close()
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
				return writer.write(encoder.encode(msg))
			},
		}

		if (opts?.defaultRetry !== undefined) {
			writer.write(encoder.encode(`retry: ${opts.defaultRetry}\n\n`))
		}

		if (opts?.keepalive !== undefined && opts.keepalive > 0) {
			keepaliveTimer = setInterval(() => {
				writer.write(encoder.encode(": heartbeat\n\n")).catch(() => {
					if (keepaliveTimer !== undefined) clearInterval(keepaliveTimer)
				})
			}, opts.keepalive)
		}

		void callback(sseStream).then(
			async () => {
				if (closed) return
				closed = true
				if (keepaliveTimer !== undefined) clearInterval(keepaliveTimer)
				try {
					await writer.close()
				} catch {}
			},
			async () => {
				if (closed) return
				closed = true
				if (keepaliveTimer !== undefined) clearInterval(keepaliveTimer)
				try {
					await writer.close()
				} catch {}
			},
		)

		const headers = new Headers({
			"cache-control": "no-cache",
			connection: "keep-alive",
			"content-type": "text/event-stream",
		})
		applyResponseOptions(headers, opts)
		return typed(new Response(readable, { headers, status: 200 }))
	}

	generate(
		generator: AsyncGenerator<string, void, unknown> | Generator<string, void, unknown>,
		opts?: { contentType?: string; status?: number },
	): TypedResponse<string, "ok"> {
		const encoder = new TextEncoder()
		const gen = generator
		const readable = new ReadableStream({
			async pull(controller) {
				try {
					const { done, value } = await gen.next()
					if (done) {
						controller.close()
						return
					}
					controller.enqueue(encoder.encode(value))
				} catch {
					controller.close()
				}
			},
		})
		const headers = new Headers({
			"content-type": opts?.contentType ?? "application/octet-stream",
		})
		return typed(new Response(readable, { headers, status: opts?.status ?? 200 }))
	}

	stream(
		callback: (writable: WritableStream) => Promise<void>,
		opts?: ResponseOptions,
	): TypedResponse<"application/octet-stream", "ok"> {
		const { readable, writable } = new TransformStream()
		void callback(writable).then(
			async () => {
				try {
					await writable.close()
				} catch {}
			},
			async () => {
				try {
					await writable.close()
				} catch {}
			},
		)
		const headers = new Headers()
		applyResponseOptions(headers, opts)
		return typed(new Response(readable, { headers, status: opts?.status ?? 200 }))
	}

	text<SK extends StatusKey>(statusKey: SK, body: string, opts?: ResponseOptions): TypedResponse<"text/plain", SK> {
		return this._known(statusKeyToCode[statusKey], TEXT_HEADERS, body, opts)
	}

	xml<SK extends StatusKey>(statusKey: SK, body: string, opts?: ResponseOptions): TypedResponse<"application/xml", SK> {
		return this._known(statusKeyToCode[statusKey], { "content-type": "application/xml" }, body, opts)
	}
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
			...(error.vars ? { vars: error.vars } : {}),
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
