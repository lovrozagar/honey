/**
 * `proxy(config)`: a route handler that forwards the request to an upstream and streams its answer
 * back, mounted like any other: `app.all("/api/*rest").handler(proxy({ destination }))`. Plain code
 * reached through `@lovrozagar/honey/proxy`, no slot and no builder method (H23): core never imports
 * it. The answer is the passthrough brand, since the upstream decides its status and type.
 *
 * Both ways, hop-by-hop headers are dropped and the forwarding headers describe the client as the
 * platform reported it (headers.ts); the URL is the normalized path, the deadlines and failure
 * mapping are upstream.ts's. Every method but GET and HEAD forwards its body. The call follows
 * `ctx.signal`: a disconnect, `timeout()` or shutdown cancels it and its body. Redirects go back to
 * the client, never followed. On the Node bridge the answer is a HoneyResponse, so the header
 * middleware in front of the route stay on the plain map.
 */
import { createHoneyResponse, isNodeOutbound } from "../response/builder.ts"
import { headersToRecord, HoneyOutHeaders } from "../response/out-headers.ts"
import type { TypedResponse } from "../response/response.ts"
import { searchOfUrl } from "../routing/request-path.ts"
import { clientHeaders, upstreamHeaders } from "./headers.ts"
import { forwardBody, msOf, timeoutError, withIdleTimeout, within } from "./upstream.ts"

/** Default time allowed until the upstream's response headers arrive. */
const DEFAULT_TIMEOUT_MS = 60_000

export type ProxyConfig<TCtx> = {
	/**
	 * Where the request goes: `fetch`, a Workers service binding, a Durable Object stub, anything
	 * that answers a Response. `url` is the normalized path and query (after `rewriteUrl`), `init`
	 * the method, headers, body, signal and `redirect: "manual"` the framework prepared. A network
	 * failure the runtime reports is a 502; any other throw, a bug here included, a 500.
	 */
	destination: (ctx: TCtx, url: string, init: RequestInit) => Promise<Response> | Response
	/**
	 * Whether the answer's body is already decoded, as `fetch()` always returns it. When true (the
	 * default) an encoded answer loses `Content-Encoding` and `Content-Length`, so the headers
	 * describe the bytes the client gets. False when destination returns bytes still encoded.
	 */
	decoded?: boolean
	/** Add `X-Forwarded-For`, `-Proto` and `-Host`. Default true; the client's own are dropped either way. */
	forwardedHeaders?: boolean
	/**
	 * Most milliseconds the upstream may stay silent while the body streams. Omitted or not
	 * positive: no limit (an SSE stream may idle). A stall aborts the upstream and errors the body.
	 * Off for a WebSocket upgrade.
	 */
	idleTimeout?: number | ((ctx: TCtx) => number)
	/**
	 * Runs on the answer before the client gets it, its headers mutable. Return a Response to
	 * replace it. Not called for a 101 upgrade, which is the runtime's.
	 */
	onResponse?: (ctx: TCtx, response: Response) => Promise<Response | void> | Response | void
	/** Run last on the forwarded headers, so it may set any of them: a record of entries, or an edit. */
	requestHeaders?: Record<string, string> | ((ctx: TCtx, headers: Headers) => void)
	/** Rewrite the normalized path and query before destination sees it. */
	rewriteUrl?: (url: string, ctx: TCtx) => string
	/**
	 * Most milliseconds to wait for the answer's headers; later is a 504. Default 60 000; not
	 * positive is no limit. The body is `idleTimeout`'s. Off for a WebSocket upgrade.
	 */
	timeout?: number | ((ctx: TCtx) => number)
}

/** What the handler reads off the route's ctx, whatever else the app put on it. */
type ProxyCtx = {
	readonly ip: string | null
	readonly path: string
	readonly req: Request
	readonly signal: AbortSignal
}

function isNullBody(status: number): boolean {
	return status === 101 || status === 103 || status === 204 || status === 205 || status === 304
}

/** The client's copy of the upstream answer, its headers cleaned and mutable for onResponse. */
function answerFor(
	response: Response,
	body: ReadableStream<Uint8Array> | null,
	decoded: boolean,
	nodeOut: boolean,
): Response {
	const init = { status: response.status, statusText: response.statusText }
	const stream = isNullBody(response.status) ? null : body
	if (nodeOut) {
		const headers = new HoneyOutHeaders(headersToRecord(response.headers))
		clientHeaders(headers, decoded)
		return createHoneyResponse({ ...init, headers: headers.toRecord(), stream })
	}
	const headers = new Headers(response.headers)
	clientHeaders(headers, decoded)
	return new Response(stream, { ...init, headers })
}

function applyRequestHeaders<TCtx>(edit: ProxyConfig<TCtx>["requestHeaders"], ctx: TCtx, headers: Headers): void {
	if (typeof edit === "function") return edit(ctx, headers)
	for (const [name, value] of Object.entries(edit ?? {})) headers.set(name, value)
}

export function proxy<TCtx>(config: ProxyConfig<TCtx>): (ctx: TCtx) => Promise<TypedResponse> {
	const decoded = config.decoded !== false
	const forwarded = config.forwardedHeaders !== false
	return async (ctx) => {
		const { ip, path, req, signal } = ctx as unknown as ProxyCtx
		const websocket = req.headers.get("upgrade")?.trim().toLowerCase() === "websocket"
		const pathQuery = path + searchOfUrl(req.url)
		const url = config.rewriteUrl ? config.rewriteUrl(pathQuery, ctx) : pathQuery
		const headers = upstreamHeaders(req, { client: forwarded ? ip : undefined, websocket })
		const body = await forwardBody(req)
		/* no body, or bytes whose length fetch() computes itself */
		if (!(body instanceof ReadableStream)) headers.delete("content-length")
		applyRequestHeaders(config.requestHeaders, ctx, headers)
		const upstream = new AbortController()
		const init: RequestInit & { duplex?: "half" } = {
			body: body ?? undefined,
			headers,
			method: req.method,
			redirect: "manual",
			signal: AbortSignal.any([signal, upstream.signal]),
		}
		/* a streamed request body needs it on Node; Workers imply it */
		if (body instanceof ReadableStream) init.duplex = "half"
		const headerMs = websocket ? undefined : msOf(config.timeout, ctx, DEFAULT_TIMEOUT_MS)
		const response = await within({ client: signal, headerMs, upstream }, () => config.destination(ctx, url, init))
		if (response.status === 101) return response as TypedResponse
		const idleMs = websocket ? undefined : msOf(config.idleTimeout, ctx)
		const stream =
			response.body !== null && idleMs !== undefined
				? withIdleTimeout(response.body, idleMs, () => upstream.abort(timeoutError()))
				: response.body
		const answer = answerFor(response, stream, decoded, isNodeOutbound(req))
		const replaced = config.onResponse ? await config.onResponse(ctx, answer) : undefined
		return (replaced ?? answer) as TypedResponse
	}
}
