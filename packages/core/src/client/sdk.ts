import type { ClientConfig, RequestMeta } from "./http.ts"
import { HTTPClient, interpolatePath } from "./http.ts"
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

/* convert OpenAPI {param} to :param for HTTPClient */
function toColonParams(path: string): string {
	return path.replace(/\{(\w+)\}/g, ":$1")
}

/* resolve invalidation targets by substituting mutation params */
export function resolveInvalidationTargets(
	targets: readonly string[],
	params: Record<string, string> | undefined,
): string[] {
	const resolved: string[] = []
	for (const target of targets) {
		if (!params || !target.includes(":")) {
			resolved.push(target)
			continue
		}
		const spaceIdx = target.indexOf(" ")
		const targetMethod = target.slice(0, spaceIdx)
		const targetPath = target.slice(spaceIdx + 1)
		let hasUnresolved = false
		const replaced = targetPath.replace(/:(\w+)/g, (match, key: string) => {
			const val = params[key]
			if (val === undefined) {
				hasUnresolved = true
				return match
			}
			return encodeURIComponent(val)
		})
		if (hasUnresolved) continue
		resolved.push(`${targetMethod} ${replaced}`)
	}
	return resolved
}

/* cache compiled pattern regexes — hot path for invalidation lookups */
const patternRegexCache = new Map<string, RegExp>()

/* test if a concrete path matches a route pattern; escapes regex metacharacters in the pattern */
export function pathMatchesPattern(concretePath: string, pattern: string): boolean {
	let re = patternRegexCache.get(pattern)
	if (!re) {
		/* split on :param placeholders, escape each literal segment's metachars, rejoin with [^/]+ */
		const parts = pattern.split(/:[^/]+/g)
		const escaped = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+")
		re = new RegExp(`^${escaped}$`)
		patternRegexCache.set(pattern, re)
	}
	return re.test(concretePath)
}

/* two-tier stale lookup: exact concrete match, then pattern fallback; sweeps expired entries in one pass */
export function lookupStale(
	staleMap: Map<string, { by: string[]; seq: number; until: number }>,
	concreteSelector: string,
	concretePath: string,
	method: string,
	now: number,
): { by: string[]; isStale: boolean } {
	const allBy: string[] = []
	const expired: string[] = []

	const exact = staleMap.get(concreteSelector)
	if (exact && exact.until > now) allBy.push(...exact.by)
	else if (exact) expired.push(concreteSelector)

	for (const [key, entry] of staleMap) {
		if (entry.until <= now) {
			expired.push(key)
			continue
		}
		if (!key.includes(":")) continue
		const spaceIdx = key.indexOf(" ")
		const keyMethod = key.slice(0, spaceIdx)
		const keyPattern = key.slice(spaceIdx + 1)
		if (keyMethod !== method) continue
		if (pathMatchesPattern(concretePath, keyPattern)) {
			allBy.push(...entry.by)
		}
	}
	for (const key of expired) staleMap.delete(key)

	return { by: [...new Set(allBy)], isStale: allBy.length > 0 }
}

export function createSDK<T = Record<string, Record<string, (...args: unknown[]) => unknown>>>(
	serviceMap: ServiceMap,
	config: SDKConfig,
): T {
	const http = new HTTPClient(config)
	const staleTime = config.invalidation?.staleTime ?? 0
	const hasInvalidation = staleTime > 0
	const staleUntil = hasInvalidation ? new Map<string, { by: string[]; seq: number; until: number }>() : null

	let invalidationSeq = 0

	const rootCache = new Map<string, object>()

	function buildLeafFn(entry: ServiceEntry, namePath: string[]): Function {
		const path = toColonParams(entry.path)
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
				const concretePath = params ? interpolatePath(path, params) : path
				const concreteSelector = `${method} ${concretePath}`
				let requestMeta: RequestMeta | undefined

				if (staleUntil) {
					const now = Date.now()
					const { by, isStale } = lookupStale(staleUntil, concreteSelector, concretePath, method, now)
					requestMeta = { invalidatedBy: by, isStale, selector: concreteSelector, seqSnapshot: invalidationSeq }
				}

				const result =
					config.throwOnError === true
						? await http.request(method, path, opts, requestMeta)
						: await http.requestSafe(method, path, opts, requestMeta)

				if (staleUntil) {
					const isSuccess =
						config.throwOnError === true
							? true
							: (result as { status: number }).status >= 200 && (result as { status: number }).status < 300

					if (isSuccess) {
						if (entry.invalidate && entry.invalidate.length > 0) {
							const seq = ++invalidationSeq
							const until = Date.now() + staleTime
							const mutationSelector = concreteSelector
							const resolved = resolveInvalidationTargets(entry.invalidate, params)
							for (const target of resolved) {
								const existing = staleUntil.get(target)
								if (existing) {
									if (!existing.by.includes(mutationSelector)) existing.by.push(mutationSelector)
									existing.until = until
									existing.seq = seq
								} else {
									staleUntil.set(target, { by: [mutationSelector], seq, until })
								}
							}
						}

						if (requestMeta?.isStale) {
							const snapshot = requestMeta.seqSnapshot
							const exact = staleUntil.get(concreteSelector)
							if (exact && exact.seq <= snapshot) staleUntil.delete(concreteSelector)
							const toDelete: string[] = []
							for (const [key, staleEntry] of staleUntil) {
								if (staleEntry.seq > snapshot) continue
								if (!key.includes(":")) continue
								const spaceIdx = key.indexOf(" ")
								const keyMethod = key.slice(0, spaceIdx)
								const keyPattern = key.slice(spaceIdx + 1)
								if (keyMethod === method && pathMatchesPattern(concretePath, keyPattern)) toDelete.push(key)
							}
							for (const key of toDelete) staleUntil.delete(key)
						}
					}
				}

				return result
			}
		}

		Object.defineProperty(fn, "name", { value: namePath.join(".") })
		return fn
	}

	function makeNodeProxy(node: ServiceMapNode, namePath: string[]): object {
		const actionCache = new Map<string, Function>()
		const childCache = new Map<string, object>()
		return new Proxy({} as Record<string, unknown>, {
			get(_, key: string | symbol) {
				if (typeof key === "symbol") return undefined
				const child = (node as Record<string, unknown>)[key]
				if (child === undefined) return undefined

				if (typeof (child as Record<string, unknown>)["method"] === "string") {
					const cached = actionCache.get(key)
					if (cached) return cached
					const fn = buildLeafFn(child as ServiceEntry, [...namePath, key])
					actionCache.set(key, fn)
					return fn
				}

				const cached = childCache.get(key)
				if (cached) return cached
				const childProxy = makeNodeProxy(child as ServiceMapNode, [...namePath, key])
				childCache.set(key, childProxy)
				return childProxy
			},
		})
	}

	return bridge<T>(
		new Proxy(
			{},
			{
				get(_target, key: string | symbol) {
					if (typeof key === "symbol") return undefined

					const cached = rootCache.get(key as string)
					if (cached) return cached

					const node = serviceMap[key as string]
					if (node === undefined) return undefined

					let result: object
					if (typeof (node as Record<string, unknown>)["method"] === "string") {
						const fn = buildLeafFn(node as ServiceEntry, [key as string])
						result = fn as unknown as object
					} else {
						result = makeNodeProxy(node, [key as string])
					}

					rootCache.set(key as string, result)
					return result
				},
			},
		),
	)
}
