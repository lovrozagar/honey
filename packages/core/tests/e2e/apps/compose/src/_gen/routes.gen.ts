import type { RouteTree, TreeNode } from "@lovrozagar/honey/tree"

function S<T>(o: Record<string, T>): Record<string, T> {
	return Object.assign(Object.create(null) as Record<string, T>, o)
}
function N(s: Record<string, TreeNode> = S({}), m: Record<string, string> | null = null, d: TreeNode["d"] = null, w: TreeNode["w"] = null, ws: string | null = null): TreeNode {
	return { d, m, s, w, ws }
}

const T0 = "expired_token"
const T1 = "invalid_token"
const T2 = "unauthorized"
const P0 = "GET /health"
const P1 = "GET /docs"
const P2 = "GET /feed"
const T3 = "forbidden"
const P3 = "GET /account"
const P4 = "POST /account/settings"
const T4 = "not_found"
const P5 = "GET /resources/:resourceId"
const P6 = "DELETE /resources/:resourceId"
const P7 = "POST /resources"
const A0 = [T0,T1]
const J0 = {"expired_token":T2,"invalid_token":T2}
const A1 = [T0,T3,T1]
const J1 = {"expired_token":T2,"forbidden":T3,"invalid_token":T2}
const A2 = [T0,T3,T1,T4]
const J2 = {"expired_token":T2,"forbidden":T3,"invalid_token":T2,"not_found":T4}

export const tree: TreeNode = N(S({ "health": N(undefined, S({ GET: P0 })), "docs": N(undefined, S({ GET: P1 })), "feed": N(undefined, S({ GET: P2 })), "account": N(S({ "settings": N(undefined, S({ POST: P4 })) }), S({ GET: P3 })), "resources": N(undefined, S({ POST: P7 }), { n: "resourceId", c: N(undefined, S({ GET: P5, DELETE: P6 })) }) }))

export const routes: RouteTree["routes"] = S<RouteTree["routes"][string]>({
	[P0]: { ek: A0, es: J0 },
	[P1]: { ek: A0, es: J0 },
	[P2]: { ek: A0, es: J0 },
	[P3]: { ek: A1, es: J1 },
	[P4]: { ek: A1, es: J1 },
	[P5]: { ek: A2, es: J2 },
	[P6]: { ek: A2, es: J2 },
	[P7]: { ek: [T0,T3,T1,"rate_limited"], es: {"expired_token":T2,"forbidden":T3,"invalid_token":T2,"rate_limited":"too_many_requests"} }
})


export type RouteSelector = typeof P6 | typeof P3 | typeof P1 | typeof P2 | typeof P0 | typeof P5 | typeof P4 | typeof P7

export const routeTree: RouteTree = { v: 2, root: tree, routes, meta: {} }
