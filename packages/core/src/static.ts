import { namedMiddleware } from "./middleware.ts"
import type { MiddlewareFn } from "./middleware.ts"
import { normalizePath, pathOfUrl } from "./request-path.ts"
import { withHeaders } from "./with-headers.ts"

type StaticConfig<TCtx> = {
	/**
	 * Returns the file for `filePath`, or `null` to fall through to the next handler.
	 * `filePath` starts with `/`, is decoded once, and has no `.`, `..`, empty, NUL, `:` or
	 * separator-bearing segments — joining it onto a root directory cannot leave that root,
	 * on POSIX or Windows.
	 */
	resolve: (ctx: TCtx, filePath: string) => Response | null | Promise<Response | null>
	/** Mount point, matched on whole segments: `/assets` serves `/assets/x`, never `/assets-private/x`. */
	prefix?: string
	/** Extra response headers; a function receives the same `filePath` that `resolve` got. */
	headers?: Record<string, string> | ((filePath: string) => Record<string, string>)
	/** Rewrites the decoded file path before `resolve`. The result is checked again. */
	rewritePath?: (filePath: string, ctx: TCtx) => string
}

function normalizePrefix(prefix: string): string {
	const normalized = normalizePath(prefix.startsWith("/") ? prefix : `/${prefix}`)
	if (normalized === null) throw new Error(`staticFiles: invalid prefix ${JSON.stringify(prefix)}`)
	return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized
}

/**
 * `/`-joined decoded segments, or `null` when any segment is malformed percent-encoding or
 * decodes to something a file system treats specially (`.`, `..`, empty, a separator, NUL, `:`).
 */
function safeFilePath(encoded: string): string | null {
	const parts = encoded.split("/")
	const out: string[] = []
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]
		if (part === "") {
			/* the leading slash, and a trailing one (a directory request) */
			if (i === 0 || i === parts.length - 1) continue
			return null
		}
		let seg: string
		try {
			seg = decodeURIComponent(part)
		} catch {
			return null
		}
		if (!isSafeSegment(seg)) return null
		out.push(seg)
	}
	const joined = `/${out.join("/")}`
	return out.length > 0 && encoded.endsWith("/") ? `${joined}/` : joined
}

function isSafeSegment(seg: string): boolean {
	if (seg === "" || seg === "." || seg === "..") return false
	/* `:` makes a Windows drive (`C:`) or alternate data stream (`a.txt::$DATA`) */
	return !seg.includes("/") && !seg.includes("\\") && !seg.includes("\0") && !seg.includes(":")
}

/** Re-checks a `rewritePath` result: it must be the same safe shape `resolve` would get without one. */
function safeRewrite(path: string): string | null {
	if (!path.startsWith("/")) return null
	const parts = path.split("/")
	for (let i = 1; i < parts.length; i++) {
		if (parts[i] === "" && i === parts.length - 1) continue
		if (!isSafeSegment(parts[i])) return null
	}
	return path
}

export function staticFiles<TCtx extends { req: Request }>(config: StaticConfig<TCtx>): MiddlewareFn<TCtx, {}> {
	const prefix = normalizePrefix(config.prefix ?? "/")

	const mw: MiddlewareFn<TCtx, {}> = async (ctx, next) => {
		const method = ctx.req.method
		if (method !== "GET" && method !== "HEAD") return next()

		/* the normalized path the router matched — never the raw request target */
		const fromCtx = (ctx as { path?: unknown }).path
		const path = typeof fromCtx === "string" && fromCtx !== "" ? fromCtx : normalizePath(pathOfUrl(ctx.req.url))
		if (path === null) return next()

		let rest: string
		if (prefix === "/") {
			rest = path
		} else if (path === prefix) {
			rest = "/"
		} else if (path.startsWith(prefix) && path.charCodeAt(prefix.length) === 47) {
			rest = path.substring(prefix.length)
		} else {
			return next()
		}

		const decoded = safeFilePath(rest)
		if (decoded === null) return next()
		const filePath = config.rewritePath ? safeRewrite(config.rewritePath(decoded, ctx)) : decoded
		if (filePath === null) return next()

		const response = await config.resolve(ctx, filePath)
		if (response === null) return next()

		if (!config.headers) return response
		/* a resolver's Response can have immutable headers (`fetch()`, a Workers ASSETS binding) */
		const extra = typeof config.headers === "function" ? config.headers(filePath) : config.headers
		return withHeaders(response, (headers) => {
			for (const key of Object.keys(extra)) headers.set(key, extra[key])
		})
	}

	return namedMiddleware("staticFiles", mw)
}
