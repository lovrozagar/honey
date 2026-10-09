import { clientInfo, type HoneyContext } from "./context.ts"
import { HoneyError } from "./error.ts"
import { registerFeature } from "./feature-slots.ts"
import { searchOfUrl } from "./request-path.ts"
import { EK, SK } from "./types.ts"

/* Bodies up to this size with a declared length are forwarded as bytes; larger or unsized ones
   stream (uploads). */
const MAX_BUFFERED_BODY_BYTES = 1024 * 1024

/** Default time allowed until the upstream's response headers arrive. */
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Hop-by-hop headers (RFC 9110 §7.6.1) describe one connection and never cross a proxy, in
 * either direction. `proxy-connection` is the pre-standard spelling clients still send.
 * Headers a `Connection` header names are hop-by-hop too, see `stripHopByHop`.
 */
const HOP_BY_HOP = [
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]

/**
 * Client-sent forwarding headers. The app's `trustProxy()` setting has already decided what is
 * true about the client (`clientInfo`); what the client wrote is replaced, never passed on.
 */
const FORWARDING = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"]

/** Statuses whose response can never carry a body: rebuilding one with a body throws. */
const NULL_BODY = new Set([101, 103, 204, 205, 304])

function stripHopByHop(headers: Headers, keepUpgrade: boolean): void {
	const named = headers.get("connection")
	if (named !== null) {
		for (const token of named.split(",")) {
			const name = token.trim().toLowerCase()
			if (name === "" || (keepUpgrade && name === "upgrade")) continue
			headers.delete(name)
		}
	}
	for (const name of HOP_BY_HOP) {
		if (keepUpgrade && name === "upgrade") continue
		headers.delete(name)
	}
}

/**
 * A streamed body that the destination never reads (a route without input that was sent `{}`)
 * can keep the call open until it times out: a service binding does not settle while the
 * request stream is unconsumed, and a stream teed by `request.clone()` (a body-logging
 * middleware) has no known length. Bytes have neither problem.
 */
async function forwardBody(request: Request): Promise<ArrayBuffer | ReadableStream<Uint8Array> | null> {
	if (request.body === null) return null
	const declared = request.headers.get("content-length")
	const length = declared === null ? Number.NaN : Number.parseInt(declared, 10)
	if (Number.isFinite(length) && length <= MAX_BUFFERED_BODY_BYTES) return request.arrayBuffer()
	return request.body
}

/** Network-level codes runtimes put on errors when the upstream cannot be reached or drops. */
const NETWORK_CODES = /^(?:E[A-Z0-9_]+|Connection\w*|UND_ERR\w*|UNABLE_\w+|CERT_\w+|DEPTH_ZERO\w*)$/

/**
 * Whether `error` means the upstream failed (502), as opposed to a bug in user code (500).
 * Fetch reports network failures as a `TypeError` — so does a typo in `destination` — and the
 * runtimes tell them apart differently: undici and Deno say "fetch failed" (with a `cause`),
 * Bun puts a `code` on the error (`ConnectionRefused`, `ENOTFOUND`), Workers say the network
 * connection was lost. An invalid URL is the destination's bug.
 */
function isUpstreamFailure(error: unknown): boolean {
	if (!(error instanceof Error)) return false
	const code = (error as { code?: unknown }).code
	if (typeof code === "string") return !code.startsWith("ERR_INVALID") && NETWORK_CODES.test(code)
	if (!(error instanceof TypeError)) return false
	const message = error.message
	return /^fetch failed/i.test(message) || /network connection (?:was )?lost/i.test(message)
}

/**
 * Proxy configuration — controls how requests are forwarded to downstream services.
 *
 * `destination` is the only required field. The framework builds the RequestInit
 * (headers, body, signal, redirect) and passes it along with the resolved URL.
 *
 * What the framework does, both ways:
 * - Hop-by-hop headers (`Connection`, `Keep-Alive`, `Transfer-Encoding`, `TE`, `Trailer`,
 *   `Upgrade`, `Proxy-*`, and every header `Connection` names) are dropped. A WebSocket upgrade
 *   keeps `Upgrade: websocket` and `Connection: upgrade`.
 * - The client's `Host` is not sent: the upstream sees the destination's host.
 *   `X-Forwarded-For`, `-Proto` and `-Host` describe the client as the app's `trustProxy()`
 *   setting decided it (`clientInfo(ctx)`), with one `X-Forwarded-For` entry; whatever
 *   forwarding headers the client sent (`Forwarded`, `X-Forwarded-*`, `X-Real-IP`) are dropped.
 *   Configure the upstream to trust exactly one hop: this proxy.
 * - `Expect` is dropped (the proxy reads the body itself).
 * - Every method except GET and HEAD forwards its body (DELETE, OPTIONS, PROPFIND…).
 * - The request follows `ctx.signal`: a client disconnect, `timeout()` or shutdown cancels the
 *   upstream call and its body.
 * - Redirects are returned to the client, never followed.
 */
