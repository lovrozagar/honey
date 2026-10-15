/**
 * `generateRouteTree(tree)` (F2/F17): a route-tree snapshot (core's v2 wire format, restated here
 * because gen never imports core) as a TS module an app boots from. Topology with route-id leaves,
 * each route's data (meta, error keys, error statuses, boundary key), shared values interned.
 * Live validators (`iv`, `out`) and the handler record (`h`) are never written (Q1).
 */
import { InternPool } from "../../ir/route-tree-intern.ts"
import { tsString, wellFormed } from "../shared/escape.ts"
import { compareCodeUnits } from "../shared/lang.ts"
import { literalType, quoteKey } from "../shared/literals.ts"

/** core's route-tree node (routing/tree.ts), field by field. */
export type TreeNodeV2 = {
	d: { c: TreeNodeV2; n: string } | null
	m: Readonly<Record<string, string>> | null
	s: Readonly<Record<string, TreeNodeV2>>
	w: { m: Readonly<Record<string, string>>; n: string } | null
	ws: string | null
}

/** One route's data in a snapshot; `h`, `iv` and `out` are live values, never emitted. */
export type RouteEntryV2 = {
	bek?: string | null
	ek?: readonly string[]
	es?: Readonly<Record<string, string>>
	h?: unknown
	i?: 1 | true
	iv?: unknown
	mt?: Readonly<Record<string, unknown>> | null
	out?: unknown
}

export type RouteTreeV2 = {
	meta?: Readonly<Record<string, unknown>>
	root: TreeNodeV2
	routes: Readonly<Record<string, RouteEntryV2>>
	v?: number
}

/** One route as emitted: only the fields a booted app reads. */
type Emitted = {
	bek: string | null
	ek: readonly string[]
	es: Record<string, string> | null
	i: 1 | true | null
	id: string
	mt: Readonly<Record<string, unknown>> | null
}

/** Every route id a leaf of `root` names: method maps, wildcard method maps and WebSocket leaves. */
function leafIds(root: TreeNodeV2): Set<string> {
	const ids = new Set<string>()
	const stack = [root]
	for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
		for (const id of Object.values(node.m ?? {})) ids.add(id)
		for (const id of Object.values(node.w?.m ?? {})) ids.add(id)
		if (node.ws !== null) ids.add(node.ws)
		if (node.d !== null) stack.push(node.d.c)
		stack.push(...Object.values(node.s))
	}
	return ids
}

/** What `value` is when JSON cannot carry it, else `null`. */
function notJson(value: unknown): string | null {
	if (typeof value === "number") return Number.isFinite(value) ? null : String(value)
	if (value === null || typeof value === "string" || typeof value === "boolean" || value === undefined) return null
	if (typeof value !== "object") return `a ${typeof value}`
	if (Array.isArray(value)) return null
	const proto = Object.getPrototypeOf(value) as unknown
	if (proto === Object.prototype || proto === null) return null
	return `a ${(value as { constructor?: { name?: string } }).constructor?.name ?? "non-plain object"}`
}

/** Refuse meta JSON cannot carry, naming the route and the path; iterative, so deep meta keeps the stack. */
function assertJsonMeta(id: string, meta: Readonly<Record<string, unknown>>): void {
	const fail = (path: string, what: string): never => {
		throw new Error(`${id}: ${path} is ${what} — route trees carry JSON values only`)
	}
	const open = new Set<object>()
	const stack: [unknown, string][] = [[meta, "meta"]]
	for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
		const [value, path] = at
		const what = notJson(value)
		if (what !== null) fail(path, what)
		if (value === null || typeof value !== "object") continue
		if (open.has(value)) fail(path, "a cycle")
		open.add(value)
		if (Array.isArray(value)) value.forEach((child, k) => stack.push([child, `${path}[${k}]`]))
		else for (const [key, child] of Object.entries(value)) stack.push([child, `${path}.${key}`])
	}
}

