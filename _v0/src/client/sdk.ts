import type { ClientConfig, RequestMeta } from "./http.ts"
import { HTTPClient } from "./http.ts"
import { compilePattern, hasPlaceholder, interpolatePartial, interpolatePath } from "./path.ts"
import { createTypedWebSocket } from "./ws.ts"

type ServiceEntry = {
	invalidate?: readonly string[]
	method: string
	params?: readonly string[]
	path: string
	sse?: boolean
	ws?: boolean
}

type ServiceMapNode = ServiceEntry | { [key: string]: ServiceMapNode }
type ServiceMap = { [key: string]: ServiceMapNode }

export type InvalidationConfig = {
	staleTime: number
}

export type SDKConfig = ClientConfig & {
	invalidation?: InvalidationConfig
}

/* bridge generic — Proxy target is object, return type is T (erased at runtime) */
function bridge<T>(value: object): T {
	return value as T
}

function own<T>(record: Record<string, T>, key: string): T | undefined {
	return Object.hasOwn(record, key) ? record[key] : undefined
}

/**
 * Resolve invalidation targets by substituting the mutation's params. Params that are absent
 * stay placeholders, so a partially resolved target is a narrower pattern, never dropped:
 * `PUT /orgs/{org}` invalidating `GET /orgs/:org/members/:id` marks `GET /orgs/acme/members/:id`.
 */
export function resolveInvalidationTargets(
	targets: readonly string[],
	params: Record<string, string> | undefined,
): string[] {
	const resolved: string[] = []
	for (const target of targets) {
		const spaceIdx = target.indexOf(" ")
		if (spaceIdx === -1 || !params) {
			resolved.push(target)
			continue
		}
		const targetMethod = target.slice(0, spaceIdx)
		const targetPath = target.slice(spaceIdx + 1)
		try {
			resolved.push(`${targetMethod} ${interpolatePartial(targetPath, params)}`)
		} catch {
			/* a param value that is not a path segment cannot address a resource; keep the pattern */
			resolved.push(target)
		}
	}
	return resolved
}

/** Test if a concrete path matches a route pattern (`:name`, `{name}`, `*`); literal text is escaped. */
export function pathMatchesPattern(concretePath: string, pattern: string): boolean {
	return compilePattern(pattern).test(concretePath)
}

/* Bound memory: an entry remembers the last N mutations that marked it, and which concrete
   paths have already refreshed against a pattern-level mark. */
const MAX_INVALIDATED_BY = 32
const MAX_REFRESHED = 1024

type StaleEntry = {
	by: Set<string>
	/** Concrete paths that have read once since this pattern was marked (pattern entries only). */
	refreshed?: Set<string>
	seq: number
	until: number
}

/**
 * Stale marks, split by kind so a concrete key is never re-read as a pattern (a path may
 * contain `:`), and a lookup scans only patterns for its own method.
 */
export class StaleIndex {
	readonly exact = new Map<string, StaleEntry>()
	readonly patterns = new Map<string, Map<string, StaleEntry>>()

	mark(target: string, mutation: string, seq: number, until: number): void {
		const spaceIdx = target.indexOf(" ")
		const method = target.slice(0, spaceIdx)
		const path = target.slice(spaceIdx + 1)
		const isPattern = hasPlaceholder(path)
		let table: Map<string, StaleEntry>
		if (isPattern) {
			table = this.patterns.get(method) ?? new Map()
			this.patterns.set(method, table)
		} else {
			table = this.exact
		}
		const existing = table.get(target)
		if (existing) {
			existing.by.delete(mutation)
			existing.by.add(mutation)
			if (existing.by.size > MAX_INVALIDATED_BY) {
				const oldest = existing.by.values().next().value
				if (oldest !== undefined) existing.by.delete(oldest)
			}
			existing.until = until
			existing.seq = seq
			/* a new mutation re-marks every instance */
			if (existing.refreshed) existing.refreshed.clear()
		} else {
			table.set(target, { by: new Set([mutation]), refreshed: isPattern ? new Set() : undefined, seq, until })
		}
	}

