/**
 * `cors(options)`: Cross-Origin Resource Sharing. A preflight from an allowed origin is answered
 * here with 204; any other answer gets the allow-origin it earns. The opaque origin `null` is never
 * reflected, and credentials need an explicit origin. Headers are written through `withHeaders`,
 * so a buffered response keeps its plain header map.
 */
import { addVary, withHeaders } from "../response/with-headers.ts"
import { type MiddlewareFn, namedMiddleware } from "./middleware.ts"

export type CORSOptions = {
	/** Requires an explicit `origin`: a string, a list or a predicate. With `"*"` or none, cors() throws. */
	credentials?: boolean
	/** Response headers a browser script may read. */
	exposeHeaders?: string[]
	/** Request headers a preflight allows; unset, the requested ones are echoed. */
	headers?: string[]
	/** Seconds a browser may cache a preflight. Default 86400. */
	maxAge?: number
	/** Methods a preflight allows. Default GET, HEAD, PUT, PATCH, POST, DELETE. */
	methods?: string[]
	/** Default `"*"`. */
	origin?: "*" | ((origin: string) => boolean) | string | readonly string[]
}

const DEFAULT_METHODS = ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"]
const DEFAULT_MAX_AGE = 86_400

/**
 * The `Access-Control-Allow-Origin` value `origin` earns, or `null`. The opaque origin `null`
 * (sandboxed frames, `file:`, some redirects) is never reflected: any page can produce it.
 */
function allowedOrigin(origin: string, policy: CORSOptions["origin"]): string | null {
	if (policy === undefined || policy === "*") return "*"
	if (origin === "null") return null
	if (typeof policy === "string") return policy === origin ? origin : null
	if (typeof policy === "function") return policy(origin) ? origin : null
	return policy.includes(origin) ? origin : null
}

const joined = (list: readonly string[] | undefined): string | null =>
	list !== undefined && list.length > 0 ? list.join(", ") : null

export function cors(options: CORSOptions = {}): MiddlewareFn<{ req: Request }> {
	const { credentials = false, origin } = options
	if (credentials && (origin === undefined || origin === "*")) {
		throw new TypeError(
			"cors: `credentials: true` needs an explicit `origin` (a string, a list or a predicate). A wildcard would let every site make credentialed requests and read the answer.",
		)
	}
	/* the answer depends on the request's Origin unless the policy is a plain wildcard: say so to caches */
	const varies = !(origin === undefined || origin === "*")
	const methods = (options.methods ?? DEFAULT_METHODS).join(", ")
	const allowHeaders = joined(options.headers)
	const exposeHeaders = joined(options.exposeHeaders)
	const maxAge = String(options.maxAge ?? DEFAULT_MAX_AGE)

	const answerPreflight = (req: Request, allowed: string): Response => {
		const headers = new Headers({
			"access-control-allow-methods": methods,
			"access-control-allow-origin": allowed,
			"access-control-max-age": maxAge,
		})
		if (allowHeaders !== null) headers.set("access-control-allow-headers", allowHeaders)
		else {
			const requested = req.headers.get("access-control-request-headers")
			if (requested) headers.set("access-control-allow-headers", requested)
			addVary(headers, "Access-Control-Request-Headers")
		}
		if (credentials) headers.set("access-control-allow-credentials", "true")
		if (varies) addVary(headers, "Origin")
		return new Response(null, { headers, status: 204 })
	}

	return namedMiddleware("cors", async (ctx, next) => {
		const req = ctx.req
		const requestOrigin = req.headers.get("origin")
		const allowed = requestOrigin === null ? null : allowedOrigin(requestOrigin, origin)
		if (allowed !== null && req.method === "OPTIONS" && req.headers.has("access-control-request-method")) {
			return answerPreflight(req, allowed)
		}
		const response = await next()
		if (allowed === null && !varies) return response
		return withHeaders(response, (headers) => {
			if (varies) addVary(headers, "Origin")
			if (allowed === null) return
			headers.set("access-control-allow-origin", allowed)
			if (credentials) headers.set("access-control-allow-credentials", "true")
			if (exposeHeaders !== null) headers.set("access-control-expose-headers", exposeHeaders)
		})
	})
}
