/**
 * Header edits on a response a middleware got back from `next()`, without leaving the fast path:
 * a HoneyResponse is edited on its plain header map (`HoneyOutHeaders.set`/`delete`), so no native
 * `Headers` is built. A plain native response is edited in place; one whose headers are immutable
 * (`fetch()`, `Response.redirect()`) is copied first; a 101 upgrade is never touched.
 */
import { isHoneyResponse } from "./builder.ts"

/** What an edit may do to the headers: read, set and delete, never walk them. */
export type HeaderEdit = {
	delete(name: string): void
	get(name: string): string | null
	has(name: string): boolean
	set(name: string, value: string): void
}

/* a header name no one sends: writing to immutable Headers throws */
const PROBE = "x-honey-mutability-probe"

function hasImmutableHeaders(response: Response): boolean {
	try {
		response.headers.delete(PROBE)
		return false
	} catch {
		/* the answer, not a failure: these headers are the runtime's own and cannot change */
		return true
	}
}

/** `response` with `edit` applied to its headers; `edit` must not read the body. */
export function withHeaders(response: Response, edit: (headers: HeaderEdit) => void): Response {
	/* an upgrade belongs to the runtime: rebuilding it throws or drops the socket */
	if (response.status === 101) return response
	if (isHoneyResponse(response) || !hasImmutableHeaders(response)) {
		edit(response.headers)
		return response
	}
	const copy = new Response(response.body, {
		headers: new Headers(response.headers),
		status: response.status,
		statusText: response.statusText,
	})
	edit(copy.headers)
	return copy
}

/** Add `token` to `Vary` unless it is already listed, case-insensitively, or `Vary` is `*`. */
export function addVary(headers: HeaderEdit, token: string): void {
	const current = headers.get("vary")
	if (current === null || current.trim() === "") return headers.set("vary", token)
	const listed = current.split(",").map((item) => item.trim().toLowerCase())
	if (listed.includes("*") || listed.includes(token.toLowerCase())) return
	headers.set("vary", `${current}, ${token}`)
}