/** Every string and key in `value`, iteratively: a deep meta keeps the stack. */
function* stringsIn(value: unknown): Generator<string> {
	const stack = [value]
	const seen = new Set<object>()
	while (stack.length > 0) {
		const at = stack.pop()
		if (typeof at === "string") yield at
		if (at === null || typeof at !== "object" || seen.has(at)) continue
		seen.add(at)
		for (const [key, child] of Object.entries(at)) {
			yield key
			stack.push(child)
		}
	}
}

/** Refuse a lone surrogate anywhere in the tree: printed through F2 it would become U+FFFD and re-key a route. */
function assertWellFormed(tree: RouteTreeV2): void {
	const data = Object.values(tree.routes).map(({ bek, ek, es, mt }) => ({ bek, ek, es, mt }))
	for (const text of stringsIn([tree.root, tree.routes, data])) {
		if (wellFormed(text) !== text)
			throw new Error(`route tree string ${JSON.stringify(text)} is not well-formed UTF-16`)
	}
}

/** The routes to emit: the input's `routes` order, restricted to leaf ids, each checked. */
function emittedRoutes(tree: RouteTreeV2): Emitted[] {
	const leaves = leafIds(tree.root)
	for (const id of leaves)
		if (!Object.hasOwn(tree.routes, id)) throw new Error(`route tree leaf ${id} has no route entry`)
	return Object.keys(tree.routes)
		.filter((id) => leaves.has(id))
		.map((id) => {
			const entry = tree.routes[id] as RouteEntryV2
			/* core's snapshot writes `mt: {}` for every route without meta: no key, no meta */
			const mt = entry.mt && Object.keys(entry.mt).length > 0 ? entry.mt : null
			if (mt !== null) assertJsonMeta(id, mt)
			const es = entry.es && Object.keys(entry.es).length > 0 ? entry.es : null
			const sorted = es && Object.fromEntries(Object.entries(es).sort(([a], [b]) => compareCodeUnits(a, b)))
			return { bek: entry.bek ?? null, ek: entry.ek ?? [], es: sorted, i: entry.i ?? null, id, mt }
		})
}

/** `export type MetaShape`: each key's literal types in first-seen order, optional when some meta lacks it. */
function metaShape(routes: readonly Emitted[]): string | null {
	const withMeta = routes.flatMap((route) => (route.mt === null ? [] : [route.mt]))
	const types = new Map<string, Set<string>>()
	const counts = new Map<string, number>()
	for (const mt of withMeta) {
		for (const [key, value] of Object.entries(mt)) {
			types.set(key, (types.get(key) ?? new Set()).add(literalType(value)))
			counts.set(key, (counts.get(key) ?? 0) + 1)
		}
	}
	if (types.size === 0) return null
	const props = [...types]
		.sort(([a], [b]) => compareCodeUnits(a, b))
		.map(([key, set]) => `\t${quoteKey(key)}${counts.get(key) === withMeta.length ? "" : "?"}: ${[...set].join(" | ")}`)
	return `export type MetaShape = {\n${props.join("\n")}\n} & Record<string, unknown>\n`
}

const methodMap = (m: Readonly<Record<string, string>>, intern: InternPool) =>
	`S({ ${Object.entries(m)
		.map(([method, id]) => `${quoteKey(method)}: ${intern.expr(id)}`)
		.join(", ")} })`

/** A node as `N(s, m, d, w, ws)`, trailing defaults left out. */
function nodeText(node: TreeNodeV2, intern: InternPool): string {
	const statics = Object.entries(node.s)
	const args = [
		statics.length > 0
			? `S({ ${statics.map(([k, c]) => `${keyText(k)}: ${nodeText(c, intern)}`).join(", ")} })`
			: "undefined",
		node.m === null ? "null" : methodMap(node.m, intern),
		node.d === null ? "null" : `{ n: ${tsString(node.d.n)}, c: ${nodeText(node.d.c, intern)} }`,
		node.w === null ? "null" : `{ n: ${tsString(node.w.n)}, m: ${methodMap(node.w.m, intern)} }`,
		node.ws === null ? "null" : intern.expr(node.ws),
	]
	while (args.length > 0 && (args.at(-1) === "null" || args.at(-1) === "undefined")) args.pop()
	return `N(${args.join(", ")})`
}

