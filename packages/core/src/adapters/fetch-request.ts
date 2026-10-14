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
