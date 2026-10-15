import type { RedirectPolicy } from "./config.ts"
import { crossOriginHeaders } from "./redirect-policy.ts"
import { isReplayable } from "./request.ts"

const REDIRECT_STATUSES: readonly number[] = [301, 302, 303, 307, 308]
const MAX_REDIRECTS = 20

/** Browsers hide redirect targets from script (`opaqueredirect`), so the platform must follow. */
function platformFollowsRedirects(): boolean {
	const g = globalThis as { document?: unknown; WorkerGlobalScope?: unknown }
	return typeof g.document !== "undefined" || typeof g.WorkerGlobalScope !== "undefined"
}

/** The request for the next hop, or `null` when this redirect must be returned unfollowed. */
function nextHop(response: Response, init: RequestInit, crossOrigin: boolean): RequestInit | null {
	const next: RequestInit = { ...init, headers: new Headers(init.headers) }
	if (response.status === 307 || response.status === 308) {
		/* a body is replayed only to the same origin, and only when it can be sent twice */
		if (init.body != null && (crossOrigin || !isReplayable(init.body))) return null
	} else {
		/* 303, and 301/302 for POST: the browser behavior is GET without a body */
		const method = (init.method ?? "GET").toUpperCase()
		if (response.status === 303 ? method !== "HEAD" : method === "POST") {
			next.method = "GET"
			next.body = undefined
			;(next.headers as Headers).delete("content-type")
		}
	}
	if (crossOrigin) next.headers = crossOriginHeaders(next.headers as Headers)
	return next
}

/** Where a redirect leads, when it is one this client follows: http(s), and same-origin unless `follow`. */
function redirectTarget(response: Response, current: URL, origin: string, policy: RedirectPolicy): URL | null {
	const location = response.headers.get("location")
	if (!REDIRECT_STATUSES.includes(response.status) || location === null) return null
	let target: URL
	try {
		target = new URL(location, current)
	} catch {
		/* an unparseable Location is returned as the answer it is */
		return null
	}
	if (target.protocol !== "http:" && target.protocol !== "https:") return null
	return target.origin !== origin && policy !== "follow" ? null : target
}

/**
 * Send `init` to `url`, following redirects as `policy` says: hop by hop, so a cross-origin hop
 * carries only the safe headers and never a body.
 */
export async function fetchFollowing(
	fetch: typeof globalThis.fetch,
	url: URL,
	init: RequestInit,
	{ origin, policy }: { origin: string; policy: RedirectPolicy },
): Promise<Response> {
	if (policy === "manual" || policy === "error" || platformFollowsRedirects()) {
		return fetch(url.toString(), policy === "same-origin" ? init : { ...init, redirect: policy })
	}
	let current = url
	let currentInit: RequestInit = { ...init, redirect: "manual" }
	for (let hop = 0; ; hop++) {
		const response = await fetch(current.toString(), currentInit)
		const target = hop >= MAX_REDIRECTS ? null : redirectTarget(response, current, origin, policy)
		const next = target === null ? null : nextHop(response, currentInit, target.origin !== origin)
		if (target === null || next === null) return response
		await response.body?.cancel().catch(() => {
			/* the redirect's own body is never read */
		})
		current = target
		currentInit = next
	}
}
