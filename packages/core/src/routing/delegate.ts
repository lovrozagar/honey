/**
 * Delegation: a leaf of a loaded route tree that no route of this app serves goes to the app's
 * catch-all (a root wildcard it registered outside the tree), as a gateway forwards its services'
 * routes. The leaf keeps its identity: its id, pattern, params, meta, error keys and the scopes
 * covering its path. Its declared body media type is checked first, and its body is left unread.
 */
import { binaryRanges, binaryType } from "../input/binary.ts"
import type { InputSchemas } from "../input/input.ts"
import type { RuntimeMiddleware } from "../middleware/middleware.ts"
import { assertRequestContentType } from "../validation/content-type.ts"
import { parsePattern, type RouteId, splitRouteId } from "./pattern.ts"
import type { HoneyGraph, RouteHandler } from "./register.ts"
import type { RouteEntry } from "./tree.ts"

/** The catch-all serving `method`: the one registered for it, else the one for every method. */
function catchAllFor(g: HoneyGraph, method: string): RouteHandler | undefined {
	const all = [...g.catchAll.values()]
	return all.find((r) => splitRouteId(r.id).method === method) ?? all.find((r) => splitRouteId(r.id).method === "ALL")
}

/** Middleware refusing a request whose media type the declared body does not take, before anything reads it. */
function bodyGate(iv: InputSchemas, method: string, pattern: string): RuntimeMiddleware | null {
	const ranges = iv.binary === undefined ? null : binaryRanges(iv.binary, method, pattern)
	if (ranges === null && iv.json === undefined && iv.form === undefined) return null
	return (ctx, next) => {
		const contentType = (ctx as { req: Request }).req.headers.get("content-type")
		if (ranges === null) assertRequestContentType(iv, contentType)
		else binaryType(ranges, contentType)
		return next()
	}
}

/** The record a leaf serves through `catchAll`: the catch-all's chain and handler, under the leaf's identity and data. */
function delegated(id: RouteId, entry: RouteEntry, catchAll: RouteHandler): RouteHandler {
	const { method, pattern } = splitRouteId(id)
	const gate = entry.iv === undefined || entry.iv === null ? null : bodyGate(entry.iv, method, pattern)
	return {
		...catchAll,
		cm: gate === null ? catchAll.cm : [gate, ...catchAll.cm],
		dk: new Set(entry.ek),
		ef: null,
		id,
		iv: entry.iv ?? null,
		mt: null,
		out: entry.out ?? null,
		rb: entry.bek ?? null,
		rp: pattern,
		sg: parsePattern(pattern),
		xm: entry.mt ?? null,
	}
}

/** The loaded leaves no route serves: a WebSocket leaf or one without a catch-all for its method answers as a miss. */
function unserved(g: HoneyGraph): [RouteId, RouteEntry][] {
	if (g.loaded === null) return []
	return Object.entries(g.loaded).filter(([id]) => !g.records.has(id))
}

/** The records the unserved leaves of a loaded tree run, through the app's catch-all. */
export function delegatedRecords(g: HoneyGraph): [RouteId, RouteHandler][] {
	const out: [RouteId, RouteHandler][] = []
	for (const [id, entry] of unserved(g)) {
		const { method } = splitRouteId(id)
		const catchAll = method === "WS" ? undefined : catchAllFor(g, method)
		if (catchAll !== undefined) out.push([id, delegated(id, entry, catchAll)])
	}
	return out
}

/**
 * A loaded tree that disagrees with what the app registers is stale: a route it lacks, or a
 * catch-all with no leaf left to serve. Regenerating it (`honey generate`) brings them back in step.
 */
export function assertTreeCurrent(g: HoneyGraph): void {
	const stale = g.catchAll.size > 0 && unserved(g).length === 0 ? [...g.unexpected, ...g.catchAll.keys()] : g.unexpected
	if (stale.length === 0) return
	const verb = stale.length === 1 ? "is" : "are"
	throw new Error(
		`${stale.join(", ")} ${verb} registered but missing from the loaded route tree. Run \`honey generate\`.`,
	)
}
