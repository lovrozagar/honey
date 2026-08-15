import type { HttpMethod, InputSchemasDef, OutputSchemaDef } from "./types.ts"
import type { WSHandler } from "./ws/cloudflare.ts"

export type { HttpMethod }

export type OutputValidator = (statusKey: string, data: unknown) => Promise<void>

export type RouteHandler = {
	/** cached compiled middleware chain (set lazily at first request) */
	_compiled?: (ctx: object) => Response | Promise<Response>
	/** internal route — excluded from codegen output */
	_skip?: boolean
	/** boundary error key — wraps undeclared/unexpected errors (null = use default or internal_server_error) */
	bek: string | null
	/** pre-computed error factory subset (null = use global factory) */
	ef: Record<string, (...args: never[]) => unknown> | null
	/** declared error keys for this route — used for runtime enforcement */
	ek: Set<string>
	/** handler function */
	fn: (ctx: unknown) => Response | Promise<Response>
	/** input validation schemas (null = no input validation) */
	iv: InputSchemasDef | null
	/** route metadata — frozen object, accessible via ctx.meta */
	mt: Record<string, unknown> | null
	/** middleware chain — same as RuntimeMiddleware, inlined to avoid circular dep */
	mw: Array<
		(
			ctx: Record<string, unknown>,
			next: (additions?: Record<string, unknown>) => Promise<Response>,
		) => Promise<Response>
	>
	/** output schemas by content-type (null = no output validation) */
	os: OutputSchemaDef | null
	/** output validator function — validates response body against schema */
	ov: OutputValidator | null
	/** registered path pattern (e.g. "/users/:id") */
	rp: string
}

export type { OutputSchemaDef }

export type WSRouteHandler = {
	bek: string | null
	ek: Set<string>
	fn: WSHandler<unknown>
	iv: InputSchemasDef | null
	mt: Record<string, unknown> | null
	mw: Array<
		(
			ctx: Record<string, unknown>,
			next: (additions?: Record<string, unknown>) => Promise<Response>,
		) => Promise<Response>
	>
	/** registered ws path pattern — used by scoped-mw prefix filter */
	rp: string
}

export type TreeNode = {
	/** dynamic param child — { n: param name, c: child subtree } */
	d: { c: TreeNode; n: string } | null
	/** method handlers — maps HTTP method (or ALL) to route handler */
	m: Record<HttpMethod | "ALL", RouteHandler> | null
	/** static children — maps literal path segment to child subtree */
	s: Record<string, TreeNode>
	/** wildcard handler — { n: wildcard name, m: method→handler map } */
	w: { m: Record<HttpMethod | "ALL", RouteHandler>; n: string } | null
	/** websocket handler for this path */
	ws: WSRouteHandler | null
}

export type MatchResult =
	| { allowed: HttpMethod[]; matched: false }
	| { handler: RouteHandler; matched: true; params: Record<string, string> }
	| null

export interface RouteMeta {}

export type RouteTree = {
	handlers?: Record<string, RouteHandler>
	meta: Record<string, RouteMeta>
	root: TreeNode
}

function decode(s: string): string {
	if (s.indexOf("%") === -1) return s
	try {
		return decodeURIComponent(s)
	} catch {
		return s
	}
}

export function createNode(): TreeNode {
	return {
		d: null,
		m: null,
		s: Object.create(null) as Record<string, TreeNode>,
		w: null,
		ws: null,
	}
}

function splitSegments(path: string): string[] {
	return path.split("/").filter((s) => s.length > 0)
}

