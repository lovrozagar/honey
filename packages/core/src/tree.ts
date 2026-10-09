import type { RouteId, Segment } from "./pattern.ts"
import { canonical, expandOptional, parsePattern, routeId } from "./pattern.ts"
import type { HttpMethod, InputSchemasDef, OutputSchemaDef } from "./types.ts"
import type { WSHandler } from "./ws/cloudflare.ts"
import type { WSOriginPolicy } from "./ws-origin.ts"

export type { HttpMethod, RouteId }

export type OutputValidator = (statusKey: string, data: unknown) => Promise<void>

type ChainMiddleware = (
	ctx: Record<string, unknown>,
	next: (additions?: Record<string, unknown>) => Promise<Response>,
) => Promise<Response>

/**
 * What a route was registered with, before the app resolves it. Finalize derives the
 * resolved fields (`ek`, `mt`, `mw`, `bek`, `ef`) from these, so they never depend on the
 * order of registration and are recomputed whenever the route graph changes.
 */
type RecordSource = {
	/** chain middleware captured at registration (plus any mounting chain) */
	cm?: ChainMiddleware[]
	/** `.context()` values of the registering handle (merged with the mounting handle's) */
	cv?: Record<string, unknown> | null
	/** error keys the route declared itself (`.errors()`, `.boundary()`) */
	dk?: Set<string>
	/** the settings of the app the route was registered on — opaque here */
	own?: unknown
	/** route-level boundary key (`.boundary()`) */
	rb?: string | null
	/** route-level middleware (`.get(...).use(mw)`) */
	rm?: ChainMiddleware[]
	/** explicit meta: chain `.meta()` overlaid by route `.meta()` */
	xm?: Record<string, unknown> | null
}

/**
 * A route record — everything one registered route runs. Records live in a per-app table
 * keyed by `RouteId`; the tree only holds ids, so two apps that load the same tree never
 * share a record.
 */
export type RouteHandler = RecordSource & {
	/** internal route (spec, docs, manifest) — excluded from codegen output, never mounted into a parent */
	_skip?: boolean
	/** boundary error key — wraps undeclared/unexpected errors (null = use default or internal_server_error) */
	bek: string | null
	/** gateway catch-all: dispatches delegated routes, never matched for a path of its own */
	ca?: boolean
	/** delegated route: a tree leaf with no local handler, served by the gateway catch-all */
	dl?: boolean
	/** resolved error factory subset exposed as `ctx.errors` (omit/`null` = none) */
	ef?: Record<string, (...args: never[]) => unknown> | null
	/** declared error keys — resolved at finalize from the route, its middleware and the app defaults */
	ek: Set<string>
	/** resolved error factory — the route's own app's, or the serving app's */
	fac?: Record<string, (...args: never[]) => unknown> | null
	/** handler function */
	fn: (ctx: unknown) => Response | Promise<Response>
	/** route identity: `METHOD /canonical/pattern` */
	id?: RouteId
	/** input validation schemas — missing/`null` = no validation */
	iv?: InputSchemasDef | null
	/** route metadata — frozen object, accessible via ctx.meta */
	mt: Record<string, unknown> | null
	/** resolved middleware chain, in run order: chain, scoped, route */
	mw: ChainMiddleware[]
	/** output schemas by content-type — missing/`null` = no validation */
	os?: OutputSchemaDef | null
	/** output validator function — validates response body against schema */
	ov?: OutputValidator | null
	/** canonical route pattern (e.g. "/users/:id") */
	rp?: string
}

export type { OutputSchemaDef }

export type WSRouteHandler = RecordSource & {
	bek: string | null
	ek: Set<string>
	ef?: Record<string, (...args: never[]) => unknown> | null
	fac?: Record<string, (...args: never[]) => unknown> | null
	fn: WSHandler<unknown>
	id?: RouteId
	iv: InputSchemasDef | null
	mt: Record<string, unknown> | null
	mw: ChainMiddleware[]
	/** browser origins allowed to open the socket (`.origins()`); `null` = same-origin when credentialed */
	og?: WSOriginPolicy | null
	/** canonical ws path pattern */
	rp: string
}

