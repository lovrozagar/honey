import type { MiddlewareFn } from "./middleware.ts"

type PrettyJsonOptions = {
	query?: string
	space?: number
}

export function prettyJson(options?: PrettyJsonOptions): MiddlewareFn<{ req: Request }, {}> {
	const query = options?.query ?? "pretty"
	const space = options?.space ?? 2

	const mw: MiddlewareFn<{ req: Request }, {}> = async (ctx, next) => {
		const url = ctx.req.url
		const qIdx = url.indexOf("?")
		if (qIdx === -1 || !url.includes(query, qIdx)) {
			return next()
		}

		const response = await next()

		const contentType = response.headers.get("content-type")
		if (!contentType || !contentType.includes("application/json")) {
			return response
		}

		const text = await response.text()
		const parsed: unknown = JSON.parse(text)
		const formatted = JSON.stringify(parsed, null, space)

		return new Response(formatted, {
			headers: response.headers,
			status: response.status,
		})
	}

	return mw
}
