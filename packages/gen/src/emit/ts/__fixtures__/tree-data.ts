/**
 * Route-tree data in core's wire format v2 (core routing/tree.ts), placed by pattern the way core
 * places routes: what `app.toRouteTree()` hands `generateRouteTree`, built without core (H2).
 */
import type { RouteEntryV2, RouteTreeV2, TreeNodeV2 } from "../route-tree.ts"

type Node = {
	d: { c: Node; n: string } | null
	m: Record<string, string> | null
	s: Record<string, Node>
	w: { m: Record<string, string>; n: string } | null
	ws: string | null
}

/** A row of `treeOf`: a method (`WS` for the websocket slot), a pattern, and the route's data. */
export type TreeRow = readonly [method: string, pattern: string, entry?: RouteEntryV2]

/** A null-prototype record, as core's `dict()`: a segment named `__proto__` is just a key. */
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>

const createNode = (): Node => ({ d: null, m: null, s: dict<Node>(), w: null, ws: null })

/** Put `id` at the leaf for `segments` × `method`; a wildcard ends the walk. */
function place(root: Node, segments: readonly string[], method: string, id: string): void {
	let node = root
	for (const seg of segments) {
		if (seg.startsWith("*")) {
			node.w ??= { m: dict<string>(), n: seg.length > 1 ? seg.slice(1) : "*" }
			node.w.m[method] = id
			return
		}
		if (seg.startsWith(":")) {
			node.d ??= { c: createNode(), n: seg.slice(1) }
			node = node.d.c
		} else node = node.s[seg] ??= createNode()
	}
	if (method === "WS") node.ws = id
	else (node.m ??= dict<string>())[method] = id
}

/** A v2 tree of `rows`: each placed by pattern (an optional last param at both leaves), its data keyed by route id. */
export function treeOf(rows: readonly TreeRow[]): RouteTreeV2 {
	const root = createNode()
	const routes: Record<string, RouteEntryV2> = {}
	for (const [method, pattern, entry = {}] of rows) {
		const segments = pattern.split("/").filter((seg) => seg !== "")
		const id = `${method} /${segments.join("/")}`
		const head = segments.slice(0, -1)
		const last = segments.at(-1)
		if (last?.startsWith(":") && last.endsWith("?")) {
			place(root, head, method, id)
			place(root, [...head, last.slice(0, -1)], method, id)
		} else place(root, segments, method, id)
		routes[id] = entry
	}
	return { meta: {}, root: root as TreeNodeV2, routes, v: 2 }
}
