/**
 * Route registration: the app graph every handle of one app shares, the routes and scopes
 * registered into it, and mounting a sub-app. Records are per graph, keyed by `RouteId`; the
 * tree holds ids only, so a sub-app mounted into two parents never shares a record.
 */
import type { InputSchemas, InputStep } from "../input/input.ts"
import type { OutputSchemas } from "./output-types.ts"
import type { MaybePromise, RuntimeMiddleware } from "../middleware/middleware.ts"
import type { FinalizeHooks, FinalTable } from "./finalize.ts"
import { describeMw, errorFactoryOf, errorsOf, scopeGuard } from "./middleware-chain.ts"
import {
	canonical,
	expandOptional,
	joinPatterns,
	normalizePattern,
	parsePattern,
	type RouteId,
	routeId,
	type Segment,
	splitRouteId,
} from "./pattern.ts"
import type { RouteRecord } from "./record.ts"
import { type AppSettings, createSettings, type ErrorFactories } from "./settings.ts"
import { createNode, insertLeaf, type RouteEntry, type TreeNode } from "./tree.ts"

/** An app's graph slot: not exported from the package; finalize readers (tests, codegen) reach the graph through it. */
export const GRAPH: unique symbol = /* @__PURE__ */ Symbol("honey.graph")

/** A registered route: what it was registered with, before finalize resolves it against the graph. */
export type RouteHandler = RouteRecord & {
	/** came with the loaded route tree: a registration of the same route replaces it */
	readonly lt?: true
	/** the chain middleware captured at registration, plus any mounting chain */
	readonly cm: readonly RuntimeMiddleware[]
	/** `.context()` values of the registering handle, merged under the mounting handle's */
	readonly cv: Readonly<Record<string, unknown>> | null
	/** error keys the route declared itself (`.errors()`, `.boundary()`) */
	readonly dk: ReadonlySet<string>
	/** the factory `.errors(factory, ...keys)` named; its keys come from it, not the app's */
	readonly ef: ErrorFactories | null
	readonly fn: (ctx: object) => MaybePromise<Response>
	/** the compiled `.input()` step, run after the middleware and before `fn`; `null` without `.input()` */
	readonly in: InputStep | null
	/** what `.input()` declares, as written: read by documentation, never at dispatch; `null` without it */
	readonly iv: InputSchemas | null
	/** what `.output()` declares, checked at finalize when the app's mode is on; `null` without it */
	readonly out: OutputSchemas | null
	/** the settings of the app the route was registered on */
	readonly own: AppSettings<unknown>
	/** route-level boundary key (`.boundary()`) */
	readonly rb: string | null
	/** route-level middleware (`.get(...).use(mw)`) */
	readonly rm: readonly RuntimeMiddleware[]
	/** explicit meta: chain `.meta()` overlaid by route `.meta()` */
	readonly xm: Readonly<Record<string, unknown>> | null
}

/** What a builder hands over; the graph gives it its id and pattern. */
export type RouteSource = Omit<RouteHandler, "id" | "mt" | "rp" | "sg">

/** One `app.use(mw)`: the handle it returns has to register a route, or `mw` runs nowhere. */
export type ChainNode = { readonly mw: RuntimeMiddleware; readonly parent: ChainNode | null; used: boolean }

/** A route builder still waiting for `.handler()`, reported at finalize. */
export type PendingRoute = { readonly id: string }

/** One path-scoped `use(path, mw)`. */
export type ScopedEntry = {
	/** the middleware behind a request-path check, for routes the scope covers only partly */
	readonly guard: RuntimeMiddleware
	readonly mw: RuntimeMiddleware
	/** canonical full-path pattern, rebased against the handle's basePath */
	readonly prefix: string
	readonly segs: readonly Segment[]
}

export type HoneyGraph = {
	/** root wildcards a loaded app registered outside its tree: what its unserved leaves delegate to */
	readonly catchAll: Map<RouteId, RouteHandler>
	/** every `use(mw)` handle; one that never registers a route is reported at finalize */
	readonly chains: ChainNode[]
	/** bumped by every registration; finalize re-runs when it moves */
	epoch: number
	final: FinalTable | null
	/** the error boundary and miss answer dispatch compiles into every chain, created once */
	hooks: FinalizeHooks | null
	readonly pending: Set<PendingRoute>
	/** the route data of the tree `routeTree()` loaded; `null` while the app builds its own tree */
	loaded: Readonly<Record<RouteId, RouteEntry>> | null
	readonly records: Map<RouteId, RouteHandler>
	root: TreeNode
	/** path-scoped middleware, in registration order */
	readonly scoped: ScopedEntry[]
	/** chains of the handles that served a request: what 404 and 405 run when there are no routes */
	readonly served: Set<readonly RuntimeMiddleware[]>
	readonly settings: AppSettings<unknown>
	/** routes a loaded app registered that its tree lacks: the tree is stale, said at finalize */
	readonly unexpected: RouteId[]
}

/** What one handle contributes to the routes registered or mounted through it. */
export type HandleView = {
	readonly basePath: string
	readonly chain: readonly RuntimeMiddleware[]
	readonly chainMeta: Readonly<Record<string, unknown>> | null
	readonly contextValues: Readonly<Record<string, unknown>> | null
	/** the `use(mw)` call that created this chain; `null` on the root handle */
	readonly node: ChainNode | null
}

