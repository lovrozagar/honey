/** Absolute client bases: http(s) and ws(s). Case-insensitive per WHATWG. */
const ABSOLUTE_CLIENT_URL = /^(?:https?|wss?):\/\//i

export function invalidBaseURLError(baseURL: string): Error {
	return new Error(
		`Invalid baseURL ${JSON.stringify(baseURL)}: expected an absolute http(s): or ws(s): URL. Path-only values such as "/api" resolve against location.origin in browsers.`,
	)
}

/**
 * Honor `config.fetch` as-is. If omitted, bind the environment fetch so storing
 * it on a client field does not throw `Illegal invocation` in browsers.
 */
export function bindDefaultFetch(custom?: typeof fetch): typeof fetch {
	if (custom) return custom
	const nativeFetch = globalThis.fetch
	return typeof nativeFetch === "function" ? nativeFetch.bind(globalThis) : (nativeFetch as typeof fetch)
}

function currentLocationOrigin(): string | undefined {
	let origin: unknown
	try {
		origin = globalThis.location?.origin
	} catch {
		return undefined
	}
	if (typeof origin !== "string" || origin === "" || origin === "null") return undefined
	if (!ABSOLUTE_CLIENT_URL.test(origin)) return undefined
	return origin
}

/**
 * Parse `baseURL`. Absolute `http(s):` / `ws(s):` URLs are unchanged. Path-only
 * values such as `/api` resolve against `location.origin` when present.
 */
export function parseClientBaseURL(baseURL: string): URL {
	if (ABSOLUTE_CLIENT_URL.test(baseURL)) return new URL(baseURL)
	const origin = currentLocationOrigin()
	if (origin !== undefined) {
		try {
			return new URL(baseURL, origin)
		} catch {
			throw invalidBaseURLError(baseURL)
		}
	}
	throw invalidBaseURLError(baseURL)
}
