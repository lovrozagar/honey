/**
 * Dispatch-side middleware helpers, run once at finalize: the request-path guard behind a scoped
 * `use()`, the telemetry wrapper, and what 404/405 run (the run of middleware every route starts
 * with).
 */
import type { MaybePromise, RuntimeMiddleware } from "../middleware/middleware.ts"
import { pathInScope, type Segment } from "./pattern.ts"

/** One middleware's run, as telemetry sees it. */
export type MiddlewareSample = { duration: number; error?: unknown; name: string }

/** The error keys a middleware declares (`defineMiddleware`). */
export function errorsOf(mw: RuntimeMiddleware): readonly string[] | undefined {
	return (mw as { errors?: readonly string[] }).errors
}

/** A scoped middleware behind a request-path check: it runs only when the path is inside the scope. */
export function scopeGuard(segs: readonly Segment[], mw: RuntimeMiddleware): RuntimeMiddleware {
	const guard: RuntimeMiddleware = (ctx, next) => (pathInScope(ctx.path as string, segs) ? mw(ctx, next) : next())
	Object.defineProperty(guard, "name", { configurable: true, value: mw.name })
	const errors = errorsOf(mw)
	const meta = (mw as { meta?: Readonly<Record<string, unknown>> }).meta
	if (errors) Object.defineProperty(guard, "errors", { value: errors })
	if (meta) Object.defineProperty(guard, "meta", { value: meta })
	return guard
}

/** Report a sample; a failing reporter never breaks the request. */
function fire(report: (sample: MiddlewareSample) => void, sample: MiddlewareSample): void {
	try {
		report(sample)
	} catch {
		/* telemetry must not crash the request */
	}
}

/**
 * Wrap a middleware so telemetry sees its own duration and its own throw. Built once at finalize.
 * A middleware that answered synchronously stays synchronous.
 */
export function timedMiddleware(mw: RuntimeMiddleware, report: (sample: MiddlewareSample) => void): RuntimeMiddleware {
	const name = mw.name || "anonymous"
	return (ctx, next) => {
		const start = performance.now()
		let out: MaybePromise<Response>
		try {
			out = mw(ctx, next)
		} catch (error) {
			fire(report, { duration: performance.now() - start, error, name })
			throw error
		}
		if (!(out instanceof Promise)) {
			fire(report, { duration: performance.now() - start, name })
			return out
		}
		return out.then(
			(res) => {
				fire(report, { duration: performance.now() - start, name })
				return res
			},
			(error: unknown) => {
				fire(report, { duration: performance.now() - start, error, name })
				throw error
			},
		)
	}
}

/** The longest run of middleware every chain starts with: what 404 and 405 run. */
export function commonPrefix(chains: ReadonlyArray<readonly RuntimeMiddleware[]>): RuntimeMiddleware[] {
	const [first, ...rest] = chains
	if (first === undefined) return []
	let n = first.length
	for (const chain of rest) {
		let i = 0
		while (i < n && i < chain.length && chain[i] === first[i]) i++
		n = i
	}
	return first.slice(0, n)
}

export function describeMw(mw: RuntimeMiddleware): string {
	return mw.name ? `"${mw.name}"` : "an anonymous middleware"
}
