import { namedMiddleware } from "./middleware.ts"
import type { MiddlewareFn } from "./middleware.ts"
import { withHeaders } from "./with-headers.ts"

export type CORSOptions = {
	/** Requires an explicit `origin` list, string or predicate; `"*"` or no origin throws. */
	credentials?: boolean
	exposeHeaders?: string[]
	headers?: string[]
	maxAge?: number
	methods?: string[]
	origin?: "*" | ((origin: string) => boolean) | string | string[]
}

const DEFAULT_METHODS = ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"]
const DEFAULT_MAX_AGE = 86400

/**
 * Returns the value for `Access-Control-Allow-Origin`, or null when the origin
 * is not allowed. The opaque origin `null` (sandboxed iframes, `file:`, some
 * redirects) is never reflected: any page can produce it.
 */
function matchOrigin(origin: string, config: CORSOptions["origin"]): string | null {
	if (config === undefined || config === "*") return "*"
	if (origin === "null") return null
	if (typeof config === "string") return config === origin ? origin : null
	if (Array.isArray(config)) return config.includes(origin) ? origin : null
	return config(origin) ? origin : null
}

/** Append `value` to `Vary` unless it is already listed (or `*`). */
function addVary(headers: Headers, value: string): void {
	const current = headers.get("vary")
	if (current === null || current.trim() === "") {
		headers.set("vary", value)
		return
	}
	const tokens = current.split(",").map((t) => t.trim().toLowerCase())
	if (tokens.includes("*") || tokens.includes(value.toLowerCase())) return
	headers.set("vary", `${current}, ${value}`)
}

export function cors(options?: CORSOptions): MiddlewareFn<{ req: Request }, {}> {
	const opts = options ?? {}

	if (opts.credentials === true && (opts.origin === undefined || opts.origin === "*")) {
		throw new TypeError(
			"cors: `credentials: true` needs an explicit `origin` (string, list or predicate). A wildcard would let every site make credentialed requests and read the response.",
		)
	}

	/* `Vary: Origin` whenever the answer depends on the request's Origin — that is,
	 * on every response unless the policy is a plain wildcard. Without it a shared
	 * cache can serve one origin's ACAO (or its absence) to another. */
	const varies = !(opts.origin === undefined || opts.origin === "*")
	const methods = (opts.methods ?? DEFAULT_METHODS).join(", ")
	const allowHeaders = opts.headers && opts.headers.length > 0 ? opts.headers.join(", ") : null
	const exposeHeaders = opts.exposeHeaders && opts.exposeHeaders.length > 0 ? opts.exposeHeaders.join(", ") : null
	const maxAge = String(opts.maxAge ?? DEFAULT_MAX_AGE)

	const mw: MiddlewareFn<{ req: Request }, {}> = async (ctx, next) => {
		const req = ctx.req
		const requestOrigin = req.headers.get("origin")
		const allowedOrigin = requestOrigin === null ? null : matchOrigin(requestOrigin, opts.origin)

		if (allowedOrigin !== null && req.method === "OPTIONS" && req.headers.has("access-control-request-method")) {
			const headers = new Headers()
			headers.set("access-control-allow-origin", allowedOrigin)
			headers.set("access-control-allow-methods", methods)
			if (allowHeaders !== null) {
				headers.set("access-control-allow-headers", allowHeaders)
			} else {
				const requested = req.headers.get("access-control-request-headers")
				if (requested) headers.set("access-control-allow-headers", requested)
				addVary(headers, "Access-Control-Request-Headers")
			}
			headers.set("access-control-max-age", maxAge)
			if (opts.credentials) headers.set("access-control-allow-credentials", "true")
			if (varies) addVary(headers, "Origin")
			return new Response(null, { headers, status: 204 })
		}

		const response = await next()
		if (allowedOrigin === null && !varies) return response
		return withHeaders(response, (headers) => {
			if (varies) addVary(headers, "Origin")
			if (allowedOrigin === null) return
			headers.set("access-control-allow-origin", allowedOrigin)
			if (opts.credentials) headers.set("access-control-allow-credentials", "true")
			if (exposeHeaders !== null) headers.set("access-control-expose-headers", exposeHeaders)
		})
	}

	return namedMiddleware("cors", mw)
}
