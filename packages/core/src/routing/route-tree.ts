/**
 * Route trees in and out. `app.routeTree(tree)` is a new app serving a generated tree, another app's snapshot or
 * a `mergeTree()` of them: the tree gives the topology, and each leaf runs the route the app registered for it, before
 * the call or after, else the snapshot's live record, else the app's catch-all (routing/delegate.ts).
 * `app.toRouteTree()` is the snapshot: a copy of the topology and, per route, its resolved data
 * and a live record carrying the scopes that cover it here.
 */
import { ERROR_META, type ErrorMetaEntry } from "../errors/errors.ts"
import { compareCodeUnits } from "../schema/canonicalize.ts"
import { finalTable } from "./dispatch.ts"
import { type Plan, scopesFor } from "./finalize.ts"
import { expandOptional, splitRouteId } from "./pattern.ts"
import {
	addRoute,
	chainErrorFactories,
	createGraph,
	GRAPH,
	type HoneyGraph,
	isServed,
	type RouteHandler,
} from "./register.ts"
import { copySettings, type ErrorFactories } from "./settings.ts"
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
import { declaredBody } from "../validation/content-type.ts"

/**
 * A new graph serving `tree`, frozen in place with its live records copied: `g`'s settings copied, its scopes, and
 * every route `g` registered replayed onto the tree, as later registrations bind. A tree `g` loaded is left behind.
 */
export function routeTreeGraph(g: HoneyGraph, tree: RouteTree): HoneyGraph {
	assertTreeFormat(tree)
	forEachLeaf(tree.root, (method, path, id) => {
		if (!Object.hasOwn(tree.routes, id))
			throw new Error(`routeTree(): leaf ${method} ${path} has no route entry (${id})`)
	})
	const next: HoneyGraph = { ...createGraph(), scoped: [...g.scoped], settings: copySettings(g.settings) }
	next.root = freezeTree(tree.root)
	next.loaded = Object.assign(dict<RouteEntry>(), tree.routes)
	for (const [id, entry] of Object.entries(tree.routes)) {
		if (entry.h !== undefined) next.records.set(id, { ...(entry.h as RouteHandler), lt: true })
	}
	for (const r of [...g.records.values(), ...g.catchAll.values(), ...g.unexpected.values()]) {
		if (r.lt === true) continue
		addRoute(next, splitRouteId(r.id).method, r.sg, r.own === g.settings ? { ...r, own: next.settings } : r)
	}
	return next
}

/** Each key's status key from the first factory whose ERROR_META knows it; `null` when none does. */
function statusKeysOf(
	keys: readonly string[],
	factories: readonly (ErrorFactories | null)[],
): Record<string, string> | null {
	const out: Record<string, string> = {}
	for (const key of keys) {
		const meta = factories
			.map((f) => (f as { [ERROR_META]?: Record<string, ErrorMetaEntry> } | null)?.[ERROR_META])
			.find((m) => m !== undefined && Object.hasOwn(m, key))
		if (meta !== undefined) out[key] = (meta[key] as ErrorMetaEntry).statusKey
	}
	return Object.keys(out).length === 0 ? null : out
}

/** `g`'s routes as a tree another app serves; nothing in it is shared with `g`. */
export function snapshotRouteTree(g: HoneyGraph): RouteTree {
	const { plans } = finalTable(g)
	const routes = Object.assign(dict<RouteEntry>(), g.loaded)
	const served = new Set<string>()
	for (const [id, r] of g.records) {
		/* an app's served routes are its own: an app loading the tree registers its own */
		if (isServed(r)) {
			served.add(id)
			continue
		}
		const { mw, policy, route } = plans.get(id) as Plan
		const ek = [...(policy.declared ?? [])].sort(compareCodeUnits)
		/* the record resolves the same way anywhere: its chain carries the scopes covering it here */
		const cm = [...r.cm, ...scopesFor(g, expandOptional(r.sg))]
		const h: RouteHandler = { ...r, cm, dk: new Set(ek), rb: policy.boundaryKey, xm: route.meta }
		const es = statusKeysOf(ek, [r.ef, ...chainErrorFactories(mw), r.own.errorFactory])
		const bd = declaredBody(r.iv)
		routes[id] = {
			...(bd === null ? {} : { bd }),
			bek: policy.boundaryKey,
			ek,
			...(es === null ? {} : { es }),
			h,
			iv: r.iv,
			mt: route.meta,
			out: r.out,
		}
	}
	return { meta: {}, root: cloneTree(g.root, (id) => !served.has(id)), routes, v: ROUTE_TREE_VERSION }
}

/** `app.routeTree()` and `app.toRouteTree()`: every app handle has them. */
export abstract class RouteTreeChain<TEnv> extends SettingsChain<TEnv> {
	abstract get [GRAPH](): HoneyGraph

	/** This handle's view on `graph`: the app `routeTree()` returns. */
	protected abstract onGraph(graph: HoneyGraph): this

	/**
	 * A new app serving `tree` (a generated `routes.gen.ts`, a `toRouteTree()` snapshot, or a `mergeTree()` of them):
	 * this app's settings, routes and scopes, and this handle's chain, on the tree. Call it at any point; a route
	 * registered on the new app binds to its leaf, and this app stays as it was.
	 */
	routeTree(tree: RouteTree): this {
		return this.onGraph(routeTreeGraph(this[GRAPH], tree))
	}

	/** A copy of the routes this app serves, for another app to serve with `routeTree()`. */
	toRouteTree(): RouteTree {
		return snapshotRouteTree(this[GRAPH])
	}
}