	lookup(
		concreteSelector: string,
		concretePath: string,
		method: string,
		now: number,
	): { by: string[]; isStale: boolean } {
		const by = new Set<string>()
		const exact = this.exact.get(concreteSelector)
		if (exact) {
			if (exact.until > now) for (const m of exact.by) by.add(m)
			else this.exact.delete(concreteSelector)
		}
		const table = this.patterns.get(method)
		if (table) {
			for (const [key, entry] of table) {
				if (entry.until <= now) {
					table.delete(key)
					continue
				}
				if (entry.refreshed?.has(concretePath)) continue
				if (pathMatchesPattern(concretePath, key.slice(key.indexOf(" ") + 1))) {
					for (const m of entry.by) by.add(m)
				}
			}
		}
		return { by: [...by], isStale: by.size > 0 }
	}

	/**
	 * A successful stale read clears the mark for that resource only: the exact entry, and this
	 * concrete path's share of any pattern entry. Marks newer than the read's snapshot stay.
	 */
	clear(concreteSelector: string, concretePath: string, method: string, snapshot: number): void {
		const exact = this.exact.get(concreteSelector)
		if (exact && exact.seq <= snapshot) this.exact.delete(concreteSelector)
		const table = this.patterns.get(method)
		if (!table) return
		for (const [key, entry] of table) {
			if (entry.seq > snapshot || !entry.refreshed) continue
			if (!pathMatchesPattern(concretePath, key.slice(key.indexOf(" ") + 1))) continue
			if (entry.refreshed.size >= MAX_REFRESHED) {
				const oldest = entry.refreshed.values().next().value
				if (oldest !== undefined) entry.refreshed.delete(oldest)
			}
			entry.refreshed.add(concretePath)
		}
	}
}

/**
 * Two-tier stale lookup over a flat map (kept for compatibility): exact concrete match, then
 * pattern entries for the same method. Keys are classified by their template placeholders,
 * not by containing `:`. Expired entries are swept.
 */
export function lookupStale(
	staleMap: Map<string, { by: string[]; seq: number; until: number }>,
	concreteSelector: string,
	concretePath: string,
	method: string,
	now: number,
): { by: string[]; isStale: boolean } {
	const allBy = new Set<string>()
	for (const [key, entry] of staleMap) {
		if (entry.until <= now) {
			staleMap.delete(key)
			continue
		}
		if (key === concreteSelector) {
			for (const m of entry.by) allBy.add(m)
			continue
		}
		const spaceIdx = key.indexOf(" ")
		if (key.slice(0, spaceIdx) !== method) continue
		const keyPattern = key.slice(spaceIdx + 1)
		if (hasPlaceholder(keyPattern) && pathMatchesPattern(concretePath, keyPattern)) {
			for (const m of entry.by) allBy.add(m)
		}
	}
	return { by: [...allBy], isStale: allBy.size > 0 }
}

function isServiceEntry(node: unknown): node is ServiceEntry {
	return (
		typeof node === "object" &&
		node !== null &&
		typeof (node as Record<string, unknown>)["method"] === "string" &&
		typeof (node as Record<string, unknown>)["path"] === "string"
	)
}

