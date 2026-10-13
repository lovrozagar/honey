import { parsePattern, toOpenApiTemplate, UNNAMED_WILDCARD } from "../pattern.ts"
import type { RouteHandler, WSRouteHandler } from "../tree.ts"
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

/** Path parameter names of a route pattern, as OpenAPI names them (wildcards included). */
export function extractParams(path: string): string[] {
	const out: string[] = []
	for (const seg of parsePattern(path)) {
		if (seg.k === "param") out.push(seg.n)
		else if (seg.k === "wildcard") out.push(seg.n === UNNAMED_WILDCARD ? "wildcard" : seg.n)
	}
	return out
}

export function toOpenApiPath(path: string): string {
	return toOpenApiTemplate(parsePattern(path))
}

type RouteSource = {
	_collectRoutes(includeSkipped?: boolean): CollectedRoute[]
	_collectWsRoutes(): CollectedWSRoute[]
}

/** Every served HTTP route of an app, one entry per concrete path. */
export function collectRoutes(app: unknown, includeSkipped?: boolean): CollectedRoute[] {
	return (app as RouteSource)._collectRoutes(includeSkipped)
}

/** Every websocket route of an app, one entry per concrete path. */
export function collectWsRoutes(app: unknown): CollectedWSRoute[] {
	return (app as RouteSource)._collectWsRoutes()
}

export function unwrapEntry(entry: InputSchemaEntry): StandardSchemaLike {
	if ("_tag" in entry) {
		return entry.schema as StandardSchemaLike
	}
	return entry
}