export function insertRoute(
	root: TreeNode,
	method: HttpMethod | "ALL",
	path: string,
	handler: RouteHandler,
): void {
	const segments = splitSegments(path)
	let node = root

	for (const seg of segments) {

		if (seg.startsWith("*")) {
			const name = seg.length > 1 ? seg.slice(1) : "*"
			if (node.w !== null && node.w.n !== name) {
				throw new Error(`Wildcard name conflict: "${node.w.n}" vs "${name}"`)
			}
			if (node.w === null) {
				node.w = {
					m: Object.create(null) as Record<HttpMethod | "ALL", RouteHandler>,
					n: name,
				}
			}
			if (method in node.w.m) {
				throw new Error(`Duplicate route: ${method} ${path}`)
			}
			node.w.m[method] = handler
			return
		}

		if (seg.startsWith(":")) {
			const name = seg.endsWith("?") ? seg.slice(1, -1) : seg.slice(1)
			if (node.d !== null && node.d.n !== name) {
				throw new Error(
					`Route "${path}": param name conflict — expected ":${node.d.n}" but got ":${name}"`,
				)
			}
			if (node.d === null) {
				node.d = { c: createNode(), n: name }
			}

			if (seg.endsWith("?")) {
				/* optional param — register handler on parent too */
				if (node.m === null) {
					node.m = Object.create(null) as Record<HttpMethod | "ALL", RouteHandler>
				}
				if (method in node.m) {
					throw new Error(`Duplicate route: ${method} ${path}`)
				}
				node.m[method] = handler
			}

			node = node.d.c
			continue
		}

		/* static segment */
		const staticChild = node.s[seg]
		if (staticChild !== undefined) {
			node = staticChild
			continue
		}
		const nextNode = createNode()
		node.s[seg] = nextNode
		node = nextNode
	}

	/* terminal node */
	if (node.m === null) {
		node.m = Object.create(null) as Record<HttpMethod | "ALL", RouteHandler>
	}
	if (method in node.m) {
		throw new Error(`Duplicate route: ${method} ${path}`)
	}
	node.m[method] = handler
}

function resolveMethod(
	handlers: Record<HttpMethod | "ALL", RouteHandler>,
	method: HttpMethod,
	params: Record<string, string>,
): MatchResult {
	if (method in handlers) {
		return { handler: handlers[method], matched: true, params }
	}
	/* HEAD falls back to GET handler */
	if (method === "HEAD" && "GET" in handlers) {
		return { handler: handlers["GET"], matched: true, params }
	}
	if ("ALL" in handlers) {
		return { handler: handlers["ALL"], matched: true, params }
	}
	const allowed = Object.keys(handlers).filter((k) => k !== "ALL") as HttpMethod[]
	return { allowed, matched: false }
}

export function matchRoute(root: TreeNode, method: HttpMethod, path: string): MatchResult {
	let node = root
	const params: Record<string, string> = Object.create(null)
	const len = path.length

	/* skip leading slash */
	let pos = path.charCodeAt(0) === 47 ? 1 : 0

	while (pos < len) {
		/* find next slash or end */
		let end = pos
		while (end < len && path.charCodeAt(end) !== 47) end++
		if (end === pos) {
			pos++
			continue
		}
		const seg = path.substring(pos, end)
		pos = end + 1

		/* 1. static child */
		const staticChild = node.s[seg]
		if (staticChild !== undefined) {
			node = staticChild
			continue
		}

		/* 2. dynamic param */
		if (node.d !== null) {
			params[node.d.n] = decode(seg)
			node = node.d.c
			continue
		}

		/* 3. wildcard — consumes remaining */
		if (node.w !== null) {
			params[node.w.n] = decode(pos <= len ? `${seg}/${path.substring(pos)}` : seg)
			return resolveMethod(node.w.m, method, params)
		}

		return null
	}

	/* terminal node */
	if (node.m !== null) {
		return resolveMethod(node.m, method, params)
	}

	/* check wildcard for empty remainder */
	if (node.w !== null) {
		params[node.w.n] = ""
		return resolveMethod(node.w.m, method, params)
	}

	return null
}

export function insertWsRoute(root: TreeNode, path: string, handler: WSRouteHandler): void {
	const segments = splitSegments(path)
	let node = root

	for (const seg of segments) {

		if (seg.startsWith("*")) {
			throw new Error("Wildcard segments not supported for WebSocket routes")
		}

		if (seg.startsWith(":")) {
			const name = seg.slice(1)
			if (node.d !== null && node.d.n !== name) {
				throw new Error(
					`Route "${path}": param name conflict — expected ":${node.d.n}" but got ":${name}"`,
				)
			}
			if (node.d === null) {
				node.d = { c: createNode(), n: name }
			}
			node = node.d.c
			continue
		}

		const staticChild = node.s[seg]
		if (staticChild !== undefined) {
			node = staticChild
			continue
		}
		const nextNode = createNode()
		node.s[seg] = nextNode
		node = nextNode
	}

	if (node.ws !== null) {
		throw new Error(`Duplicate WebSocket route: ${path}`)
	}
	node.ws = handler
}

