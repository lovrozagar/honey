import type { RouteHandler, TreeNode, WSRouteHandler } from "../tree.ts"
import type { InputSchemaEntry, StandardSchemaLike } from "../types.ts"

export type CollectedRoute = {
	handler: RouteHandler
	method: string
	path: string
}

export type CollectedWSRoute = {
	handler: WSRouteHandler
	path: string
}

export function extractParams(path: string): string[] {
	const params: string[] = []
	for (const seg of path.split("/")) {
		if (seg.startsWith(":")) {
			params.push(seg.endsWith("?") ? seg.slice(1, -1) : seg.slice(1))
		}
	}
	return params
}

export function toOpenApiPath(path: string): string {
	return path.replace(/:(\w+)\??/g, "{$1}")
}

export function walkTree(
	node: TreeNode,
	currentPath: string,
	routes: CollectedRoute[],
	includeSkipped?: boolean,
): void {
	if (node.m !== null) {
		for (const [method, handler] of Object.entries(node.m)) {
			if (handler._skip && !includeSkipped) continue
			routes.push({ handler, method, path: currentPath || "/" })
		}
	}

	for (const [seg, child] of Object.entries(node.s)) {
		walkTree(child, `${currentPath}/${seg}`, routes, includeSkipped)
	}

	if (node.d !== null) {
		walkTree(node.d.c, `${currentPath}/:${node.d.n}`, routes, includeSkipped)
	}

	if (node.w !== null) {
		for (const [method, handler] of Object.entries(node.w.m)) {
			if (handler._skip && !includeSkipped) continue
			routes.push({ handler, method, path: `${currentPath}/*${node.w.n}` })
		}
	}
}

export function walkWSRoutes(node: TreeNode, currentPath: string, routes: CollectedWSRoute[]): void {
	if (node.ws !== null) {
		routes.push({ handler: node.ws, path: currentPath || "/" })
	}
	for (const [seg, child] of Object.entries(node.s)) {
		walkWSRoutes(child, `${currentPath}/${seg}`, routes)
	}
	if (node.d !== null) {
		walkWSRoutes(node.d.c, `${currentPath}/:${node.d.n}`, routes)
	}
}

export function unwrapEntry(entry: InputSchemaEntry): StandardSchemaLike {
	if ("_tag" in entry) {
		return entry.schema as StandardSchemaLike
	}
	return entry
}
