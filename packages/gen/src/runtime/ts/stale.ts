import { compilePattern, hasPlaceholder, interpolatePartial } from "./path.ts"

/**
 * Resolve invalidation targets by substituting the mutation's params. Params that are absent stay
 * placeholders, so a partially resolved target is a narrower pattern, never dropped: `PUT
 * /orgs/{org}` invalidating `GET /orgs/:org/members/:id` marks `GET /orgs/acme/members/:id`.
 */
export function resolveInvalidationTargets(
	targets: readonly string[],
	params: Record<string, string> | undefined,
): string[] {
	return targets.map((target) => {
		const space = target.indexOf(" ")
		if (space === -1 || !params) return target
		try {
			return `${target.slice(0, space)} ${interpolatePartial(target.slice(space + 1), params)}`
		} catch {
			/* a param value that is not a path segment cannot address a resource; keep the pattern */
			return target
		}
	})
}

/* Bound memory: which concrete paths have already refreshed against a pattern-level mark, and the
   compiled patterns, are capped; the marks and their sources are capped by `StaleLimits`. */
const MAX_REFRESHED = 1024
const MAX_PATTERNS = 1024

type StaleEntry = {
	by: Set<string>
	/** concrete paths that have read once since this pattern was marked (pattern entries only) */
	refreshed?: Set<string>
	seq: number
	until: number
}

/** Drop the oldest value of an insertion-ordered set once it holds `max`. */
function capped<T>(set: Set<T>, max: number): void {
	if (set.size < max) return
	const oldest = set.values().next().value
	if (oldest !== undefined) set.delete(oldest)
}

/** How many exact marks the index keeps, and how many mutations each mark remembers. */
export type StaleLimits = { maxEntries: number; maxSources: number }

/**
 * Stale marks, split by kind so a concrete key is never re-read as a pattern (a path may contain
 * `:`), and a lookup scans only patterns for its own method.
 */
export class StaleIndex {
	readonly exact = new Map<string, StaleEntry>()
	readonly patterns = new Map<string, Map<string, StaleEntry>>()
	readonly #compiled = new Map<string, RegExp>()
	readonly #limits: StaleLimits

	constructor(limits: StaleLimits) {
		this.#limits = limits
	}

	/** Whether `path` matches the route pattern `pattern` (`:name`, `{name}`, `*`), literal text escaped. */
	matches(path: string, pattern: string): boolean {
		let re = this.#compiled.get(pattern)
		if (re === undefined) {
			if (this.#compiled.size >= MAX_PATTERNS) this.#compiled.delete(this.#compiled.keys().next().value as string)
			re = compilePattern(pattern)
			this.#compiled.set(pattern, re)
		}
		return re.test(path)
	}

	/** Mark `target` stale on behalf of `mutation`, until `at.until`. */
	mark(target: string, mutation: string, at: { now: number; seq: number; until: number }): void {
		const { seq, until } = at
		const space = target.indexOf(" ")
		const method = target.slice(0, space)
		const isPattern = hasPlaceholder(target.slice(space + 1))
		let table = this.exact
		if (isPattern) {
			table = this.patterns.get(method) ?? new Map()
			this.patterns.set(method, table)
		}
		const existing = table.get(target)
		if (!existing) {
			table.set(target, { by: new Set([mutation]), refreshed: isPattern ? new Set() : undefined, seq, until })
			if (!isPattern) this.#bound(at.now)
			return
		}
		existing.by.delete(mutation)
		capped(existing.by, this.#limits.maxSources)
		existing.by.add(mutation)
		existing.until = until
		existing.seq = seq
		/* a new mutation re-marks every instance */
		existing.refreshed?.clear()
	}

	/** Past `maxEntries` exact marks, drop the expired ones, then the oldest live ones. */
	#bound(now: number): void {
		const { maxEntries } = this.#limits
		if (this.exact.size <= maxEntries) return
		for (const [key, entry] of this.exact) if (entry.until <= now) this.exact.delete(key)
		for (const key of this.exact.keys()) {
			if (this.exact.size <= maxEntries) return
			this.exact.delete(key)
		}
	}

	lookup(selector: string, path: string, method: string, now: number): { by: string[]; isStale: boolean } {
		const by = new Set<string>()
		const exact = this.exact.get(selector)
		if (exact && exact.until > now) for (const m of exact.by) by.add(m)
		else if (exact) this.exact.delete(selector)
		for (const [key, entry] of this.patterns.get(method) ?? []) {
			if (entry.until <= now) this.patterns.get(method)?.delete(key)
			else if (!entry.refreshed?.has(path) && this.matches(path, key.slice(key.indexOf(" ") + 1))) {
				for (const m of entry.by) by.add(m)
			}
		}
		return { by: [...by], isStale: by.size > 0 }
	}

	/**
	 * A successful stale read clears the mark for that resource only: the exact entry, and this
	 * concrete path's share of any pattern entry. Marks newer than the read's snapshot stay.
	 */
	clear(selector: string, path: string, method: string, snapshot: number): void {
		const exact = this.exact.get(selector)
		if (exact && exact.seq <= snapshot) this.exact.delete(selector)
		for (const [key, entry] of this.patterns.get(method) ?? []) {
			if (entry.seq > snapshot || !entry.refreshed) continue
			if (!this.matches(path, key.slice(key.indexOf(" ") + 1))) continue
			capped(entry.refreshed, MAX_REFRESHED)
			entry.refreshed.add(path)
		}
	}
}
