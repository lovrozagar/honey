/**
 * Dispatch-side middleware helpers, run once at finalize: the request-path guard behind a scoped
 * `use()`, and what 404/405 run (the run of middleware every route starts with). Tracing wraps
 * middleware in telemetry/request-trace.ts.
 */
import type { RuntimeMiddleware } from "../middleware/middleware.ts"
import { pathInScope, type Segment } from "./pattern.ts"

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
