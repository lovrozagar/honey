/**
 * Headers a request may carry to another origin when a `redirect: "follow"` client follows a
 * cross-origin redirect. Everything else is dropped on that hop: credentials, the auth header and
 * every header set from config (either form), per call or by an `onRequest` hook, whatever its
 * name. An allowlist, so a header added later never leaks by default.
 *
 * Shared by `createClient` and the generated TypeScript SDK runtime, which embeds this list.
 */
export const CROSS_ORIGIN_SAFE_HEADERS: readonly string[] = ["accept", "accept-language", "user-agent"]

/** The headers to send on a cross-origin hop: only the allowlisted ones from `headers`. */
export function crossOriginHeaders(headers: Headers): Headers {
	const out = new Headers()
	for (const name of CROSS_ORIGIN_SAFE_HEADERS) {
		const value = headers.get(name)
		if (value !== null) out.set(name, value)
	}
	return out
}
