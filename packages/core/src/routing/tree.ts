/**
 * Router topology. Leaves are `RouteId`s, never handler objects: what a leaf runs is looked up in
 * the serving app's own route table, so two apps that load one tree never share a record.
 */
import { canonical, expandOptional, parsePattern, type RouteId, routeId, type Segment } from "./pattern.ts"
import type { InputSchemas } from "../input/input.ts"
import type { OutputSchemas } from "./output-types.ts"
import type { RouteRecord } from "./record.ts"
import type { HttpMethod } from "./types.ts"

export type TreeNode = {
	/** dynamic param child: { n: param name, c: child subtree } */
	d: { c: TreeNode; n: string } | null
	/** method → route id at this exact path */
	m: Record<string, RouteId> | null
	/** static children: literal path segment → child subtree (null-prototype) */
	s: Record<string, TreeNode>
	/** wildcard: { n: wildcard name, m: method → route id } */
	w: { m: Record<string, RouteId>; n: string } | null
	/** websocket route id for this path */
	ws: RouteId | null
}

/** Descriptive data for one route in a tree. Generated files carry only this. */
export type RouteEntry = {
	/** boundary error key */
	bek?: string | null
	/** declared error keys */
	ek?: readonly string[]
	/** each declared key's status key, read off its factory: a generated tree has no factory to ask */
	es?: Readonly<Record<string, string>>
	/** live record: only in `app.toRouteTree()` snapshots, never in generated files */
	h?: RouteRecord
	/** internal route (spec, docs, manifest) */
	i?: 1 | true
	/** what `.input()` declares: a delegated leaf's body media type is checked against it */
	iv?: InputSchemas | null
	/** route meta */
	mt?: Readonly<Record<string, unknown>> | null
	/** what `.output()` declares */
	out?: OutputSchemas | null
}

export interface RouteMeta {}

/** Format of route trees: topology + per-route data. */
export const ROUTE_TREE_VERSION = 2

export type RouteTree = {
	meta: Record<string, RouteMeta>
	root: TreeNode
	routes: Record<RouteId, RouteEntry>
	v?: number
}

/** A null-prototype record, so a segment or method named `__proto__` is just a key. */
export function dict<T>(): Record<string, T> {
	return Object.create(null) as Record<string, T>
}

export function createNode(): TreeNode {
	return { d: null, m: null, s: dict<TreeNode>(), w: null, ws: null }
}

function describe(method: string, path: string): string {
	return method === "WS" ? `WebSocket route: ${path}` : `route: ${method} ${path}`
}

/** The leaf being placed: which method slot, which id, and the pattern for error messages. */
type Leaf = { id: RouteId; method: string; path: string }

/** Put the id in a method map; the same id already there is a no-op, any other id a duplicate. */
function setLeaf(map: Record<string, RouteId>, leaf: Leaf): void {
	const prev = map[leaf.method]
	if (prev !== undefined && prev !== leaf.id) throw new Error(`Duplicate ${describe(leaf.method, leaf.path)}`)
	map[leaf.method] = leaf.id
}

function wildcardLeaf(node: TreeNode, name: string, leaf: Leaf): void {
	if (leaf.method === "WS") throw new Error("Wildcard segments not supported for WebSocket routes")
	if (node.w !== null && node.w.n !== name) throw new Error(`Wildcard name conflict: "${node.w.n}" vs "${name}"`)
	node.w ??= { m: dict<RouteId>(), n: name }
	setLeaf(node.w.m, leaf)
}

function paramChild(node: TreeNode, name: string, path: string): TreeNode {
	if (node.d !== null && node.d.n !== name) {
		throw new Error(`Route "${path}": param name conflict — expected ":${node.d.n}" but got ":${name}"`)
	}
	node.d ??= { c: createNode(), n: name }
	return node.d.c
}

function staticChild(node: TreeNode, value: string): TreeNode {
	const child = node.s[value] ?? createNode()
	node.s[value] = child
	return child
}

/**
 * Put `id` at the leaf for `segments` × `method` (`"WS"` for the websocket slot). The same id
 * already there is a no-op; any other id is a duplicate. Optional params are expanded by the
 * caller: every call places exactly one leaf.
 */
export function insertLeaf(root: TreeNode, segments: readonly Segment[], method: string, id: RouteId): void {
	const leaf = { id, method, path: canonical(segments) }
	let node = root
	for (const seg of segments) {
		if (seg.k === "wildcard") return wildcardLeaf(node, seg.n, leaf)
		node = seg.k === "param" ? paramChild(node, seg.n, leaf.path) : staticChild(node, seg.v)
	}
	if (method !== "WS") return setLeaf((node.m ??= dict<RouteId>()), leaf)
	if (node.ws !== null && node.ws !== id) throw new Error(`Duplicate WebSocket route: ${leaf.path}`)
	node.ws = id
}