/**
 * Router topology. Leaves are `RouteId`s, never handler objects: what a leaf runs is looked
 * up in the serving app's own route table.
 */
export type TreeNode = {
	/** dynamic param child — { n: param name, c: child subtree } */
	d: { c: TreeNode; n: string } | null
	/** method → route id at this exact path */
	m: Record<string, RouteId> | null
	/** static children — maps literal path segment to child subtree (null-prototype) */
	s: Record<string, TreeNode>
	/** wildcard — { n: wildcard name, m: method → route id } */
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
	/** live record — only in `app.toRouteTree()` snapshots, never in generated files */
	h?: RouteHandler | WSRouteHandler
	/** internal route (spec, docs, manifest) */
	i?: 1 | true
	/** input schemas — only in live snapshots */
	iv?: InputSchemasDef | null
	/** route meta */
	mt?: Record<string, unknown> | null
	/** output schemas — only in live snapshots */
	os?: OutputSchemaDef | null
}

export type MatchResult =
	| { allowed: HttpMethod[]; matched: false }
	| { id: RouteId; matched: true; params: Record<string, string> }
	| null

export interface RouteMeta {}

/** Format of route trees: topology + per-route data. */
export const ROUTE_TREE_VERSION = 2

export type RouteTree = {
	meta: Record<string, RouteMeta>
	root: TreeNode
	routes: Record<RouteId, RouteEntry>
	v?: number
}

function decode(s: string): string {
	if (s.indexOf("%") === -1) return s
	try {
		return decodeURIComponent(s)
	} catch {
		return s
	}
}

function dict<T>(): Record<string, T> {
	return Object.create(null) as Record<string, T>
}

export function createNode(): TreeNode {
	return { d: null, m: null, s: dict<TreeNode>(), w: null, ws: null }
}

function describe(method: string, path: string): string {
	return method === "WS" ? `WebSocket route ${path}` : `route: ${method} ${path}`
}

/**
 * Put `id` at the leaf for `segments` × `method` (`"WS"` for the websocket slot). The same id
 * already there is a no-op; any other id is a duplicate. Optional params must be expanded by
 * the caller — every call places exactly one leaf.
 */
export function insertLeaf(root: TreeNode, segments: readonly Segment[], method: string, id: RouteId): void {
	const path = canonical(segments)
	let node = root
	for (const seg of segments) {
		if (seg.k === "wildcard") {
			if (method === "WS") throw new Error("Wildcard segments not supported for WebSocket routes")
			if (node.w !== null && node.w.n !== seg.n) {
				throw new Error(`Wildcard name conflict: "${node.w.n}" vs "${seg.n}"`)
			}
			if (node.w === null) node.w = { m: dict<RouteId>(), n: seg.n }
			const prev = node.w.m[method]
			if (prev !== undefined && prev !== id) throw new Error(`Duplicate ${describe(method, path)}`)
			node.w.m[method] = id
			return
		}
		if (seg.k === "param") {
			if (node.d !== null && node.d.n !== seg.n) {
				throw new Error(`Route "${path}": param name conflict — expected ":${node.d.n}" but got ":${seg.n}"`)
			}
			if (node.d === null) node.d = { c: createNode(), n: seg.n }
			node = node.d.c
			continue
		}
		let child = node.s[seg.v]
		if (child === undefined) {
			child = createNode()
			node.s[seg.v] = child
		}
		node = child
	}
	if (method === "WS") {
		if (node.ws !== null && node.ws !== id) throw new Error(`Duplicate WebSocket route: ${path}`)
		node.ws = id
		return
	}
	if (node.m === null) node.m = dict<RouteId>()
	const prev = node.m[method]
	if (prev !== undefined && prev !== id) throw new Error(`Duplicate ${describe(method, path)}`)
	node.m[method] = id
}

/**
 * Place a route's leaves by pattern (an optional last param places two). The leaf holds
 * `id`, by default the route's `RouteId`, which is returned.
 */
export function insertRoute(root: TreeNode, method: HttpMethod | "ALL", path: string, id?: RouteId): RouteId {
	const segments = parsePattern(path)
	const rid = id ?? routeId(method, canonical(segments))
	for (const v of expandOptional(segments)) {
		if (findLeaf(root, v, method) !== undefined) throw new Error(`Duplicate route: ${method} ${canonical(v)}`)
		insertLeaf(root, v, method, rid)
	}
	return rid
}

