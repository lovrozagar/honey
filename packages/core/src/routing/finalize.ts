/**
 * Finalize: resolve every registered route against its graph once, and compile what it runs.
 * A route runs `chain → scopes covering it → route middleware`; its error keys, boundary, error
 * factory and meta come from that chain and the app it was registered on. Re-runs whenever a
 * registration moved the graph's epoch.
 */
import { type HoneyContext, REQUEST, type RouteInfo } from "../context/context.ts"
import { withInput } from "../input/input.ts"
import { compileOutput, outputValidationOn, withOutput } from "../validation/validate-output.ts"
import type { OutputSchemas } from "./output-types.ts"
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
	type Segment,
	type RouteId,
	variantsCoverage,
	splitRouteId,
} from "./pattern.ts"
import { assertNothingDiscarded, chainErrorKeys, type HoneyGraph, type RouteHandler } from "./register.ts"
import { type AppSettings, assertSettingsAgree, type ErrorFactories } from "./settings.ts"
import type { RequestTrace } from "../telemetry/request-trace.ts"
import { answering, firing, tapsFor } from "./tap.ts"
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
	readonly notFound: (nodeOut: boolean) => Response
}

/** What one graph serves. */
export type FinalTable = {
	readonly epoch: number
	readonly miss: Plan
	readonly notFound: ((nodeOut: boolean) => Response) | null
	readonly plans: ReadonlyMap<RouteId, Plan>
	/** method → path → plan, for patterns without params or wildcards */
	readonly statics: Readonly<Record<string, Readonly<Record<string, Plan>>>>
	/** whether any WebSocket route exists: an app without one never reads the Upgrade header */
	readonly ws: boolean
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
function scopesFor(g: HoneyGraph, variants: readonly (readonly Segment[])[]): RuntimeMiddleware[] {
	const out: RuntimeMiddleware[] = []
	for (const entry of g.scoped) {
		const coverage = variantsCoverage(variants, entry.segs)
		if (coverage === "all") out.push(entry.mw)
		else if (coverage === "some") out.push(entry.guard)
	}
	return out
}

/** The runtime's `process`, where there is one (Node, Bun); Workers have none. */
function globalProcess() {
	return (globalThis as { process?: { readonly env?: { readonly NODE_ENV?: string } } }).process
}

/** The request's trace: an app with telemetry traces every request it serves, and only its chains are wrapped. */
function traceOf(ctx: object): RequestTrace {
	return (ctx as HoneyContext<unknown>)[REQUEST].trace as RequestTrace
}

/** `mw` inside a `middleware.<name>` span on a traced request. */
function tracedMiddleware(mw: RuntimeMiddleware): RuntimeMiddleware {
	const name = `middleware.${mw.name || "anonymous"}`
	return (ctx, next) => traceOf(ctx).within(name, () => mw(ctx, next))
}

/** The route handler inside an `http.handler` span, active for the app's own instrumentation. */
function tracedHandler(handler: (ctx: object) => MaybePromise<Response>): (ctx: object) => MaybePromise<Response> {
	return (ctx) => {
		const trace = traceOf(ctx)
		return trace.within("http.handler", (span) => trace.run(span, () => handler(ctx)))
	}
}

function planRoute(
	g: HoneyGraph,
	r: RouteHandler,
	variants: readonly (readonly Segment[])[],
	hooks: FinalizeHooks,
): Plan {
	const src = r.own.errorFactory === null ? g.settings : r.own
	const chain = [...r.cm, ...scopesFor(g, variants), ...r.rm]
	const { errors, policy } = resolveErrors(src, chain, r)
	const meta = routeMeta(chain, r.xm)
	r.mt = meta
	/* only a route with taps pays for them: the handler marks its answer, the chain fires after */
	const taps = tapsFor(g.settings, r.own)
	const traced = g.settings.telemetry !== null
	const run = traced ? chain.map(tracedMiddleware) : chain
	/* only a route with .input() pays for it: the step runs between the middleware and the handler */
	const input = r.in === null ? r.fn : withInput(r.in, r.fn)
	/* only a route with .output() in an app checking answers pays for the check */
	const checked = r.out !== null && outputValidationOn(g.settings.outputValidation, globalProcess())
	const fn = checked ? withOutput(compileOutput(r.out as OutputSchemas), input) : input
	const handler = traced ? tracedHandler(taps === null ? fn : answering(fn)) : taps === null ? fn : answering(fn)
	const compiled = compileChain(run, handler, hooks.convert)
	return {
		cv: r.cv,
		pf: null,
		pfChain: run,
		policy,
		route: { errors, id: r.id, meta: meta ?? EMPTY_META, pattern: r.rp },
		run: taps === null ? compiled : firing(compiled, taps),
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
	const run = g.settings.telemetry === null ? chain : chain.map(tracedMiddleware)
	return {
		cv: null,
		pf: null,
		pfChain: run,
		policy,
		route: { errors, id: "", meta: meta ?? EMPTY_META, pattern: "" },
		run: compileChain(run, hooks.miss, hooks.convert),
	}
}

/** The graph's final table, recompiled only when a registration moved its epoch. */
export function finalize(g: HoneyGraph, hooks: FinalizeHooks): FinalTable {
	if (g.final !== null && g.final.epoch === g.epoch) return g.final
	assertNothingDiscarded(g)
	assertSettingsAgree(g.settings)
	const plans = new Map<RouteId, Plan>()
	const statics: Record<string, Record<string, Plan>> = dict()
	let ws = false
	for (const [id, r] of g.records) {
		const variants = expandOptional(r.sg)
		const plan = planRoute(g, r, variants, hooks)
		plans.set(id, plan)
		const { method } = splitRouteId(id)
		if (method === "WS") ws = true
		for (const variant of variants) {
			if (isStaticPattern(variant)) (statics[method] ??= dict())[canonical(variant)] = plan
		}
	}
	const miss = planMiss(g, hooks)
	g.final = { epoch: g.epoch, miss, notFound: miss.pfChain.length === 0 ? hooks.notFound : null, plans, statics, ws }
	return g.final
}