export type ProxyConfig<TCtx> = {
	/**
	 * Where to send the request. Framework doesn't care how — CF service binding,
	 * URL fetch, Durable Object stub, anything that returns a Response.
	 *
	 * A network failure the runtime reports (connection refused, DNS, reset) answers 502; any
	 * other throw — a bug in this function included — is a 500.
	 *
	 * @param ctx - honey context (middleware additions available)
	 * @param url - normalized path + query string, after rewriteUrl if provided
	 * @param init - framework-prepared RequestInit (method, headers, body, signal, redirect)
	 */
	destination: (ctx: TCtx, url: string, init: RequestInit) => Response | Promise<Response>

	/**
	 * Whether the destination's Response body is already decoded, as `fetch()` always returns
	 * it (the runtime decompresses gzip, br, zstd and keeps the `Content-Encoding` header).
	 * When true (the default), `Content-Encoding` and `Content-Length` are dropped from encoded
	 * responses so the headers describe the bytes the client gets. Set false when the
	 * destination returns bytes still encoded (a store of compressed objects), so the headers
	 * pass through.
	 */
	decoded?: boolean

	/**
	 * Add `X-Forwarded-For`, `-Proto` and `-Host`. Default true. Client-sent forwarding headers
	 * are dropped either way.
	 */
	forwardedHeaders?: boolean

	/**
	 * Most milliseconds the upstream may stay silent while the body streams: the time between
	 * two chunks. Omitted or non-positive: no limit (streams such as SSE may idle). A stall
	 * aborts the upstream and errors the body. Disabled for WebSocket upgrades.
	 */
	idleTimeout?: number | ((ctx: TCtx) => number)

	/**
	 * Hook after downstream responds, before returning to client.
	 * Return void to passthrough, or return a new Response to replace.
	 * The response is the proxy's own copy, so its headers can be set in place.
	 * NOT called for 101 WebSocket upgrades (opaque response).
	 */
	onResponse?: (ctx: TCtx, response: Response) => void | Response | Promise<void | Response>

	/**
	 * Set request headers before forwarding. Called after hop-by-hop and forwarding headers
	 * are handled, so it can override any of them (including `Host` on runtimes that send it).
	 * Static record: entries are set on the headers object.
	 * Function: mutate headers in place.
	 */
	requestHeaders?: Record<string, string> | ((ctx: TCtx, headers: Headers) => void)

	/**
	 * Rewrite URL before passing to destination.
	 * Receives the normalized path + query string, returns transformed URL.
	 */
	rewriteUrl?: (url: string, ctx: TCtx) => string

	/**
	 * Most milliseconds to wait for the upstream's response headers; a later answer is a 504.
	 * Default 60 000. `0` or a non-positive value: no limit. The body is not covered — see
	 * `idleTimeout`. Accepts a number or a function of ctx. Disabled for WebSocket upgrades.
	 */
	timeout?: number | ((ctx: TCtx) => number)
}

function resolveMs<TCtx>(opt: number | ((ctx: TCtx) => number) | undefined, ctx: TCtx, fallback?: number) {
	const ms = typeof opt === "function" ? opt(ctx) : (opt ?? fallback)
	return ms !== undefined && ms > 0 ? ms : undefined
}

function timeoutError(): DOMException {
	return new DOMException("upstream timed out", "TimeoutError")
}

/**
 * The body, erroring (and aborting the upstream through `onIdle`) when the upstream sends
 * nothing for `ms`. The clock runs only while a read is outstanding: a client that reads slowly
 * is backpressure, not an idle upstream.
 */
function withIdleTimeout(body: ReadableStream<Uint8Array>, ms: number, onIdle: () => void): ReadableStream<Uint8Array> {
	const reader = body.getReader()
	return new ReadableStream<Uint8Array>({
		async cancel(reason) {
			await reader.cancel(reason)
		},
		async pull(controller) {
			let timer: ReturnType<typeof setTimeout> | undefined
			const idle = new Promise<"idle">((resolve) => {
				timer = setTimeout(() => resolve("idle"), ms)
			})
			try {
				const result = await Promise.race([reader.read(), idle])
				if (result === "idle") {
					onIdle()
					const error = timeoutError()
					/* the upstream may not react to the abort (a binding, a stub): drop it either way */
					reader.cancel(error).catch(() => {})
					controller.error(error)
				} else if (result.done) {
					controller.close()
				} else {
					controller.enqueue(result.value)
				}
			} catch (error) {
				controller.error(error)
			} finally {
				clearTimeout(timer)
			}
		},
	})
}

/**
 * The response the client gets: hop-by-hop headers dropped, encoding headers made true for
 * the bytes, in a copy whose headers are mutable (fetch() responses are immutable).
 */