/** Place a websocket route's leaf by pattern; returns its `RouteId`. */
export function insertWsRoute(root: TreeNode, path: string, id?: RouteId): RouteId {
	const segments = parsePattern(path)
	const rid = id ?? routeId("WS", canonical(segments))
	for (const v of expandOptional(segments)) {
		if (findLeaf(root, v, "WS") !== undefined) throw new Error(`Duplicate WebSocket route: ${canonical(v)}`)
		insertLeaf(root, v, "WS", rid)
	}
	return rid
}

/** Exact lookup: the id at the leaf for `segments` × `method`, without matching params against values. */
export function findLeaf(root: TreeNode, segments: readonly Segment[], method: string): RouteId | undefined {
	let node: TreeNode | undefined = root
	for (const seg of segments) {
		if (node === undefined) return undefined
		if (seg.k === "wildcard") {
			if (node.w === null || node.w.n !== seg.n) return undefined
			return node.w.m[method]
		}
		if (seg.k === "param") {
			if (node.d === null || node.d.n !== seg.n) return undefined
			node = node.d.c
			continue
		}
		node = node.s[seg.v]
	}
	if (node === undefined) return undefined
	if (method === "WS") return node.ws ?? undefined
	return node.m?.[method]
}

function pickMethod(m: Record<string, RouteId>, method: string): RouteId | undefined {
	const exact = m[method]
	if (exact !== undefined) return exact
	if (method === "HEAD") {
		const get = m["GET"]
		if (get !== undefined) return get
	}
	return m["ALL"]
}

type MatchState = {
	allowed: Set<string> | null
	method: string
	names: string[]
	path: string
	values: string[]
}

function addAllowed(st: MatchState, m: Record<string, RouteId>): void {
	if (st.allowed === null) st.allowed = new Set()
	for (const k in m) if (k !== "ALL") st.allowed.add(k)
}

/*
 * Depth-first in precedence order — static, then param, then wildcard — retrying the next
 * branch on a dead end and on a method miss. A trie node sits at one depth, so each node is
 * visited at most once per request: the walk is linear in the route set, and recursion depth
 * is bounded by the deepest registered route, not by the request path.
 */
function walk(node: TreeNode, pos: number, st: MatchState): RouteId | undefined {
	const path = st.path
	const len = path.length
	while (pos < len && path.charCodeAt(pos) === 47) pos++
	if (pos >= len) {
		if (node.m !== null) {
			const id = pickMethod(node.m, st.method)
			if (id !== undefined) return id
			addAllowed(st, node.m)
		}
		if (node.w !== null) {
			const id = pickMethod(node.w.m, st.method)
			if (id !== undefined) {
				st.names.push(node.w.n)
				st.values.push("")
				return id
			}
			addAllowed(st, node.w.m)
		}
		return undefined
	}
	let end = path.indexOf("/", pos)
	if (end === -1) end = len
	const seg = path.substring(pos, end)

	const staticChild = node.s[seg]
	if (staticChild !== undefined) {
		const id = walk(staticChild, end, st)
		if (id !== undefined) return id
	}
	if (node.d !== null) {
		const depth = st.names.length
		st.names.push(node.d.n)
		st.values.push(decode(seg))
		const id = walk(node.d.c, end, st)
		if (id !== undefined) return id
		st.names.length = depth
		st.values.length = depth
	}
	if (node.w !== null) {
		const id = pickMethod(node.w.m, st.method)
		if (id !== undefined) {
			st.names.push(node.w.n)
			st.values.push(decode(path.substring(pos)))
			return id
		}
		addAllowed(st, node.w.m)
	}
	return undefined
}

function buildParams(st: MatchState): Record<string, string> {
	const params = dict<string>()
	for (let i = 0; i < st.names.length; i++) params[st.names[i]] = st.values[i]
	return params
}

export function matchRoute(root: TreeNode, method: HttpMethod | string, path: string): MatchResult {
	const st: MatchState = { allowed: null, method, names: [], path, values: [] }
	const id = walk(root, 0, st)
	if (id !== undefined) return { id, matched: true, params: buildParams(st) }
	if (st.allowed !== null && st.allowed.size > 0) {
		return { allowed: [...st.allowed] as HttpMethod[], matched: false }
	}
	return null
}