function placeVariants(root: TreeNode, method: string, path: string, id: RouteId | undefined): RouteId {
	const segments = parsePattern(path)
	const rid = id ?? routeId(method, canonical(segments))
	for (const variant of expandOptional(segments)) {
		if (findLeaf(root, variant, method) !== undefined)
			throw new Error(`Duplicate ${describe(method, canonical(variant))}`)
		insertLeaf(root, variant, method, rid)
	}
	return rid
}

/** Place a route's leaves by pattern (an optional last param places two); returns the leaf id. */
export function insertRoute(root: TreeNode, method: HttpMethod | "ALL", path: string, id?: RouteId): RouteId {
	return placeVariants(root, method, path, id)
}

/** Place a websocket route's leaf by pattern; returns its `RouteId`. */
export function insertWsRoute(root: TreeNode, path: string, id?: RouteId): RouteId {
	return placeVariants(root, "WS", path, id)
}

/** Exact lookup: the id at the leaf for `segments` × `method`, without matching params against values. */
export function findLeaf(root: TreeNode, segments: readonly Segment[], method: string): RouteId | undefined {
	let node: TreeNode | undefined = root
	for (const seg of segments) {
		if (node === undefined) return undefined
		if (seg.k === "wildcard") return node.w?.n === seg.n ? node.w.m[method] : undefined
		if (seg.k === "static") node = node.s[seg.v]
		else node = node.d?.n === seg.n ? node.d.c : undefined
	}
	if (node === undefined) return undefined
	return method === "WS" ? (node.ws ?? undefined) : node.m?.[method]
}

/** True when the tree holds at least one websocket leaf. */
export function hasWsLeaf(node: TreeNode): boolean {
	if (node.ws !== null) return true
	if (Object.values(node.s).some(hasWsLeaf)) return true
	return node.d !== null && hasWsLeaf(node.d.c)
}

/** Every leaf, with its concrete path pattern (optional params already expanded by insertion). */
export function forEachLeaf(
	node: TreeNode,
	cb: (method: string, path: string, id: RouteId) => void,
	prefix = "",
): void {
	const here = prefix || "/"
	for (const method in node.m) cb(method, here, node.m[method] as RouteId)
	if (node.ws !== null) cb("WS", here, node.ws)
	for (const seg in node.s) forEachLeaf(node.s[seg] as TreeNode, cb, `${prefix}/${seg}`)
	if (node.d !== null) forEachLeaf(node.d.c, cb, `${prefix}/:${node.d.n}`)
	if (node.w === null) return
	const wildcard = node.w.n === "*" ? "*" : `*${node.w.n}`
	for (const method in node.w.m) cb(method, `${prefix}/${wildcard}`, node.w.m[method] as RouteId)
}

/** Deep copy into fresh null-prototype nodes. */
export function cloneTree(node: TreeNode): TreeNode {
	const out = createNode()
	for (const seg in node.s) out.s[seg] = cloneTree(node.s[seg] as TreeNode)
	if (node.m !== null) out.m = Object.assign(dict<RouteId>(), node.m)
	if (node.d !== null) out.d = { c: cloneTree(node.d.c), n: node.d.n }
	if (node.w !== null) out.w = { m: Object.assign(dict<RouteId>(), node.w.m), n: node.w.n }
	out.ws = node.ws
	return out
}

/** Deep-freeze a loaded tree so no app can mutate a module other apps also import. */
export function freezeTree(node: TreeNode): TreeNode {
	if (Object.isFrozen(node)) return node
	for (const seg in node.s) freezeTree(node.s[seg] as TreeNode)
	Object.freeze(node.s)
	if (node.m !== null) Object.freeze(node.m)
	if (node.d !== null) {
		freezeTree(node.d.c)
		Object.freeze(node.d)
	}
	if (node.w !== null) {
		Object.freeze(node.w.m)
		Object.freeze(node.w)
	}
	return Object.freeze(node)
}

const STALE =
	"routeTree(): this route tree was generated by an older honey (leaves are handler objects, not route ids). Run `honey generate`."

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object"
}

function allIds(map: unknown): boolean {
	return !isObject(map) || Object.values(map).every((id) => typeof id === "string")
}

function wellFormed(node: TreeNode): boolean {
	if (!allIds(node.m) || !allIds(node.w?.m)) return false
	if (node.ws !== null && node.ws !== undefined && typeof node.ws !== "string") return false
	if (!isObject(node.s)) return false
	if (!Object.values(node.s).every(wellFormed)) return false
	return !isObject(node.d) || wellFormed(node.d.c)
}

/** Reject a tree whose leaves are not route ids: a `routes.gen.ts` written by an older honey holds handler objects there. */
export function assertTreeFormat(tree: { root?: unknown; routes?: unknown; v?: unknown }): void {
	if (!isObject(tree) || !isObject(tree.root) || !isObject(tree.routes)) throw new Error(STALE)
	if (!wellFormed(tree.root as TreeNode)) throw new Error(STALE)
}
