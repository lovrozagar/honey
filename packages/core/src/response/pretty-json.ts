/**
 * `prettyJson()`: a JSON answer indented when the query asks for it (`?pretty`). JSON is read from
 * the parsed media type (`application/json` or a `+json` suffix), never a prefix (H18.2); only a
 * buffered body is touched, and one that does not parse goes out as it came.
 */
import { bodyKind } from "../input/body-kind.ts"
import { type MiddlewareFn, namedMiddleware } from "../middleware/middleware.ts"
import { rawBodyOf, replaceResponse } from "./builder.ts"
import { isJsonMediaType, parseMediaType } from "./media-type.ts"

export type PrettyJsonOptions = {
	/** The query parameter that asks for it; default `pretty`. */
	query?: string
	/** The indent; default 2. */
	space?: number
}

// per-process-constant: text-codec
const decoder = /* @__PURE__ */ new TextDecoder()

/** `text` indented, or `null` when it is empty or not JSON. */
function indented(text: string, space: number): string | null {
	if (text.trim().length === 0) return null
	try {
		return JSON.stringify(JSON.parse(text), null, space)
	} catch {
		/* JSON in name only: the answer goes out as it came */
		return null
	}
}

export function prettyJson(
	options: PrettyJsonOptions = {},
): MiddlewareFn<{ readonly search: Readonly<Record<string, string>> }> {
	const query = options.query ?? "pretty"
	const space = options.space ?? 2
	return namedMiddleware("prettyJson", async (ctx, next) => {
		if (!Object.hasOwn(ctx.search, query)) return next()
		const response = await next()
		if (!isJsonMediaType(parseMediaType(response.headers.get("content-type"))) || bodyKind(response) !== "buffered") {
			return response
		}
		const raw = rawBodyOf(response)
		const text = raw === null ? await response.text() : typeof raw === "string" ? raw : decoder.decode(raw)
		const formatted = indented(text, space)
		/* a foreign body was read: it goes on as a fresh one, changed or not */
		if (formatted === null) return raw === null ? replaceResponse(response, { body: text }) : response
		const headers = new Headers(response.headers as HeadersInit)
		headers.delete("content-length")
		return replaceResponse(response, { body: formatted, headers })
	})
}
