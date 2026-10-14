/** A request view (the Node adapter's) hands over the Fetch `Request` behind it under this key. */
export const TO_FETCH_REQUEST: unique symbol = /* @__PURE__ */ Symbol.for("honey.toFetchRequest")

/**
 * The Fetch `Request` for `req`. On Bun and Workers that is `req` itself. On Node, `ctx.req` is a
 * lighter view of the incoming message, so `new Request(ctx.req)`, `fetch(ctx.req)` and
 * `instanceof Request` need this first. The view builds its Request once, which then owns the body.
 */
export function toFetchRequest(req: Request): Request {
	const own = (req as unknown as { [TO_FETCH_REQUEST]?: unknown })[TO_FETCH_REQUEST]
	return typeof own === "function" ? (own as () => Request).call(req) : req
}

/**
 * A request view (the Node adapter's) swaps its body for another stream under this key and stays
 * the view. Not TO_FETCH_REQUEST: that builds the Fetch Request behind the view, which then owns
 * the body; this keeps the view, so no Request is built unless something later asks for one, and
 * then it carries the swapped body.
 */
export const REPLACE_BODY: unique symbol = /* @__PURE__ */ Symbol.for("honey.replaceBody")

/**
 * `req` with `body` in place of its own body: a request view swaps it in place and is returned
 * as is; a Fetch Request becomes one new Request with the same method, URL, headers and signal.
 */
export function withBody(req: Request, body: ReadableStream<Uint8Array>): Request {
	const swap = (req as unknown as { [REPLACE_BODY]?: unknown })[REPLACE_BODY]
	if (typeof swap !== "function") return new Request(req, { body, duplex: "half" } as RequestInit)
	;(swap as (body: ReadableStream<Uint8Array>) => void).call(req, body)
	return req
}
