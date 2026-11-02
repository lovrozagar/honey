/**
 * `cacheControl()` (A4): the `Cache-Control` header for GET and HEAD answers, and time-based
 * conditional GET. An answer's `Last-Modified` (its own, or `lastModified`'s, in whole seconds)
 * meets the request's `If-Modified-Since`: not modified since is a 304. A request carrying
 * `If-None-Match` is judged by that alone (RFC 9110 §13.1.3), so `If-Modified-Since` is ignored.
 */
import { type MiddlewareFn, namedMiddleware } from "../middleware/middleware.ts"
import { notModified } from "./etag.ts"
import { withHeaders } from "./with-headers.ts"

/** Options for `cacheControl()`. At least one directive or `lastModified` is required. */
export type CacheControlOptions = {
	/** Adds `immutable`: the response never changes while fresh, so clients skip revalidation. */
	immutable?: boolean
	/** Seconds a response stays fresh (`max-age`). */
	maxAge?: number
	/** Adds `must-revalidate`: a stale response must be revalidated before use. */
	mustRevalidate?: boolean
	/** Adds `no-cache`: caches revalidate before reusing the response. */
	noCache?: boolean
	/** Adds `no-store`: no cache may keep the response. */
	noStore?: boolean
	/** Adds `private`: only the end user's cache may keep it. Cannot be combined with `public`. */
	private?: boolean
	/** Adds `public`: any cache may keep it. Cannot be combined with `private`. */
	public?: boolean
	/** Seconds a shared cache keeps it fresh (`s-maxage`). */
	sMaxAge?: number
	/** Seconds a stale response may be served while it revalidates. */
	staleWhileRevalidate?: number
	/**
	 * When the answer last changed, for an answer that does not say: sent in whole seconds. Return `null` or
	 * `undefined` to send none.
	 */
	lastModified?:
		| ((ctx: {
				/** The request being answered. */
				req: Request
		  }) => Date | null | undefined)
		| undefined
}

/** `date` as an HTTP-date (IMF-fixdate), in whole seconds. */
export function httpDate(date: Date | number): string {
	return new Date(date).toUTCString()
}

/** A duration directive, refused unless a whole, non-negative number of seconds. */
function seconds(name: string, value: number | undefined): string | null {
	if (value === undefined) return null
	if (!Number.isInteger(value) || value < 0) {
		throw new TypeError(`cacheControl(): ${name} must be a whole, non-negative number of seconds`)
	}
	return `${name}=${value}`
}

/** The header value, in one fixed order; `null` when no directive is given. */
function directives(o: CacheControlOptions): string | null {
	if (o.public === true && o.private === true) throw new TypeError("cacheControl(): public and private contradict")
	const parts = [
		o.public === true ? "public" : null,
		o.private === true ? "private" : null,
		o.noCache === true ? "no-cache" : null,
		o.noStore === true ? "no-store" : null,
		seconds("max-age", o.maxAge),
		seconds("s-maxage", o.sMaxAge),
		o.mustRevalidate === true ? "must-revalidate" : null,
		seconds("stale-while-revalidate", o.staleWhileRevalidate),
		o.immutable === true ? "immutable" : null,
	].filter((part) => part !== null)
	return parts.length === 0 ? null : parts.join(", ")
}

/** Whether the answer, last modified at `lastModified`, has not changed since `ifModifiedSince`. */
function unmodifiedSince(lastModified: string | null, ifModifiedSince: string): boolean {
	if (lastModified === null) return false
	const since = Date.parse(ifModifiedSince)
	const modified = Date.parse(lastModified)
	return !Number.isNaN(since) && !Number.isNaN(modified) && modified <= since
}

/**
 * Middleware that sets `Cache-Control` on GET and HEAD answers with a 2xx or 304 status, unless the answer already has
 * one. `lastModified` adds `Last-Modified` to a 200 answer that has none. A 200 answer with a `Last-Modified`, its own
 * or the option's, becomes a 304 when the request's `If-Modified-Since` is the same or later; a request that also
 * carries `If-None-Match` never gets this 304. Throws a `TypeError` at creation when given no directive and no
 * `lastModified`, when `public` and `private` are both set, or when a duration is not a whole, non-negative number of
 * seconds.
 */
export function cacheControl(options: CacheControlOptions): MiddlewareFn<{
	/** The request: its method and conditional headers decide what this middleware does. */
	req: Request
}> {
	const header = directives(options)
	const lastModified = options.lastModified
	if (header === null && lastModified === undefined) {
		throw new TypeError("cacheControl(): give at least one directive or lastModified")
	}
	return namedMiddleware("cacheControl", async (ctx, next) => {
		const method = ctx.req.method
		if (method !== "GET" && method !== "HEAD") return next()
		const response = await next()
		const status = response.status
		if (status !== 304 && (status < 200 || status > 299)) return response
		const modified = status === 200 && lastModified !== undefined ? lastModified(ctx) : null
		const dressed = withHeaders(response, (headers) => {
			if (header !== null && !headers.has("cache-control")) headers.set("cache-control", header)
			if (modified != null && !headers.has("last-modified")) headers.set("last-modified", httpDate(modified))
		})
		const since = ctx.req.headers.get("if-modified-since")
		if (status !== 200 || since === null || ctx.req.headers.has("if-none-match")) return dressed
		return unmodifiedSince(dressed.headers.get("last-modified"), since) ? notModified(dressed) : dressed
	})
}