function walkWs(node: TreeNode, pos: number, st: MatchState): RouteId | undefined {
	const path = st.path
	const len = path.length
	while (pos < len && path.charCodeAt(pos) === 47) pos++
	if (pos >= len) return node.ws ?? undefined
	let end = path.indexOf("/", pos)
	if (end === -1) end = len
	const seg = path.substring(pos, end)
	const staticChild = node.s[seg]
	if (staticChild !== undefined) {
		const id = walkWs(staticChild, end, st)
		if (id !== undefined) return id
	}
	if (node.d !== null) {
		const depth = st.names.length
		st.names.push(node.d.n)
		st.values.push(decode(seg))
		const id = walkWs(node.d.c, end, st)
		if (id !== undefined) return id
		st.names.length = depth
		st.values.length = depth
	}
	return undefined
}

export function matchWsRoute(root: TreeNode, path: string): { id: RouteId; params: Record<string, string> } | null {
	const st: MatchState = { allowed: null, method: "WS", names: [], path, values: [] }
	const id = walkWs(root, 0, st)
	if (id === undefined) return null
	return { id, params: buildParams(st) }
}

/** True when the tree holds at least one websocket leaf. */
export function hasWsLeaf(node: TreeNode): boolean {
	if (node.ws !== null) return true
	for (const k in node.s) if (hasWsLeaf(node.s[k])) return true
	return node.d !== null && hasWsLeaf(node.d.c)
}

/** Every leaf, with its concrete path pattern (optional params already expanded by insertion). */
export function forEachLeaf(
	node: TreeNode,
	cb: (method: string, path: string, id: RouteId) => void,
	prefix = "",
): void {
	if (node.m !== null) for (const method in node.m) cb(method, prefix || "/", node.m[method])
	if (node.ws !== null) cb("WS", prefix || "/", node.ws)
	for (const seg in node.s) forEachLeaf(node.s[seg], cb, `${prefix}/${seg}`)
	if (node.d !== null) forEachLeaf(node.d.c, cb, `${prefix}/:${node.d.n}`)
	if (node.w !== null) {
		const w = node.w.n === "*" ? "*" : `*${node.w.n}`
		for (const method in node.w.m) cb(method, `${prefix}/${w}`, node.w.m[method])
	}
}

/** Deep copy into fresh null-prototype nodes. */
export function cloneTree(node: TreeNode): TreeNode {
	const out = createNode()
	for (const seg in node.s) out.s[seg] = cloneTree(node.s[seg])
	if (node.m !== null) out.m = Object.assign(dict<RouteId>(), node.m)
	if (node.d !== null) out.d = { c: cloneTree(node.d.c), n: node.d.n }
	if (node.w !== null) out.w = { m: Object.assign(dict<RouteId>(), node.w.m), n: node.w.n }
	out.ws = node.ws
	return out
}

