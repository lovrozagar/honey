/**
 * Merging route trees: the topology of one tree into another (`mergeInto`, used when an app mounts
 * a sub-app) and several trees into a new one (`mergeTree`, a gateway's view of its services).
 * Sources are never mutated or shared.
 */
import type { RouteId } from "./pattern.ts"
import {
	assertTreeFormat,
	cloneTree,
	createNode,
	dict,
	ROUTE_TREE_VERSION,
	type RouteEntry,
	type RouteTree,
	type TreeNode,
} from "./tree.ts"

type TreeInput = RouteTree | [RouteTree, Record<string, unknown>]

function mergeMethodMap(target: Record<string, RouteId>, source: Record<string, RouteId>, path: string): void {
	for (const method in source) {
		if (target[method] !== undefined) throw new Error(`Merge conflict: duplicate ${method} ${path}`)
		target[method] = source[method] as RouteId
	}
}

function mergeParam(target: TreeNode, source: TreeNode, path: string): void {
	if (source.d === null) return
	if (target.d === null) {
		target.d = { c: cloneTree(source.d.c), n: source.d.n }
		return
	}
	if (target.d.n !== source.d.n) {
		throw new Error(`Merge conflict: param name mismatch at ${path}: "${target.d.n}" vs "${source.d.n}"`)
	}
	mergeNodes(target.d.c, source.d.c, `${path}/:${target.d.n}`)
}

function mergeWildcard(target: TreeNode, source: TreeNode, path: string): void {
	if (source.w === null) return
	if (target.w === null) {
		target.w = { m: Object.assign(dict<RouteId>(), source.w.m), n: source.w.n }
		return
	}
	if (target.w.n !== source.w.n) {
		throw new Error(`Merge conflict: wildcard name mismatch at ${path}: "${target.w.n}" vs "${source.w.n}"`)
	}
	mergeMethodMap(target.w.m, source.w.m, `${path}/*${target.w.n}`)
}

function mergeNodes(target: TreeNode, source: TreeNode, path: string): void {
	if (source.m !== null) mergeMethodMap((target.m ??= dict<RouteId>()), source.m, path || "/")
	for (const seg in source.s) {
		const child = source.s[seg] as TreeNode
		const existing = target.s[seg]
		if (existing === undefined) target.s[seg] = cloneTree(child)
		else mergeNodes(existing, child, `${path}/${seg}`)
	}
	mergeParam(target, source, path)
	mergeWildcard(target, source, path)
	if (source.ws === null) return
	if (target.ws !== null) throw new Error(`Merge conflict: duplicate WebSocket handler at ${path || "/"}`)
	target.ws = source.ws
}

/** Merge `source` topology into `target` (mutates target; never shares source nodes). */
export function mergeInto(target: TreeNode, source: TreeNode): void {
	mergeNodes(target, source, "")
}

function withExtraMeta(entry: RouteEntry, extra: Record<string, unknown> | undefined): RouteEntry {
	if (extra === undefined) return { ...entry }
	const mt = Object.freeze({ ...entry.mt, ...extra })
	return entry.h === undefined ? { ...entry, mt } : { ...entry, h: { ...entry.h, mt }, mt }
}

/** Merge several trees into a new one. Inputs are never mutated; extra meta given per tree is applied to copies of its route entries. */
export function mergeTree(...trees: TreeInput[]): RouteTree {
	const merged: RouteTree = { meta: {}, root: createNode(), routes: dict<RouteEntry>(), v: ROUTE_TREE_VERSION }
	for (const input of trees) {
		const [tree, extra] = Array.isArray(input) ? input : [input, undefined]
		assertTreeFormat(tree)
		mergeNodes(merged.root, tree.root, "")
		for (const id in tree.routes) {
			if (id in merged.routes) throw new Error(`Merge conflict: duplicate ${id}`)
			merged.routes[id] = withExtraMeta(tree.routes[id] as RouteEntry, extra)
		}
		Object.assign(merged.meta, tree.meta)
	}
	return merged
}
