import { bodyKind } from "./body-kind.ts"
import { replaceResponse } from "./honey-response.ts"
import { namedMiddleware } from "./middleware.ts"
import type { MiddlewareFn } from "./middleware.ts"

type PrettyJsonOptions = {
	query?: string
	space?: number
}

/** `application/json` or any `+json` suffix, matched on the media-type essence. */
function isJson(contentType: string | null): boolean {
	if (contentType === null) return false
	const essence = contentType.split(";")[0].trim().toLowerCase()
	return essence === "application/json" || essence.endsWith("+json")
}

export function prettyJson(options?: PrettyJsonOptions): MiddlewareFn<{ req: Request }, {}> {
	const query = options?.query ?? "pretty"
	const space = options?.space ?? 2

	const mw: MiddlewareFn<{ req: Request }, {}> = async (ctx, next) => {
		const url = ctx.req.url
		const qIdx = url.indexOf("?")
		/* The trigger is a query parameter with exactly this name, not a substring. */
		if (qIdx === -1) return next()
		const hashIdx = url.indexOf("#", qIdx)
		const search = new URLSearchParams(url.slice(qIdx + 1, hashIdx === -1 ? undefined : hashIdx))
		if (!search.has(query)) return next()

		const response = await next()

		if (!isJson(response.headers.get("content-type")) || bodyKind(response) !== "buffered") {
			return response
		}

		const text = await response.text()
		let formatted: string
		try {
			formatted = text.trim().length === 0 ? text : JSON.stringify(JSON.parse(text), null, space)
		} catch {
			/* Not valid JSON despite the content type: pass the bytes through untouched. */
			formatted = text
		}

		const headers = new Headers(response.headers as HeadersInit)
		headers.delete("content-length")
		return replaceResponse(response, {
			body: formatted,
			headers,
			status: response.status,
		})
	}

	return namedMiddleware("prettyJson", mw)
}