export function createSDK<T = Record<string, Record<string, (...args: unknown[]) => unknown>>>(
	serviceMap: ServiceMap,
	config: SDKConfig,
): T {
	const http = new HTTPClient(config)
	const staleTime = config.invalidation?.staleTime ?? 0
	const stale = staleTime > 0 ? new StaleIndex() : null

	let invalidationSeq = 0

	const rootCache = new Map<string, object>()

	function buildLeafFn(entry: ServiceEntry, namePath: string[]): Function {
		/* Paths keep their template; HTTPClient interpolates `{name}` and `:name` alike. */
		const path = entry.path
		const method = entry.method
		let fn: Function

		if (entry.ws) {
			fn = (input?: Record<string, unknown>) => {
				const opts = {
					params: input?.["params"] as Record<string, string> | undefined,
					search: input?.["search"] as Record<string, unknown> | undefined,
				}
				let url = http.buildWSUrl(path, opts)
				const reconnectToken = input?.["reconnectToken"] as string | undefined
				if (reconnectToken) {
					const sep = url.includes("?") ? "&" : "?"
					url = `${url}${sep}reconnect_token=${encodeURIComponent(reconnectToken)}`
				}
				return createTypedWebSocket(url, {
					protocols: input?.["protocols"] as string | string[] | undefined,
				})
			}
		} else if (entry.sse) {
			fn = (input?: Record<string, unknown>) => http.requestStream(method, path, input ?? {})
		} else {
			fn = async (input?: Record<string, unknown>) => {
				const opts = input ?? {}
				const params = opts["params"] as Record<string, string> | undefined
				const concretePath = interpolatePath(path, params ?? {})
				const concreteSelector = `${method} ${concretePath}`
				let requestMeta: RequestMeta | undefined

				if (stale) {
					const { by, isStale } = stale.lookup(concreteSelector, concretePath, method, Date.now())
					requestMeta = { invalidatedBy: by, isStale, selector: concreteSelector, seqSnapshot: invalidationSeq }
				}

				const result =
					config.throwOnError === true
						? await http.request(method, path, opts, requestMeta)
						: await http.requestSafe(method, path, opts, requestMeta)

				if (stale) {
					const isSuccess =
						config.throwOnError === true
							? true
							: (result as { status: number }).status >= 200 && (result as { status: number }).status < 300

					if (isSuccess) {
						if (entry.invalidate && entry.invalidate.length > 0) {
							const seq = ++invalidationSeq
							const until = Date.now() + staleTime
							for (const target of resolveInvalidationTargets(entry.invalidate, params)) {
								stale.mark(target, concreteSelector, seq, until)
							}
						}

						if (requestMeta?.isStale) {
							stale.clear(concreteSelector, concretePath, method, requestMeta.seqSnapshot)
						}
					}
				}

				return result
			}
		}

		Object.defineProperty(fn, "name", { value: namePath.join(".") })
		return fn
	}

	/** Own keys only: names like `toString` or `constructor` must not resolve through the prototype. */
	function resolveChild(node: Record<string, unknown>, key: string | symbol, namePath: string[]): unknown {
		if (typeof key === "symbol" || key === "then") return undefined
		const child = own(node, key)
		if (child === undefined) {
			if (key === "toString" || key === "toJSON")
				return () => `[object HoneySDK${namePath.length ? ` ${namePath.join(".")}` : ""}]`
			return undefined
		}
		return child
	}

	function makeNodeProxy(node: ServiceMapNode, namePath: string[]): object {
		const actionCache = new Map<string, Function>()
		const childCache = new Map<string, object>()
		return new Proxy({} as Record<string, unknown>, {
			get(_, key: string | symbol) {
				const child = resolveChild(node as Record<string, unknown>, key, namePath)
				if (child === undefined || typeof child === "function") return child
				const name = key as string

				if (isServiceEntry(child)) {
					const cached = actionCache.get(name)
					if (cached) return cached
					const fn = buildLeafFn(child, [...namePath, name])
					actionCache.set(name, fn)
					return fn
				}

				const cached = childCache.get(name)
				if (cached) return cached
				const childProxy = makeNodeProxy(child as ServiceMapNode, [...namePath, name])
				childCache.set(name, childProxy)
				return childProxy
			},
		})
	}

	return bridge<T>(
		new Proxy(
			{},
			{
				get(_target, key: string | symbol) {
					const node = resolveChild(serviceMap as Record<string, unknown>, key, [])
					if (node === undefined || typeof node === "function") return node
					const name = key as string

					const cached = rootCache.get(name)
					if (cached) return cached

					const result = isServiceEntry(node)
						? (buildLeafFn(node, [name]) as unknown as object)
						: makeNodeProxy(node as ServiceMapNode, [name])

					rootCache.set(name, result)
					return result
				},
			},
		),
	)
}