function clientResponse(response: Response, decoded: boolean, body: ReadableStream<Uint8Array> | null): Response {
	const headers = new Headers(response.headers)
	stripHopByHop(headers, false)
	if (decoded) {
		const encoding = headers.get("content-encoding")
		if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
			headers.delete("content-encoding")
			/* the length of the encoded bytes, not of the decoded body the client receives */
			headers.delete("content-length")
		}
	}
	return new Response(NULL_BODY.has(response.status) ? null : body, {
		headers,
		status: response.status,
		statusText: response.statusText,
	})
}

/**
 * Creates a proxy handler function from config.
 * Used internally by RouteBuilder.proxy() — not meant for direct consumption.
 *
 * TCtx is unconstrained because HandlerCtx uses Omit which breaks structural
 * compatibility with { path, req }. At runtime ctx is always HoneyContext
 * which has both fields — we access them via property access on the object.
 */
export function createProxyHandler<TCtx>(config: ProxyConfig<TCtx>): (ctx: TCtx) => Promise<Response> {
	const decoded = config.decoded !== false
	const forwarded = config.forwardedHeaders !== false

	return async (ctx: TCtx) => {
		/* HoneyContext always has path + req + signal — safe at runtime */
		const c = ctx as unknown as HoneyContext
		const request = c.req
		const method = request.method.toUpperCase()
		const isWs = request.headers.get("upgrade")?.trim().toLowerCase() === "websocket"
		const headerMs = isWs ? undefined : resolveMs(config.timeout, ctx, DEFAULT_TIMEOUT_MS)
		const idleMs = isWs ? undefined : resolveMs(config.idleTimeout, ctx)

		/* URL: the normalized path the router matched, plus the raw query — no new URL() */
		const pathQuery = c.path + searchOfUrl(request.url)
		const url = config.rewriteUrl ? config.rewriteUrl(pathQuery, ctx) : pathQuery

		/* headers — one copy (the original is immutable) */
		const headers = new Headers(request.headers)
		stripHopByHop(headers, isWs)
		if (isWs) {
			headers.set("upgrade", "websocket")
			headers.set("connection", "upgrade")
		}
		headers.delete("host")
		headers.delete("expect")
		for (const name of FORWARDING) headers.delete(name)
		if (forwarded) {
			const client = clientInfo(c)
			if (client.ip !== null) headers.set("x-forwarded-for", client.ip)
			headers.set("x-forwarded-proto", client.protocol)
			if (client.host !== null) headers.set("x-forwarded-host", client.host)
		}

		/* body: every method that can carry one (fetch refuses a GET or HEAD body) */
		const body = method === "GET" || method === "HEAD" ? null : await forwardBody(request)
		if (body === null || body instanceof ArrayBuffer) {
			/* no body, or bytes whose length fetch() computes itself */
			headers.delete("content-length")
		}

		if (config.requestHeaders) {
			if (typeof config.requestHeaders === "function") {
				config.requestHeaders(ctx, headers)
			} else {
				for (const [k, v] of Object.entries(config.requestHeaders)) {
					headers.set(k, v)
				}
			}
		}

		/* one controller for the proxy's own timeouts, following the request's signal */
		const upstream = new AbortController()
		const clientSignal = c.signal as AbortSignal | undefined
		const signal = clientSignal ? AbortSignal.any([clientSignal, upstream.signal]) : upstream.signal

		const init: RequestInit = {
			body: body ?? undefined,
			headers,
			method,
			redirect: "manual",
			signal,
		}

		/* duplex required for streaming body (Node needs it, CF handles implicitly) */
		if (body instanceof ReadableStream) {
			;(init as Record<string, unknown>)["duplex"] = "half"
		}

		/* forward */
		let headerTimedOut = false
		const headerTimer =
			headerMs === undefined
				? undefined
				: setTimeout(() => {
						headerTimedOut = true
						upstream.abort(timeoutError())
					}, headerMs)
		let response: Response
		try {
			response = await config.destination(ctx, url, init)
		} catch (error) {
			/* ours, or the destination's own AbortSignal.timeout() */
			if (headerTimedOut || (error instanceof DOMException && error.name === "TimeoutError")) {
				throw new HoneyError({ errorKey: EK.gateway_timeout, status: SK.gateway_timeout })
			}
			if (clientSignal?.aborted) throw error
			if (isUpstreamFailure(error)) {
				throw new HoneyError({ errorKey: EK.bad_gateway, status: SK.bad_gateway })
			}
			throw error
		} finally {
			clearTimeout(headerTimer)
		}

		/* WS 101 — return immediately, opaque */
		if (response.status === 101) {
			return response
		}

		let responseBody: ReadableStream<Uint8Array> | null = response.body
		if (responseBody !== null && idleMs !== undefined) {
			responseBody = withIdleTimeout(responseBody, idleMs, () => upstream.abort(timeoutError()))
		}
		let result = clientResponse(response, decoded, responseBody)

		/* response hook */
		if (config.onResponse) {
			const replaced = await config.onResponse(ctx, result)
			if (replaced) result = replaced
		}

		return result
	}
}

/* `import "@lovrozagar/honey/proxy"` is what makes `.proxy()` available; the core never imports this module */
registerFeature("proxy", { createProxyHandler })