/** An object-literal key that defines an own property even for `__proto__`. */
const keyText = (key: string) => (key === "__proto__" ? '["__proto__"]' : tsString(key))

/** Count every value a route carries, and force a name on each id and each meta. */
function internOf(routes: readonly Emitted[]): InternPool {
	const intern = new InternPool()
	for (const route of routes) {
		intern.count(route.bek)
		if (route.ek.length > 0) intern.count(route.ek)
		intern.count(route.es)
		intern.count(route.mt)
		intern.count(route.id)
	}
	for (const route of routes) {
		intern.force(route.mt, "M")
		intern.force(route.id, "P")
	}
	intern.seal()
	return intern
}

function routeLine(route: Emitted, intern: InternPool): string {
	const parts: string[] = []
	if (route.bek !== null) parts.push(`bek: ${intern.expr(route.bek)}`)
	if (route.ek.length > 0) parts.push(`ek: ${intern.expr(route.ek)}`)
	if (route.es !== null) parts.push(`es: ${intern.expr(route.es)}`)
	if (route.i !== null) parts.push(`i: ${String(route.i)}`)
	if (route.mt !== null) parts.push(`mt: ${intern.expr(route.mt)}`)
	return `\t[${intern.expr(route.id)}]: ${parts.length > 0 ? `{ ${parts.join(", ")} }` : "{}"}`
}

const HEAD = `import type { RouteTree, TreeNode } from "@lovrozagar/honey/tree"

function S<T>(o: Record<string, T>): Record<string, T> {
	return Object.assign(Object.create(null) as Record<string, T>, o)
}
function N(s: Record<string, TreeNode> = S({}), m: Record<string, string> | null = null, d: TreeNode["d"] = null, w: TreeNode["w"] = null, ws: string | null = null): TreeNode {
	return { d, m, s, w, ws }
}
`

/** The exported selectors: every HTTP route that is neither internal nor marked internal by its meta. */
function selectorType(routes: readonly Emitted[], intern: InternPool): string {
	const ids = routes
		.filter((route) => !route.id.startsWith("WS ") && route.i === null && route.mt?.internal !== true)
		.map((route) => route.id)
		.sort(compareCodeUnits)
	if (ids.length === 0) return ""
	return `\nexport type RouteSelector = ${ids.map((id) => `typeof ${intern.id(id)}`).join(" | ")}\n`
}

/** The route-tree module for `tree` (a snapshot or a merged tree); throws on anything it cannot carry. */
export function generateRouteTree(tree: RouteTreeV2): string {
	if (tree.v !== 2) throw new Error(`route tree version ${String(tree.v)} is not supported: generateRouteTree reads v2`)
	const routes = emittedRoutes(tree)
	assertWellFormed(tree)
	const intern = internOf(routes)
	const shape = metaShape(routes)
	const consts = intern
		.emitConstLines()
		.map((line) => (shape !== null && /^const M\d+ = /.test(line) ? `${line} as unknown as MetaShape` : line))
	const withMeta = routes.filter((route) => route.mt !== null)
	const metaType = shape === null ? "Record<string, Record<string, unknown>>" : "Record<string, MetaShape>"
	const meta = withMeta.map((route) => `\t[${intern.expr(route.id)}]: ${intern.expr(route.mt)}`)
	return [
		HEAD,
		consts.length > 0 ? `${consts.join("\n")}\n` : "",
		`export const tree: TreeNode = ${nodeText(tree.root, intern)}\n`,
		`export const routes: RouteTree["routes"] = S({\n${routes.map((route) => routeLine(route, intern)).join(",\n")}\n})\n`,
		shape ?? "",
		selectorType(routes, intern),
		meta.length > 0 ? `export const meta: ${metaType} = S({\n${meta.join(",\n")}\n})\n` : "",
		`export const routeTree: RouteTree = { v: 2, root: tree, routes, ${meta.length > 0 ? "meta" : "meta: {}"} }\n`,
	]
		.filter((part) => part !== "")
		.join("\n")
}
