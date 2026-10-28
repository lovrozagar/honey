import type { RouteTree, TreeNode } from "@lovrozagar/honey/tree"

function S<T>(o: Record<string, T>): Record<string, T> {
	return Object.assign(Object.create(null) as Record<string, T>, o)
}
function N(s: Record<string, TreeNode> = S({}), m: Record<string, string> | null = null, d: TreeNode["d"] = null, w: TreeNode["w"] = null, ws: string | null = null): TreeNode {
	return { d, m, s, w, ws }
}

const T0 = "extract:write"
const P0 = "POST /v1/projects/:project_id/extract"
const P1 = "POST /v1/projects/:project_id/extract-stream"
const P2 = "POST /v1/projects/:project_id/suggest-schema"
const P3 = "POST /v1/projects/:project_id/tables/:table_id/extract"
const P4 = "POST /v1/projects/:project_id/tables/:table_id/extract-stream"
const A1 = [T0]
const J0 = {"apiKey":A1}
const A0 = [J0]
const M0 = {"mcp":true,"security":A0,"operationId":"extract.once"} as unknown as MetaShape
const M1 = {"mcp":true,"security":A0,"operationId":"extract.stream"} as unknown as MetaShape
const M2 = {"mcp":true,"security":A0,"operationId":"suggest.schema"} as unknown as MetaShape
const M3 = {"mcp":true,"security":A0,"operationId":"extract.table.once"} as unknown as MetaShape
const M4 = {"mcp":true,"security":A0,"operationId":"extract.table.stream"} as unknown as MetaShape

export const tree: TreeNode = N(S({ "v1": N(S({ "projects": N(undefined, null, { n: "project_id", c: N(S({ "extract": N(undefined, S({ POST: P0 })), "extract-stream": N(undefined, S({ POST: P1 })), "suggest-schema": N(undefined, S({ POST: P2 })), "tables": N(undefined, null, { n: "table_id", c: N(S({ "extract": N(undefined, S({ POST: P3 })), "extract-stream": N(undefined, S({ POST: P4 })) })) }) })) }) })) }))

export const routes: RouteTree["routes"] = S<RouteTree["routes"][string]>({
	[P0]: { mt: M0 },
	[P1]: { mt: M1 },
	[P2]: { mt: M2 },
	[P3]: { mt: M3 },
	[P4]: { mt: M4 }
})

export type MetaShape = {
	mcp: true
	operationId: "extract.once" | "extract.stream" | "suggest.schema" | "extract.table.once" | "extract.table.stream"
	security: [{ apiKey: ["extract:write"] }]
} & Record<string, unknown>


export type RouteSelector = typeof P0 | typeof P1 | typeof P2 | typeof P3 | typeof P4

export const meta: Record<string, MetaShape> = S({
	[P0]: M0,
	[P1]: M1,
	[P2]: M2,
	[P3]: M3,
	[P4]: M4
})

export const routeTree: RouteTree = { v: 2, root: tree, routes, meta }
