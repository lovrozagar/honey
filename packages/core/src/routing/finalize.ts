/**
 * Finalize: resolve every registered route against its graph once, and compile what it runs.
 * A route runs `chain → scopes covering it → route middleware`; its error keys, boundary, error
 * factory and meta come from that chain and the app it was registered on. Re-runs whenever a
 * registration moved the graph's epoch.
 */
import type { RouteInfo } from "../context/context.ts"
import type { ErrorPolicy } from "../errors/projector.ts"
import {
	type ChainErrorConverter,
	type CompiledChain,
	collectMiddlewareMeta,
	compileChain,
	type MaybePromise,
	type RuntimeMiddleware,
} from "../middleware/middleware.ts"
import { commonPrefix } from "./middleware-chain.ts"
import {
	canonical,
	expandOptional,
	isStaticPattern,
	parsePattern,
	type RouteId,
	scopeCoverage,
	splitRouteId,
} from "./pattern.ts"
import { assertNothingDiscarded, chainErrorKeys, type HoneyGraph, type RouteHandler } from "./register.ts"
import type { AppSettings, ErrorFactories } from "./settings.ts"
import { dict } from "./tree.ts"

/** Everything a matched route runs, compiled once. */
export type Plan = {
	/** `.context()` values copied onto each request context */
	readonly cv: Readonly<Record<string, unknown>> | null
	readonly policy: ErrorPolicy
	/** what a CORS preflight for this route runs: the chain without the handler, compiled on first use */
	pf: CompiledChain | null
	readonly pfChain: readonly RuntimeMiddleware[]
	readonly route: RouteInfo
	/** chain + handler; never rejects */
	readonly run: CompiledChain
}

/** What dispatch compiles into every chain: the error boundary and the 404/405 answer. */
export type FinalizeHooks = {
	readonly convert: ChainErrorConverter
	readonly miss: (ctx: object) => MaybePromise<Response>
	/** the fixed 404, for a miss whose chain runs nothing */
	readonly notFound: () => Response
}

/** What one graph serves. */
export type FinalTable = {
	readonly epoch: number
	readonly miss: Plan
	readonly notFound: (() => Response) | null
	readonly plans: ReadonlyMap<RouteId, Plan>
	/** method → path → plan, for patterns without params or wildcards */
	readonly statics: Readonly<Record<string, Readonly<Record<string, Plan>>>>
}

const EMPTY_META: Readonly<Record<string, unknown>> = /* @__PURE__ */ Object.freeze({})

/** Route meta: what the middleware contributes, overlaid by everything stated explicitly. */
function routeMeta(chain: readonly RuntimeMiddleware[], explicit: Readonly<Record<string, unknown>> | null) {
	const contributed = collectMiddlewareMeta([chain])
	if (contributed === null) return explicit === null ? null : Object.freeze({ ...explicit })
	return Object.freeze(explicit === null ? contributed : { ...contributed, ...explicit })
}

type Resolved = { errors: ErrorFactories | null; policy: ErrorPolicy }

/** What a route declares about its errors: its own keys, its boundary and the factory it named. */
type RouteErrors = Pick<RouteHandler, "dk" | "ef" | "rb">

/** The keys a route may throw: the app's defaults, its chain's, its own and its boundary. */
function declaredKeys(
	src: AppSettings<unknown>,
	chain: readonly RuntimeMiddleware[],
	own: ReadonlySet<string>,
	boundaryKey: string | null,
): Set<string> {
	const declared = new Set<string>([...src.defaultErrorKeys, ...chainErrorKeys(chain), ...own])
	if (boundaryKey !== null) declared.add(boundaryKey)
	return declared
}

/**
 * ctx.errors: a frozen copy, so a handler never reaches a factory itself. An open route (nothing
 * declared) gets every key of the app's factory; a declared key comes from the factory the route
 * named, else the app's.
 */
