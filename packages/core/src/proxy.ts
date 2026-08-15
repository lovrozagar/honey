import { HoneyError } from "./error.ts"
import { EK, SK } from "./types.ts"

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"])

/**
 * Proxy configuration — controls how requests are forwarded to downstream services.
 *
 * `destination` is the only required field. Framework builds the RequestInit
 * (headers, body, signal, redirect) and passes it along with the resolved URL.
 */
export type ProxyConfig<TCtx> = {
	/**
	 * Where to send the request. Framework doesn't care how — CF service binding,
	 * URL fetch, Durable Object stub, anything that returns a Response.
	 *
	 * @param ctx - honey context (middleware additions available)
	 * @param url - path + query string, after rewriteUrl if provided
	 * @param init - framework-prepared RequestInit (method, headers, body, signal, redirect)
	 */
	destination: (ctx: TCtx, url: string, init: RequestInit) => Response | Promise<Response>

	/**
	 * Hook after downstream responds, before returning to client.
	 * Return void to passthrough, or return a new Response to replace.
	 * Can mutate response.headers in place (zero allocation).
	 * NOT called for 101 WebSocket upgrades (opaque response).
	 */
	onResponse?: (ctx: TCtx, response: Response) => void | Response | Promise<void | Response>

	/**
	 * Set request headers before forwarding. Called after hop-by-hop headers are stripped.
	 * Static record: entries are set on the headers object.
	 * Function: mutate headers in place.
	 */
	requestHeaders?: Record<string, string> | ((ctx: TCtx, headers: Headers) => void)

	/**
	 * Rewrite URL before passing to destination.
	 * Receives path + query string, returns transformed URL.
	 */
	rewriteUrl?: (url: string, ctx: TCtx) => string

	/**
	 * Timeout in milliseconds. Default: 30000.
	 * Accepts a number or a function that receives ctx and returns a number.
	 * Disabled for WebSocket upgrades.
	 */
	timeout?: number | ((ctx: TCtx) => number)
}

/**
 * Creates a proxy handler function from config.
 * Used internally by RouteBuilder.proxy() — not meant for direct consumption.
 *
 * TCtx is unconstrained because HandlerCtx uses Omit which breaks structural
 * compatibility with { path, req }. At runtime ctx is always HoneyContext
 * which has both fields — we access them via property access on the object.
 */
export function createProxyHandler<TCtx>(
	config: ProxyConfig<TCtx>,
): (ctx: TCtx) => Promise<Response> {
	const timeoutOpt = config.timeout ?? 30_000

	return async (ctx: TCtx) => {
		const timeoutMs = typeof timeoutOpt === "function" ? timeoutOpt(ctx) : timeoutOpt
		/* HoneyContext always has path + req — safe at runtime */
		const c = ctx as Record<string, unknown>
		const request = c["req"] as Request
		const method = request.method
		const isWs = request.headers.get("upgrade") === "websocket"

		/* URL resolution — path + query, no new URL() */
		const rawUrl = request.url
		const protoEnd = rawUrl.indexOf("//")
		const pathStart = protoEnd === -1 ? 0 : rawUrl.indexOf("/", protoEnd + 2)
		const qIdx = pathStart === -1 ? -1 : rawUrl.indexOf("?", pathStart)
		const pathOnly = c["path"] as string
		const rawPathQuery = qIdx === -1 ? pathOnly : pathOnly + rawUrl.substring(qIdx)
		const url = config.rewriteUrl ? config.rewriteUrl(rawPathQuery, ctx) : rawPathQuery

		/* headers — one copy (original is immutable), strip hop-by-hop */
		const headers = new Headers(request.headers)
		headers.delete("connection")
		headers.delete("keep-alive")
		headers.delete("transfer-encoding")
		headers.delete("te")
		headers.delete("trailer")
		headers.delete("proxy-authenticate")
		headers.delete("proxy-authorization")

		if (isWs) {
			headers.set("connection", "upgrade")
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

		/* build init — plain object, no new Request() */
		const hasBody = BODY_METHODS.has(method)
		const init: RequestInit = {
			body: hasBody ? request.body : undefined,
			headers,
			method,
			redirect: "manual",
			signal: isWs ? undefined : AbortSignal.timeout(timeoutMs),
		}

		/* duplex required for streaming body (Node needs it, CF handles implicitly) */
		if (hasBody && request.body) {
			;(init as Record<string, unknown>)["duplex"] = "half"
		}

		/* forward */
		let response: Response
		try {
			response = await config.destination(ctx, url, init)
		} catch (error) {
			if (error instanceof DOMException && error.name === "TimeoutError") {
				throw new HoneyError({
					errorKey: EK.gateway_timeout,
					status: SK.gateway_timeout,
				})
			}
			if (error instanceof TypeError) {
				throw new HoneyError({
					errorKey: EK.bad_gateway,
					status: SK.bad_gateway,
				})
			}
			throw error
		}

		/* WS 101 — return immediately, opaque */
		if (response.status === 101) {
			return response
		}

		/* response hook */
		if (config.onResponse) {
			const replaced = await config.onResponse(ctx, response)
			if (replaced) return replaced
		}

		/* stream through — zero wrapping */
		return response
	}
}
