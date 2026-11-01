/**
 * Turning a service map into query keys (bit 22): which entries are readable, how a route selector and a
 * `{param}` path meet at one spelling, and what key a read is cached under. One body of knowledge — an
 * `x-invalidate` target names a route and a key names a member path, and this is the only place that
 * crosses between them. `query.ts` holds the surfaces that use it.
 */
import type { QueryKey } from "@tanstack/query-core"
import type { ServiceEntry, ServiceMap } from "../ts/sdk.ts"

/** The one method a cache reads from; every other method is a write. */
export const READ = "GET"

export function isEntry(node: unknown): node is ServiceEntry {
	return (
		typeof node === "object" &&
		node !== null &&
		Object.hasOwn(node, "method") &&
		typeof (node as ServiceEntry).method === "string" &&
		Object.hasOwn(node, "path")
	)
}

/** A stream or a connection is not a cache entry, so it is in no surface. */
export function isStream(entry: ServiceEntry): boolean {
	return entry.sse !== undefined || entry.ws === true || entry.realtime === true
}

/** Only an own key is an operation: never `toString`, `constructor` or `then`. */
export function childOf(node: ServiceMap | ServiceEntry, key: string): ServiceMap | ServiceEntry | undefined {
	return Object.hasOwn(node, key) ? (node as Record<string, ServiceMap | ServiceEntry>)[key] : undefined
}

/** `/orgs/{id}` → `/orgs/:id`, so a `{param}` path and a `:param` selector meet at one spelling. */
function normalizePath(path: string): string {
	return path
		.split("/")
		.map((segment) => {
			const braced = /^\{([^{}/]+)\}$/.exec(segment)
			return braced === null ? segment : `:${braced[1] as string}`
		})
		.join("/")
}

/** `GET /orgs/{id}` and `get /orgs/:id` normalize alike; a selector with no space has no method. */
function normalizeSelector(selector: string): string | undefined {
	const space = selector.indexOf(" ")
	if (space <= 0) return undefined
	return `${selector.slice(0, space).toUpperCase()} ${normalizePath(selector.slice(space + 1))}`
}

export type Read = { member: string[]; params: readonly string[] }

/**
 * Every readable entry by its normalized selector. An `x-invalidate` target names a route, and a query key
 * names a member path and its params, so this is the one table that turns one into the other. Built once
 * per helper set: a map walk per mutation would be the O(n) cost this avoids.
 */
export function indexReads(map: ServiceMap): Map<string, Read> {
	const reads = new Map<string, Read>()
	const walk = (node: ServiceMap, member: string[]): void => {
		for (const key of Object.keys(node)) {
			const child = childOf(node, key)
			if (child === undefined) continue
			if (!isEntry(child)) {
				walk(child as ServiceMap, [...member, key])
				continue
			}
			if (child.method !== READ || isStream(child)) continue
			reads.set(`${READ} ${normalizePath(child.path)}`, {
				member: [...member, key],
				params: child.params ?? [],
			})
		}
	}
	walk(map, [])
	return reads
}

/** The `params` of an SDK input, string values only: a key holds what addresses a resource. */
export function paramsOf(input: unknown): Record<string, string> {
	if (typeof input !== "object" || input === null || !Object.hasOwn(input, "params")) return {}
	const raw = (input as { params?: unknown }).params
	if (typeof raw !== "object" || raw === null) return {}
	const params: Record<string, string> = {}
	for (const [key, value] of Object.entries(raw)) if (typeof value === "string" && value !== "") params[key] = value
	return params
}

/**
 * The key a read is cached under: its member path, plus `{ params }` once every path param has a value.
 * One missing value leaves the prefix, which invalidates every query of that read — the key-space answer to
 * a partially resolved route, never a dropped target.
 */
export function keyOf(sdkName: string, read: Read, params: Record<string, string>): QueryKey {
	const prefix = [sdkName, ...read.member]
	if (read.params.length === 0) return prefix
	const filled: Record<string, string> = {}
	for (const name of read.params) {
		const value = params[name]
		if (value === undefined) return prefix
		filled[name] = value
	}
	return [...prefix, { params: filled }]
}

/** The keys a successful `selector` write makes stale. */
export function invalidatedBy(
	reads: Map<string, Read>,
	sdkName: string,
	entry: ServiceEntry,
	input: unknown,
): QueryKey[] {
	if (entry.invalidate === undefined || entry.invalidate.length === 0) return []
	const params = paramsOf(input)
	const keys: QueryKey[] = []
	for (const target of entry.invalidate) {
		const selector = normalizeSelector(target)
		if (selector === undefined) continue
		const read = reads.get(selector)
		if (read === undefined) continue
		keys.push(keyOf(sdkName, read, params))
	}
	return keys
}
