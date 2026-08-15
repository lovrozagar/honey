import type { MiddlewareFn } from "./middleware.ts"

export type CORSOptions = {
	credentials?: boolean
	exposeHeaders?: string[]
	headers?: string[]
	maxAge?: number
	methods?: string[]
	origin?: "*" | ((origin: string) => boolean) | string | string[]
}

const DEFAULT_METHODS = ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"]
const DEFAULT_MAX_AGE = 86400

function matchOrigin(origin: string, config: CORSOptions["origin"]): string | null {
	if (config === undefined || config === "*") return "*"
	if (typeof config === "string") return config === origin ? origin : null
	if (Array.isArray(config)) return config.includes(origin) ? origin : null
	if (typeof config === "function") return config(origin) ? origin : null
	return null
}

export function cors(options?: CORSOptions): MiddlewareFn<{ req: Request }, {}> {
	const opts = options ?? {}

	/* credentials + wildcard is a CORS spec violation — auto-narrow to echo origin */
	const credentialWildcard =
		opts.credentials === true && (opts.origin === undefined || opts.origin === "*")

	const mw: MiddlewareFn<{ req: Request }, {}> = async (ctx, next) => {
		const req = ctx.req
		const requestOrigin = req.headers.get("origin")

		/* no origin → not a CORS request */
		if (requestOrigin === null) {
			return next()
		}

		const allowedOrigin = credentialWildcard
			? requestOrigin
			: matchOrigin(requestOrigin, opts.origin)

		/* origin not allowed */
		if (allowedOrigin === null) {
			return next()
		}

		const isPreflight = req.method === "OPTIONS" && req.headers.has("access-control-request-method")

		/* Vary: Origin whenever response depends on the request origin (non-wildcard) */
		const needsVary = allowedOrigin !== "*"

		if (isPreflight) {
			const corsHeaders = new Headers()
			corsHeaders.set("access-control-allow-origin", allowedOrigin)
			corsHeaders.set("access-control-allow-methods", (opts.methods ?? DEFAULT_METHODS).join(", "))
			if (opts.headers && opts.headers.length > 0) {
				corsHeaders.set("access-control-allow-headers", opts.headers.join(", "))
			} else {
				const requested = req.headers.get("access-control-request-headers")
				if (requested) {
					corsHeaders.set("access-control-allow-headers", requested)
				}
			}
			corsHeaders.set("access-control-max-age", String(opts.maxAge ?? DEFAULT_MAX_AGE))
			if (opts.credentials) {
				corsHeaders.set("access-control-allow-credentials", "true")
			}
			if (needsVary) {
				corsHeaders.set("vary", "Origin")
			}
			return new Response(null, { headers: corsHeaders, status: 204 })
		}

		/* simple/actual request */
		const response = await next()
		const headers = new Headers(response.headers)
		headers.set("access-control-allow-origin", allowedOrigin)
		if (opts.credentials) {
			headers.set("access-control-allow-credentials", "true")
		}
		if (opts.exposeHeaders && opts.exposeHeaders.length > 0) {
			headers.set("access-control-expose-headers", opts.exposeHeaders.join(", "))
		}
		if (needsVary) {
			headers.append("vary", "Origin")
		}
		return new Response(response.body, {
			headers,
			status: response.status,
		})
	}

	return mw
}
