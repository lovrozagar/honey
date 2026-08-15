import { namedMiddleware } from "./middleware.ts"
import type { MiddlewareFn } from "./middleware.ts"

type StaticConfig<TCtx> = {
	resolve: (ctx: TCtx, filePath: string) => Response | null | Promise<Response | null>
	prefix?: string
	headers?: Record<string, string> | ((filePath: string) => Record<string, string>)
	rewritePath?: (filePath: string, ctx: TCtx) => string
}

const TRAVERSAL = /(?:^|\/)\.\.\//

export function staticFiles<TCtx extends { req: Request }>(config: StaticConfig<TCtx>): MiddlewareFn<TCtx, {}> {
	const prefix = config.prefix ?? "/"

	const mw: MiddlewareFn<TCtx, {}> = async (ctx, next) => {
		const method = ctx.req.method
		if (method !== "GET" && method !== "HEAD") return next()

		/* fast path extraction — no new URL() */
		const raw = ctx.req.url
		const protoEnd = raw.indexOf("//")
		const pathStart = protoEnd === -1 ? 0 : raw.indexOf("/", protoEnd + 2)
		const qIdx = pathStart === -1 ? -1 : raw.indexOf("?", pathStart)
		let path: string
		if (pathStart === -1) {
			path = "/"
		} else if (qIdx === -1) {
			path = raw.substring(pathStart)
		} else {
			path = raw.substring(pathStart, qIdx)
		}

		if (!path.startsWith(prefix)) return next()

		const stripped = prefix === "/" ? path : path.substring(prefix.length)
		const filePath = stripped === "" ? "/" : stripped

		/* path traversal guard — reject encoded and literal .. segments */
		const decoded = decodeURIComponent(filePath)
		if (TRAVERSAL.test(decoded)) return next()

		const resolved = config.rewritePath ? config.rewritePath(filePath, ctx) : filePath
		const response = await config.resolve(ctx, resolved)
		if (response === null) return next()

		/* apply extra headers */
		if (config.headers) {
			const extra = typeof config.headers === "function" ? config.headers(filePath) : config.headers
			for (const key in extra) {
				response.headers.set(key, extra[key])
			}
		}

		return response
	}

	return namedMiddleware("staticFiles", mw)
}
