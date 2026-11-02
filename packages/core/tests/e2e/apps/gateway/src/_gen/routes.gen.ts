import type { RouteTree, TreeNode } from "@lovrozagar/honey/tree"

function S<T>(o: Record<string, T>): Record<string, T> {
	return Object.assign(Object.create(null) as Record<string, T>, o)
}
function N(s: Record<string, TreeNode> = S({}), m: Record<string, string> | null = null, d: TreeNode["d"] = null, w: TreeNode["w"] = null, ws: string | null = null): TreeNode {
	return { d, m, s, w, ws }
}

const P0 = "GET /users"
const P1 = "POST /users"
const P2 = "GET /users/:id"
const P3 = "GET /ping"
const T0 = "project_id"
const P4 = "GET /articles"
const P5 = "GET /articles/meta"
const P6 = "GET /nl/c/:delivery/:url"
const P7 = "GET /v1/openapi/spec"
const M0 = {"worker":"origin"} as unknown as MetaShape
const M2 = {"tenant":T0} as unknown as MetaShape
const M1 = {"tenant":T0,"permissions":["articles.read"],"summary":"List articles","worker":"origin"} as unknown as MetaShape

export const tree: TreeNode = N(S({ "users": N(undefined, S({ GET: P0, POST: P1 }), { n: "id", c: N(undefined, S({ GET: P2 })) }), "ping": N(undefined, S({ GET: P3 })), "articles": N(S({ "meta": N(undefined, S({ GET: P5 })) }), S({ GET: P4 })), "nl": N(S({ "c": N(undefined, null, { n: "delivery", c: N(undefined, null, { n: "url", c: N(undefined, S({ GET: P6 })) }) }) })), "v1": N(S({ "openapi": N(S({ "spec": N(undefined, S({ GET: P7 })) })) })) }))

export const routes: RouteTree["routes"] = S<RouteTree["routes"][string]>({
	[P0]: { mt: M0 },
	[P1]: { bd: "json", mt: M0 },
	[P2]: { mt: M0 },
	[P3]: {},
	[P4]: { mt: M1 },
	[P5]: { mt: M2 },
	[P6]: {},
	[P7]: {}
})

export type MetaShape = {
	permissions?: ["articles.read"]
	summary?: "List articles"
	tenant?: "project_id"
	worker?: "origin"
} & Record<string, unknown>


export type RouteSelector = typeof P4 | typeof P5 | typeof P6 | typeof P3 | typeof P0 | typeof P2 | typeof P7 | typeof P1

export const meta: Record<string, MetaShape> = S({
	[P0]: M0,
	[P1]: M0,
	[P2]: M0,
	[P4]: M1,
	[P5]: M2
})

export const routeTree: RouteTree = { v: 2, root: tree, routes, meta }