/** Deep-freeze a loaded tree so no app can mutate a module other apps also import. */
export function freezeTree(node: TreeNode): TreeNode {
	if (Object.isFrozen(node)) return node
	for (const seg in node.s) freezeTree(node.s[seg])
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

/**
 * Reject a tree whose leaves are not route ids — a `routes.gen.ts` written by an older honey
 * holds handler objects there.
 */
export function assertTreeFormat(tree: { root?: unknown; routes?: unknown; v?: unknown }): void {
	const stale = (): never => {
		throw new Error(
			"routeTree(): this route tree was generated by an older honey (leaves are handler objects, not route ids). Run `honey generate`.",
		)
	}
	if (tree === null || typeof tree !== "object" || tree.root === null || typeof tree.root !== "object") stale()
	if (tree.routes === null || typeof tree.routes !== "object") stale()
	const check = (node: TreeNode): void => {
		if (node.m !== null && typeof node.m === "object")
			for (const k in node.m) if (typeof node.m[k] !== "string") stale()
		if (node.w !== null && typeof node.w === "object") {
			for (const k in node.w.m) if (typeof node.w.m[k] !== "string") stale()
		}
		if (node.ws !== null && node.ws !== undefined && typeof node.ws !== "string") stale()
		if (node.s === null || typeof node.s !== "object") stale()
		for (const seg in node.s) check(node.s[seg])
		if (node.d !== null && node.d !== undefined) check(node.d.c)
	}
	check(tree.root as TreeNode)
}

function mergeMethodMap(
	target: Record<string, RouteId>,
	source: Record<string, RouteId>,
	path: string,
): Record<string, RouteId> {
	for (const method in source) {
		if (target[method] !== undefined) throw new Error(`Merge conflict: duplicate ${method} ${path}`)
		target[method] = source[method]
	}
	return target
}

function mergeNodes(target: TreeNode, source: TreeNode, path: string): void {
	if (source.m !== null) {
		if (target.m === null) target.m = dict<RouteId>()
		mergeMethodMap(target.m, source.m, path || "/")
	}
	for (const seg in source.s) {
		const child = source.s[seg]
		const existing = target.s[seg]
		if (existing !== undefined) mergeNodes(existing, child, `${path}/${seg}`)
		else target.s[seg] = cloneTree(child)
	}
	if (source.d !== null) {
		if (target.d !== null) {
			if (target.d.n !== source.d.n) {
				throw new Error(`Merge conflict: param name mismatch at ${path}: "${target.d.n}" vs "${source.d.n}"`)
			}
			mergeNodes(target.d.c, source.d.c, `${path}/:${target.d.n}`)
		} else {
			target.d = { c: cloneTree(source.d.c), n: source.d.n }
		}
	}
	if (source.w !== null) {
		if (target.w !== null) {
			if (target.w.n !== source.w.n) {
				throw new Error(`Merge conflict: wildcard name mismatch at ${path}: "${target.w.n}" vs "${source.w.n}"`)
			}
			mergeMethodMap(target.w.m, source.w.m, `${path}/*${target.w.n}`)
		} else {
			target.w = { m: Object.assign(dict<RouteId>(), source.w.m), n: source.w.n }
		}
	}
	if (source.ws !== null) {
		if (target.ws !== null) throw new Error(`Merge conflict: duplicate WebSocket handler at ${path || "/"}`)
		target.ws = source.ws
	}
}

/** Merge `source` topology into `target` (mutates target; never shares source nodes). */
export function mergeInto(target: TreeNode, source: TreeNode): void {
	mergeNodes(target, source, "")
}

type TreeInput = RouteTree | [RouteTree, Record<string, unknown>]

function withExtraMeta(entry: RouteEntry, extra: Record<string, unknown> | undefined): RouteEntry {
	if (extra === undefined) return { ...entry }
	const mt = Object.freeze(entry.mt ? { ...entry.mt, ...extra } : { ...extra })
	const out: RouteEntry = { ...entry, mt }
	if (entry.h !== undefined) out.h = { ...entry.h, mt } as RouteHandler
	return out
}

/**
 * Merge several trees into a new one. Inputs are never mutated; extra meta given per tree is
 * applied to copies of its route entries.
 */
export function mergeTree(...trees: TreeInput[]): RouteTree {
	const merged: RouteTree = { meta: {}, root: createNode(), routes: dict<RouteEntry>(), v: ROUTE_TREE_VERSION }
	for (const input of trees) {
		const [tree, extra] = Array.isArray(input) ? input : [input, undefined]
		assertTreeFormat(tree)
		mergeNodes(merged.root, tree.root, "")
		for (const id in tree.routes) {
			if (id in merged.routes) throw new Error(`Merge conflict: duplicate ${id}`)
			merged.routes[id] = withExtraMeta(tree.routes[id], extra)
		}
		Object.assign(merged.meta, tree.meta)
	}
	return merged
}

/**
 * Copy input/output schemas from `source` onto `target`'s routes that lack them.
 * Generate-time only: a gateway app serves its generated tree (no schemas) while its merge
 * source (`mergeTree` over downstream `app.toRouteTree()`) still carries them for OpenAPI.
 */
export function overlaySchemas(target: { _overlaySchemas(source: RouteTree): void }, source: RouteTree): void {
	target._overlaySchemas(source)
}
