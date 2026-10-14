/**
 * `HoneyRes`: the `ctx.res` helpers. Each builds a buffered response from a status key, records
 * its raw body for later readers, and types it with a phantom content type and status key. On
 * Node it builds the `HoneyResponse` bag instead of a Fetch `Response`.
 */
import { type CookieOptions, serializeCookie } from "../context/cookie.ts"
import { createHoneyResponse, isHoneyResponse, rawBodyOf, type RawBody, withRawBody } from "./builder.ts"
import type { HeaderMap } from "./out-headers.ts"
import { type StatusKey, statusKeyToCode } from "./status.ts"

export type ResponseOptions = {
	cookies?: Record<string, CookieOptions>
	headers?: Record<string, string>
	status?: number
}

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

export class HoneyRes {
	protected readonly nodeOut: boolean

	constructor(nodeOut = false) {
		this.nodeOut = nodeOut
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
	 * Honey built pass through as-is.
	 */
	raw(response: Response): TypedResponse {
		if (response.status === 101 || isHoneyResponse(response) || rawBodyOf(response) !== null) return typed(response)
		return typed(new Response(response.body, response))
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
