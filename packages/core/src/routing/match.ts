/**
 * Request matching over the route tree. Depth-first in precedence order (static, then param, then
 * wildcard), retrying the next branch on a dead end and on a method miss. A trie node sits at one
 * depth, so each node is visited at most once per request: the walk is linear in the route set,
 * and recursion depth is bounded by the deepest registered route, not by the request path.
 */
import type { RouteId } from "./pattern.ts"
import { dict, type TreeNode } from "./tree.ts"
import type { HttpMethod } from "./types.ts"

export type MatchResult =
	| { allowed: HttpMethod[]; matched: false }
	| { id: RouteId; matched: true; params: Record<string, string> }
	| null

type MatchState = {
	allowed: Set<string> | null
	method: string
	names: string[]
	path: string
	values: string[]
	/* the walker a param branch recurses with (HTTP or websocket); one per request, never per segment */
	walk: (node: TreeNode, from: number, st: MatchState) => RouteId | undefined
}

function decode(s: string): string {
	if (!s.includes("%")) return s
	try {
		return decodeURIComponent(s)
	} catch {
		/* a malformed escape is client data: the param keeps it as written */
		return s
	}
}

/** The exact method, then GET for HEAD, then ALL. */
function pickMethod(m: Record<string, RouteId>, method: string): RouteId | undefined {
	return m[method] ?? (method === "HEAD" ? m.GET : undefined) ?? m.ALL
}

function addAllowed(st: MatchState, m: Record<string, RouteId>): void {
	st.allowed ??= new Set()
	/* a map holding ALL never misses (pickMethod falls back to it), so every key here is a method */
	for (const k in m) st.allowed.add(k)
}

/** A wildcard's leaf for the method, capturing `rest`; on a method miss its methods join Allow. */
function wildcardHit(node: TreeNode, rest: string, st: MatchState): RouteId | undefined {
	if (node.w === null) return undefined
	const id = pickMethod(node.w.m, st.method)
	if (id === undefined) {
		addAllowed(st, node.w.m)
		return undefined
	}
	st.names.push(node.w.n)
	st.values.push(rest)
	return id
}

function skipSlashes(path: string, pos: number): number {
	let at = pos
	while (path.charCodeAt(at) === 47) at++
	return at
}

/** The leaf at the end of the path: this node's methods, else an empty wildcard below it. */
function endOfPath(node: TreeNode, st: MatchState): RouteId | undefined {
	if (node.m !== null) {
		const id = pickMethod(node.m, st.method)
		if (id !== undefined) return id
		addAllowed(st, node.m)
	}
	return wildcardHit(node, "", st)
}

/** Try the param branch with `seg` bound; unbind it again on a dead end. */
function tryParam(node: TreeNode, seg: string, end: number, st: MatchState): RouteId | undefined {
	if (node.d === null) return undefined
	const depth = st.names.length
	st.names.push(node.d.n)
	st.values.push(decode(seg))
	const id = st.walk(node.d.c, end, st)
	if (id !== undefined) return id
	st.names.length = depth
	st.values.length = depth
	return undefined
}

function walk(node: TreeNode, from: number, st: MatchState): RouteId | undefined {
	const pos = skipSlashes(st.path, from)
	if (pos >= st.path.length) return endOfPath(node, st)
	const slash = st.path.indexOf("/", pos)
	const end = slash === -1 ? st.path.length : slash
	const seg = st.path.substring(pos, end)
	const staticChild = node.s[seg]
	const viaStatic = staticChild === undefined ? undefined : walk(staticChild, end, st)
	return viaStatic ?? tryParam(node, seg, end, st) ?? wildcardHit(node, decode(st.path.substring(pos)), st)
}

function paramsOf(st: MatchState): Record<string, string> {
	const params = dict<string>()
	st.names.forEach((name, i) => {
		params[name] = st.values[i] as string
	})
	return params
}

export function matchRoute(root: TreeNode, method: HttpMethod | string, path: string): MatchResult {
	const st: MatchState = { allowed: null, method, names: [], path, values: [], walk }
	const id = walk(root, 0, st)
	if (id !== undefined) return { id, matched: true, params: paramsOf(st) }
	if (st.allowed !== null) return { allowed: [...st.allowed] as HttpMethod[], matched: false }
	return null
}

function walkWs(node: TreeNode, from: number, st: MatchState): RouteId | undefined {
	const pos = skipSlashes(st.path, from)
	if (pos >= st.path.length) return node.ws ?? undefined
	const slash = st.path.indexOf("/", pos)
	const end = slash === -1 ? st.path.length : slash
	const seg = st.path.substring(pos, end)
	const staticChild = node.s[seg]
	const viaStatic = staticChild === undefined ? undefined : walkWs(staticChild, end, st)
	return viaStatic ?? tryParam(node, seg, end, st)
}

export function matchWsRoute(root: TreeNode, path: string): { id: RouteId; params: Record<string, string> } | null {
	const st: MatchState = { allowed: null, method: "WS", names: [], path, values: [], walk: walkWs }
	const id = walkWs(root, 0, st)
	return id === undefined ? null : { id, params: paramsOf(st) }
}
