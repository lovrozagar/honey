/**
 * `requestId(options)`: one id per request, on `ctx.requestId`, echoed on the answer (errors
 * included), and bound into `ctx.log` and the request log. An inbound id is never trusted by
 * default: a client could pick it. `trustInbound` opts in, always or per request (a gateway's peer,
 * a shared secret), and the id must still pass `validate` (H23: trust is plain code, never a
 * proxy count).
 */
import { withHeaders } from "../response/with-headers.ts"
import { type MiddlewareFn, namedMiddleware } from "./middleware.ts"

/**
 * May the hop that sent this request decide a value it carries (a request id, a trace)? `false`
 * (the default) never; `true` always; a function decides per request.
 */
export type InboundTrust = boolean | ((ctx: { readonly ip: string | null; readonly req: Request }) => boolean)

export type RequestIdOptions = {
	/** Default `crypto.randomUUID()`. */
	generate?: () => string
	/** Default `x-request-id`. */
	header?: string
	/** Reuse a valid inbound id when the hop is trusted. Default `false`: always a fresh id. */
	trustInbound?: InboundTrust
	/** Which inbound ids are safe to reuse. Default: 1–128 of `A-Z a-z 0-9 . _ : + / = -` (UUIDs, ULIDs, base64, trace ids). */
	validate?: (id: string) => boolean
}

const SAFE_ID = /^[\w.:+/=-]{1,128}$/

function safeId(id: string): boolean {
	return SAFE_ID.test(id)
}

function freshId(): string {
	return crypto.randomUUID()
}

export function requestId(
	options: RequestIdOptions = {},
): MiddlewareFn<{ readonly ip: string | null; readonly req: Request }, { requestId: string }> {
	const header = options.header ?? "x-request-id"
	const generate = options.generate ?? freshId
	const validate = options.validate ?? safeId
	const trust = options.trustInbound ?? false
	return namedMiddleware("requestId", async (ctx, next) => {
		const inbound = trust === false ? null : ctx.req.headers.get(header)
		const reused = inbound !== null && validate(inbound) && (typeof trust === "function" ? trust(ctx) : trust)
		const id = reused ? inbound : generate()
		return withHeaders(await next({ requestId: id }), (headers) => headers.set(header, id))
	})
}