export const ROOT_VIEW: HandleView = /* @__PURE__ */ Object.freeze({
	basePath: "/",
	chain: [],
	chainMeta: null,
	contextValues: null,
	node: null,
})

export function createGraph(): HoneyGraph {
	return {
		catchAll: new Map(),
		chains: [],
		epoch: 0,
		final: null,
		hooks: null,
		loaded: null,
		pending: new Set(),
		records: new Map(),
		root: createNode(),
		scoped: [],
		served: new Set(),
		settings: createSettings(),
		unexpected: [],
	}
}

/** Every `use()` on the way to a handle that registers, mounts or serves is in use. */
export function markUsed(node: ChainNode | null): void {
	let at = node
	while (at !== null && !at.used) {
		at.used = true
		at = at.parent
	}
}

/** A new `use(mw)` node under `parent`. */
export function addChain(g: HoneyGraph, parent: ChainNode | null, mw: RuntimeMiddleware): ChainNode {
	const node: ChainNode = { mw, parent, used: false }
	g.chains.push(node)
	return node
}

/** Register one route at every leaf its pattern occupies (an optional last param places two). */
export function addRoute(g: HoneyGraph, method: string, segments: readonly Segment[], source: RouteSource): RouteId {
	const pattern = canonical(segments)
	const id = routeId(method, pattern)
	if (g.records.get(id)?.lt === undefined && (g.records.has(id) || g.catchAll.has(id))) {
		throw new Error(`Duplicate route: ${id}`)
	}
	const record = { ...source, id, mt: null, rp: pattern, sg: segments }
	g.epoch++
	if (g.loaded === null) for (const variant of expandOptional(segments)) insertLeaf(g.root, variant, method, id)
	else if (!Object.hasOwn(g.loaded, id)) {
		/* a loaded app binds the routes its tree holds; a root wildcard it lacks is the catch-all */
		if (segments.length === 1 && segments[0]?.k === "wildcard") g.catchAll.set(id, record)
		else g.unexpected.push(id)
		return id
	}
	g.records.set(id, record)
	return id
}

/** Guard every request path under `path` (rebased on `basePath`) with `mw`, whichever handle registered the route. */
export function addScope(g: HoneyGraph, basePath: string, path: string, mw: RuntimeMiddleware): void {
	const prefix = joinPatterns(basePath, normalizePattern(path))
	const segs = parsePattern(prefix)
	g.scoped.push({ guard: scopeGuard(segs, mw), mw, prefix, segs })
	g.epoch++
}

/** A builder registered or was abandoned on purpose: no longer pending. */
export function settle(g: HoneyGraph, pending: PendingRoute, node: ChainNode | null): void {
	g.pending.delete(pending)
	markUsed(node)
}

/** `use(mw)` handles that never registered, mounted or served, and builders without `.handler()`. */
export function assertNothingDiscarded(g: HoneyGraph): void {
	const problems: string[] = []
	for (const node of g.chains) {
		if (node.used) continue
		problems.push(
			`app.use(${describeMw(node.mw)}) returned a handle that never registers a route, so the middleware runs nowhere. ` +
				"use() does not change the handle it is called on: keep the returned value and register routes on it " +
				"(`const authed = app.use(auth); authed.get(...)`), or chain it (`honey().use(mw).get(...)`).",
		)
	}
	for (const p of g.pending)
		problems.push(`${p.id} was declared but never got a .handler(), so the route is not registered.`)
	if (problems.length > 0) throw new Error(`honey: ${problems.join("\n  ")}`)
}

/**
 * Mount a sub-app: re-register its routes under the view's basePath, with the view's chain running
 * before theirs and its context values and chain meta under theirs. Nothing is shared by
 * reference, so routes the sub registers later stay its own; each record keeps the settings of the
 * app it was registered on. The sub's scopes guard the paths it brought.
 */
export function mount(g: HoneyGraph, view: HandleView, sub: HoneyGraph): void {
	if (sub === g) return
	assertNothingDiscarded(sub)
	const base = view.basePath
	const at = (pattern: string): string => (base === "/" ? pattern : joinPatterns(base, pattern))
	for (const [id, r] of sub.records) {
		const { method, pattern } = splitRouteId(id)
		addRoute(g, method, parsePattern(at(pattern)), {
			...r,
			cm: [...view.chain, ...r.cm],
			cv: view.contextValues ? { ...view.contextValues, ...r.cv } : r.cv,
			xm: view.chainMeta ? { ...view.chainMeta, ...r.xm } : r.xm,
		})
	}
	g.settings.metaSpec.absorbed.push(sub.settings.metaSpec)
	for (const entry of sub.scoped) {
		const prefix = at(entry.prefix)
		if (g.scoped.some((e) => e.mw === entry.mw && e.prefix === prefix)) continue
		const segs = parsePattern(prefix)
		g.scoped.push({ guard: scopeGuard(segs, entry.mw), mw: entry.mw, prefix, segs })
	}
	g.epoch++
}

/** The error keys a middleware chain declares, in run order. */
export function chainErrorKeys(chain: readonly RuntimeMiddleware[]): string[] {
	return chain.flatMap((mw) => errorsOf(mw) ?? [])
}

/** The factories a middleware chain's keys come from, each once, in run order. */
export function chainErrorFactories(chain: readonly RuntimeMiddleware[]): ErrorFactories[] {
	return [...new Set(chain.flatMap((mw) => errorFactoryOf(mw) ?? []))] as ErrorFactories[]
}
