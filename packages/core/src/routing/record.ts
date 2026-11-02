/**
 * A route record: what one registered route is. Records live in a per-app table keyed by
 * `RouteId`; the tree only holds ids, so two apps that load the same tree, or a sub-app mounted
 * into two parents, never share a record.
 */
import type { RouteId, Segment } from "./pattern.ts"

/**
 * One route as an app's route table holds it: its id, pattern and meta. Each app keeps its own copy, so two apps that
 * load the same tree never share a record.
 */
export type RouteRecord = {
	/** route identity: `METHOD /canonical/pattern` */
	readonly id: RouteId
	/** route meta, frozen: what `ctx.meta` reads */
	mt: Readonly<Record<string, unknown>> | null
	/** canonical route pattern, e.g. `/users/:id` */
	readonly rp: string
	/** the pattern's segments, parsed once at registration so finalize never parses again */
	readonly sg: readonly Segment[]
}

/** A fresh record for another graph; the meta object is frozen, so it is shared, not copied. */
export function copyRecord<T extends RouteRecord>(record: T): T {
	return { ...record }
}