export function matchWsRoute(
	root: TreeNode,
	path: string,
): { handler: WSRouteHandler; params: Record<string, string> } | null {
	let node = root
	const params: Record<string, string> = Object.create(null)
	const len = path.length

	let pos = path.charCodeAt(0) === 47 ? 1 : 0

	while (pos < len) {
		let end = pos
		while (end < len && path.charCodeAt(end) !== 47) end++
		if (end === pos) {
			pos++
			continue
		}
		const seg = path.substring(pos, end)
		pos = end + 1

		const staticChild = node.s[seg]
		if (staticChild !== undefined) {
			node = staticChild
			continue
		}

		if (node.d !== null) {
			params[node.d.n] = decode(seg)
			node = node.d.c
			continue
		}

		return null
	}

	if (node.ws !== null) {
		return { handler: node.ws, params }
	}

	return null
}

function mergeNodes(target: TreeNode, source: TreeNode, path: string): void {
	/* merge method handlers */
	if (source.m !== null) {
		if (target.m === null) {
			target.m = Object.create(null) as Record<HttpMethod | "ALL", RouteHandler>
		}
		for (const [method, handler] of Object.entries(source.m)) {
			if (method in target.m) {
				throw new Error(`Merge conflict: duplicate ${method} ${path}`)
			}
			target.m[method as HttpMethod | "ALL"] = handler
		}
	}

	/* merge static children — shallow-copy s to avoid mutating shared empty objects */
		if (Object.keys(source.s).length > 0) {
			let detached = false
			for (const [seg, child] of Object.entries(source.s)) {
				const targetChild = target.s[seg]
				if (targetChild !== undefined) {
					mergeNodes(targetChild, child, `${path}/${seg}`)
				} else {
				if (!detached) {
					target.s = Object.assign(Object.create(null) as Record<string, TreeNode>, target.s)
					detached = true
				}
				target.s[seg] = child
			}
		}
	}

	/* merge dynamic param */
	if (source.d !== null) {
		if (target.d !== null) {
			if (target.d.n !== source.d.n) {
				throw new Error(
					`Merge conflict: param name mismatch at ${path}: "${target.d.n}" vs "${source.d.n}"`,
				)
			}
			mergeNodes(target.d.c, source.d.c, `${path}/:${target.d.n}`)
		} else {
			target.d = source.d
		}
	}

	/* merge wildcard */
	if (source.w !== null) {
		if (target.w !== null) {
			if (target.w.n !== source.w.n) {
				throw new Error(
					`Merge conflict: wildcard name mismatch at ${path}: "${target.w.n}" vs "${source.w.n}"`,
				)
			}
			for (const [method, handler] of Object.entries(source.w.m)) {
				if (method in target.w.m) {
					throw new Error(`Merge conflict: duplicate ${method} ${path}/*${target.w.n}`)
				}
				target.w.m[method as HttpMethod | "ALL"] = handler
			}
		} else {
			target.w = source.w
		}
	}

	/* merge websocket */
	if (source.ws !== null) {
		if (target.ws !== null) {
			throw new Error(`Merge conflict: duplicate WebSocket handler at ${path}`)
		}
		target.ws = source.ws
	}
}

/** Merge source tree nodes into target tree (mutates target) */
export function mergeInto(target: TreeNode, source: TreeNode): void {
	mergeNodes(target, source, "")
}

type TreeInput = RouteTree | [RouteTree, Record<string, unknown>]

function tagHandlerMeta(node: TreeNode, extra: Record<string, unknown>): void {
	if (node.m !== null) {
		for (const handler of Object.values(node.m) as RouteHandler[]) {
			handler.mt = handler.mt ? { ...handler.mt, ...extra } : { ...extra }
		}
	}
	for (const child of Object.values(node.s)) {
		tagHandlerMeta(child, extra)
	}
	if (node.d) tagHandlerMeta(node.d.c, extra)
	if (node.w !== null) {
		for (const handler of Object.values(node.w.m) as RouteHandler[]) {
			handler.mt = handler.mt ? { ...handler.mt, ...extra } : { ...extra }
		}
	}
}

export function mergeTree(...trees: TreeInput[]): RouteTree {
	const merged: RouteTree = {
		meta: {},
		root: createNode(),
	}

	for (const entry of trees) {
		const [tree, extra] = Array.isArray(entry) ? entry : [entry, undefined]
		if (extra) tagHandlerMeta(tree.root, extra)
		mergeNodes(merged.root, tree.root, "")
		Object.assign(merged.meta, tree.meta)
	}

	return merged
}
