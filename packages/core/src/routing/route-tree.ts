/**
 * Route trees in and out. `app.routeTree(tree)` serves a generated tree, another app's snapshot or
 * a `mergeTree()` of them: the tree gives the topology, and each leaf runs the route this app
 * registers for it, else the snapshot's live record, else the app's catch-all (routing/delegate.ts).
 * `app.toRouteTree()` is the snapshot: a copy of the topology and, per route, its resolved data
 * and a live record carrying the scopes that cover it here.
 */
import { compareCodeUnits } from "../schema/canonicalize.ts"
import { finalTable } from "./dispatch.ts"
import { type Plan, scopesFor } from "./finalize.ts"
import { expandOptional } from "./pattern.ts"
import { GRAPH, type HoneyGraph, type RouteHandler } from "./register.ts"
import { SettingsChain } from "./settings-chain.ts"
import {
	assertTreeFormat,
	cloneTree,
	dict,
	forEachLeaf,
	freezeTree,
	ROUTE_TREE_VERSION,
	type RouteEntry,
	type RouteTree,
} from "./tree.ts"

/** Serve `tree` on `g`: frozen in place, its live records copied, the rest bound as routes register. */
export function loadRouteTree(g: HoneyGraph, tree: RouteTree): void {
	assertTreeFormat(tree)
	if (g.loaded !== null) throw new Error("routeTree() was already called on this app")
	const registered = [...g.records.keys(), ...g.catchAll.keys()][0]
	if (registered !== undefined)
		throw new Error(`routeTree() must be called before routes are registered (${registered} is)`)
	forEachLeaf(tree.root, (method, path, id) => {
		if (!Object.hasOwn(tree.routes, id))
			throw new Error(`routeTree(): leaf ${method} ${path} has no route entry (${id})`)
	})
	g.root = freezeTree(tree.root)
	g.loaded = Object.assign(dict<RouteEntry>(), tree.routes)
	for (const [id, entry] of Object.entries(tree.routes)) {
		if (entry.h !== undefined) g.records.set(id, { ...(entry.h as RouteHandler), lt: true })
	}
	g.epoch++
}

/** `g`'s routes as a tree another app serves; nothing in it is shared with `g`. */
export function snapshotRouteTree(g: HoneyGraph): RouteTree {
	const { plans } = finalTable(g)
	const routes = Object.assign(dict<RouteEntry>(), g.loaded)
	for (const [id, r] of g.records) {
		const { policy, route } = plans.get(id) as Plan
		const ek = [...(policy.declared ?? [])].sort(compareCodeUnits)
		/* the record resolves the same way anywhere: its chain carries the scopes covering it here */
		const cm = [...r.cm, ...scopesFor(g, expandOptional(r.sg))]
		const h: RouteHandler = { ...r, cm, dk: new Set(ek), rb: policy.boundaryKey, xm: route.meta }
		routes[id] = { bek: policy.boundaryKey, ek, h, iv: r.iv, mt: route.meta, out: r.out }
	}
	return { meta: {}, root: cloneTree(g.root), routes, v: ROUTE_TREE_VERSION }
}

/** `app.routeTree()` and `app.toRouteTree()`: every app handle has them. */
export abstract class RouteTreeChain<TEnv> extends SettingsChain<TEnv> {
	abstract get [GRAPH](): HoneyGraph

	/**
	 * Serve `tree` (a generated `routes.gen.ts`, a `toRouteTree()` snapshot, or a `mergeTree()` of
	 * them). Call it before registering routes; a route registered afterwards binds to its leaf.
	 */
	routeTree(tree: RouteTree): this {
		loadRouteTree(this[GRAPH], tree)
		return this
	}

	/** A copy of the routes this app serves, for another app to serve with `routeTree()`. */
	toRouteTree(): RouteTree {
		return snapshotRouteTree(this[GRAPH])
	}
}
