/** A Request-shaped object (Honey's Node shim) that can hand over the real Fetch `Request` behind it. */
export const TO_FETCH_REQUEST = Symbol.for("honey.toFetchRequest")

/**
 * The Fetch `Request` for `req`. On Bun, Deno and Workers that is `req` itself. On Node, `ctx.req`
 * is a lighter view of the incoming message, so `new Request(ctx.req)`, `fetch(ctx.req)` and
 * `ctx.req instanceof Request` need this first; it builds the real Request once, and it then owns
 * the body (read the body through either, not both).
 */
export function toFetchRequest(req: Request): Request {
	const own = (req as unknown as { [TO_FETCH_REQUEST]?: () => Request })[TO_FETCH_REQUEST]
	return typeof own === "function" ? own.call(req) : req
}