function ctxErrors(
	factory: ErrorFactories | null,
	named: ErrorFactories | null,
	declared: ReadonlySet<string> | null,
): ErrorFactories | null {
	if (factory === null && named === null) return null
	const subset: Record<string, (...args: never[]) => unknown> = Object.create(null)
	if (declared === null) return Object.freeze(Object.assign(subset, factory))
	for (const key of declared) {
		const from = named !== null && Object.hasOwn(named, key) ? named : factory
		if (from !== null && Object.hasOwn(from, key)) subset[key] = from[key]
	}
	return Object.freeze(subset)
}

/** The error keys, boundary and factory a chain resolves to under `src`'s defaults. */
function resolveErrors(
	src: AppSettings<unknown>,
	chain: readonly RuntimeMiddleware[],
	route: RouteErrors | null,
): Resolved {
	const boundaryKey = route?.rb ?? src.defaultBoundaryKey
	const keys = declaredKeys(src, chain, route?.dk ?? new Set(), boundaryKey)
	const declared = keys.size > 0 ? keys : null
	const errors = ctxErrors(src.errorFactory, route?.ef ?? null, declared)
	return { errors, policy: { boundaryKey, declared, factory: src.errorFactory } }
}

/** The scoped middleware a pattern runs: whole where the scope covers it, behind the path check where it covers part. */
function scopesFor(g: HoneyGraph, pattern: string): RuntimeMiddleware[] {
	const segments = parsePattern(pattern)
	const out: RuntimeMiddleware[] = []
	for (const entry of g.scoped) {
		const coverage = scopeCoverage(segments, entry.segs)
		if (coverage === "all") out.push(entry.mw)
		else if (coverage === "some") out.push(entry.guard)
	}
	return out
}

function planRoute(g: HoneyGraph, r: RouteHandler, hooks: FinalizeHooks): Plan {
	const src = r.own.errorFactory === null ? g.settings : r.own
	const chain = [...r.cm, ...scopesFor(g, r.rp), ...r.rm]
	const { errors, policy } = resolveErrors(src, chain, r)
	const meta = routeMeta(chain, r.xm)
	r.mt = meta
	return {
		cv: r.cv,
		pf: null,
		pfChain: chain,
		policy,
		route: { errors, meta: meta ?? EMPTY_META, pattern: r.rp },
		run: compileChain(chain, r.fn, hooks.convert),
	}
}

/**
 * 404 and 405 run through the same pipeline as a route: the middleware every route starts with
 * (with no routes: every handle that served a request), then every scope behind its path check.
 * So an app-wide logger or CORS policy covers unknown paths, and a scope's guard answers before
 * "not found" leaks what exists under it.
 */
function planMiss(g: HoneyGraph, hooks: FinalizeHooks): Plan {
	const chains = [...g.records.values()].map((r) => r.cm)
	const prefix = commonPrefix(chains.length > 0 ? chains : [...g.served])
	const chain = [...prefix, ...g.scoped.map((entry) => entry.guard)]
	const { errors, policy } = resolveErrors(g.settings, chain, null)
	const meta = routeMeta(chain, null)
	return {
		cv: null,
		pf: null,
		pfChain: chain,
		policy,
		route: { errors, meta: meta ?? EMPTY_META, pattern: "" },
		run: compileChain(chain, hooks.miss, hooks.convert),
	}
}

/** The graph's final table, recompiled only when a registration moved its epoch. */
export function finalize(g: HoneyGraph, hooks: FinalizeHooks): FinalTable {
	if (g.final !== null && g.final.epoch === g.epoch) return g.final
	assertNothingDiscarded(g)
	const plans = new Map<RouteId, Plan>()
	const statics: Record<string, Record<string, Plan>> = dict()
	for (const [id, r] of g.records) {
		const plan = planRoute(g, r, hooks)
		plans.set(id, plan)
		const { method, pattern } = splitRouteId(id)
		for (const variant of expandOptional(parsePattern(pattern))) {
			if (isStaticPattern(variant)) (statics[method] ??= dict())[canonical(variant)] = plan
		}
	}
	const miss = planMiss(g, hooks)
	g.final = { epoch: g.epoch, miss, notFound: miss.pfChain.length === 0 ? hooks.notFound : null, plans, statics }
	return g.final
}
