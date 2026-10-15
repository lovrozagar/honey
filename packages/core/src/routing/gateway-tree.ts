/**
 * Generate time, for a gateway: the tree it serves (its services' routes and its own) and the
 * schemas it documents its services' routes with. Pure: the gateway serves the result through
 * `routeTree()` like any generated tree.
 */
import { expandOptional, parsePattern, splitRouteId } from "./pattern.ts"
import { GRAPH, type HoneyGraph, type RouteHandler } from "./register.ts"
import { snapshotRouteTree } from "./route-tree.ts"
import {
	assertTreeFormat,
	cloneTree,
	dict,
	insertLeaf,
	ROUTE_TREE_VERSION,
	type RouteEntry,
	type RouteTree,
} from "./tree.ts"

type App = { readonly [GRAPH]: HoneyGraph }

/** An entry as a generated file carries it: data only, no live record. */
function dataOf({ h: _live, ...data }: RouteEntry): RouteEntry {
	return data
}

const isRootWildcard = (id: string) => {
	const segments = parsePattern(splitRouteId(id).pattern)
	return segments.length === 1 && segments[0]?.k === "wildcard"
}

/**
 * The tree a gateway serves: `source` (its services' merged routes) with the gateway's own routes
 * as further leaves. Its root wildcards stay out, as the catch-all the services' routes delegate
 * to. An own route that is also a service route throws, unless `source` is the gateway's own snapshot.
 */
export function gatewayTree(app: App, source: RouteTree): RouteTree {
	assertTreeFormat(source)
	const g = app[GRAPH]
	const routes = dict<RouteEntry>()
	for (const [id, entry] of Object.entries(source.routes)) routes[id] = dataOf(entry)
	const own = [...g.records.keys()].filter((id) => !isRootWildcard(id))
	const shadowed = own.filter((id) => Object.hasOwn(routes, id))
	const served = (id: string) => g.records.has(id) || g.catchAll.has(id)
	const self = own.length > 0 && shadowed.length === own.length && Object.keys(routes).every(served)
	if (shadowed.length > 0 && !self) {
		throw new Error(`Gateway routes are also downstream routes in the merged tree: ${shadowed.join(", ")}`)
	}
	const root = cloneTree(source.root)
	if (!self) {
		const snapshot = snapshotRouteTree(g)
		for (const id of own) {
			const { method } = splitRouteId(id)
			for (const variant of expandOptional((g.records.get(id) as RouteHandler).sg))
				insertLeaf(root, variant, method, id)
			routes[id] = dataOf(snapshot.routes[id] as RouteEntry)
		}
	}
	return { meta: { ...source.meta }, root, routes, v: ROUTE_TREE_VERSION }
}

/**
 * Give `app`'s routes the input and output declarations `source` holds for them where they
 * declare none: a gateway documents each service route by the service's schemas. Its own stay.
 */
export function overlaySchemas(app: App, source: RouteTree): void {
	const g = app[GRAPH]
	for (const [id, entry] of Object.entries(source.routes)) {
		const target = g.records.get(id)
		if (target === undefined) continue
		const live = entry.h as RouteHandler | undefined
		const iv = target.iv ?? entry.iv ?? live?.iv ?? null
		const out = target.out ?? entry.out ?? live?.out ?? null
		g.records.set(id, { ...target, iv, out })
	}
	g.epoch++
}
