import { describe, expect, it } from "vitest"
import type { HttpMethod, RouteEntry, RouteHandler, RouteTree, TreeNode } from "../../../src/tree.ts"
import { createNode, insertRoute, matchRoute, mergeTree, overlaySchemas } from "../../../src/tree.ts"

let seq = 0
function makeHandler(label?: string): string {
	return label ?? `h${++seq}`
}

function buildTree(routes: Array<[HttpMethod | "ALL", string]>): TreeNode {
	const root = createNode()
	for (const [method, path] of routes) {
		insertRoute(root, method, path, makeHandler(`${method} ${path}`))
	}
	return root
}

describe("createNode", () => {
	it("returns node with null-prototype static children", () => {
		const node = createNode()
		expect(Object.getPrototypeOf(node.s)).toBeNull()
		expect(node.d).toBeNull()
		expect(node.w).toBeNull()
		expect(node.m).toBeNull()
	})
})

describe("matchRoute — static routes", () => {
	it("matches /health", () => {
		const root = buildTree([["GET", "/health"]])
		const result = matchRoute(root, "GET", "/health")
		expect(result).not.toBeNull()
		expect(result?.matched).toBe(true)
	})

	it("matches /v1/organizations", () => {
		const root = buildTree([["GET", "/v1/organizations"]])
		const result = matchRoute(root, "GET", "/v1/organizations")
		expect(result?.matched).toBe(true)
	})

	it("matches root path /", () => {
		const root = buildTree([["GET", "/"]])
		const result = matchRoute(root, "GET", "/")
		expect(result?.matched).toBe(true)
	})
})

describe("matchRoute — param extraction", () => {
	it("extracts :orgId from /v1/organizations/:orgId", () => {
		const root = buildTree([["GET", "/v1/organizations/:orgId"]])
		const result = matchRoute(root, "GET", "/v1/organizations/abc-123")
		expect(result?.matched).toBe(true)
		if (result?.matched) {
			expect(result.params.orgId).toBe("abc-123")
		}
	})

	it("extracts multiple params /v1/:orgId/members/:memberId", () => {
		const root = buildTree([["GET", "/v1/:orgId/members/:memberId"]])
		const result = matchRoute(root, "GET", "/v1/org-1/members/user-42")
		expect(result?.matched).toBe(true)
		if (result?.matched) {
			expect(result.params.orgId).toBe("org-1")
			expect(result.params.memberId).toBe("user-42")
		}
	})
})

describe("matchRoute — wildcards", () => {
	it("captures named wildcard /files/*path", () => {
		const root = buildTree([["GET", "/files/*path"]])
		const result = matchRoute(root, "GET", "/files/images/photo.png")
		expect(result?.matched).toBe(true)
		if (result?.matched) {
			expect(result.params.path).toBe("images/photo.png")
		}
	})

	it("captures unnamed wildcard /proxy/*", () => {
		const root = buildTree([["GET", "/proxy/*"]])
		const result = matchRoute(root, "GET", "/proxy/api/v1/users")
		expect(result?.matched).toBe(true)
		if (result?.matched) {
			expect(result.params["*"]).toBe("api/v1/users")
		}
	})

	it("wildcard empty remainder /files/*path matches /files/", () => {
		const root = buildTree([["GET", "/files/*path"]])
		const result = matchRoute(root, "GET", "/files/")
		expect(result?.matched).toBe(true)
		if (result?.matched) {
			expect(result.params.path).toBe("")
		}
	})
})

describe("matchRoute — priority", () => {
	it("static > param > wildcard at same position", () => {
		const root = createNode()
		const staticH = makeHandler("static")
		const paramH = makeHandler("param")
		const wildcardH = makeHandler("wildcard")
		insertRoute(root, "GET", "/users/new", staticH)
		insertRoute(root, "GET", "/users/:id", paramH)
		insertRoute(root, "GET", "/users/*rest", wildcardH)

		const result = matchRoute(root, "GET", "/users/new")
		expect(result?.matched).toBe(true)
		if (result?.matched) {
			expect(result.id).toBe(staticH)
		}
	})

	it("/users/new wins over /users/:id", () => {
		const root = createNode()
		const staticH = makeHandler("static")
		const paramH = makeHandler("param")
		insertRoute(root, "GET", "/users/new", staticH)
		insertRoute(root, "GET", "/users/:id", paramH)

		const staticResult = matchRoute(root, "GET", "/users/new")
		expect(staticResult?.matched).toBe(true)
		if (staticResult?.matched) expect(staticResult.id).toBe(staticH)

		const paramResult = matchRoute(root, "GET", "/users/42")
		expect(paramResult?.matched).toBe(true)
		if (paramResult?.matched) expect(paramResult.id).toBe(paramH)
	})
})

describe("matchRoute — ALL method", () => {
	it("ALL key fallback, specific method wins", () => {
		const root = createNode()
		const getH = makeHandler("get")
		const allH = makeHandler("all")
		insertRoute(root, "GET", "/api", getH)
		insertRoute(root, "ALL", "/api", allH)

		const getResult = matchRoute(root, "GET", "/api")
		expect(getResult?.matched).toBe(true)
		if (getResult?.matched) expect(getResult.id).toBe(getH)

		const postResult = matchRoute(root, "POST", "/api")
		expect(postResult?.matched).toBe(true)
		if (postResult?.matched) expect(postResult.id).toBe(allH)
	})

	it("ALL only — all HTTP methods match", () => {
		const root = buildTree([["ALL", "/catch"]])
		const methods: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]
		for (const method of methods) {
			const result = matchRoute(root, method, "/catch")
			expect(result?.matched).toBe(true)
		}
	})
})

describe("matchRoute — 404", () => {
	it("no match returns null", () => {
		const root = buildTree([["GET", "/health"]])
		expect(matchRoute(root, "GET", "/missing")).toBeNull()
	})

	it("partial path match returns null", () => {
		const root = buildTree([["GET", "/v1/organizations"]])
		expect(matchRoute(root, "GET", "/v1/organizations/abc/extra")).toBeNull()
	})
})

describe("matchRoute — 405", () => {
	it("path exists, wrong method returns allowed array", () => {
		const root = buildTree([
			["GET", "/items"],
			["POST", "/items"],
		])
		const result = matchRoute(root, "DELETE", "/items")
		expect(result).not.toBeNull()
		expect(result?.matched).toBe(false)
		if (result && !result.matched) {
			expect(result.allowed).toContain("GET")
			expect(result.allowed).toContain("POST")
		}
	})

	it("does not include ALL in allowed list", () => {
		const root = createNode()
		insertRoute(root, "ALL", "/api", makeHandler())
		insertRoute(root, "GET", "/api", makeHandler())

		/* GET matches directly, but DELETE falls through to ALL — so it's a match, not 405 */
		const result = matchRoute(root, "DELETE", "/api")
		expect(result?.matched).toBe(true)
	})
})

describe("matchRoute — edge cases", () => {
	it("trailing slash handling", () => {
		const root = buildTree([["GET", "/foo"]])
		const result = matchRoute(root, "GET", "/foo/")
		expect(result?.matched).toBe(true)
	})

	it("double slashes in path", () => {
		const root = buildTree([["GET", "/foo/bar"]])
		const result = matchRoute(root, "GET", "/foo//bar")
		expect(result?.matched).toBe(true)
	})
})

describe("insertRoute", () => {
	it("duplicate path+method throws", () => {
		const root = createNode()
		insertRoute(root, "GET", "/health", makeHandler())
		expect(() => insertRoute(root, "GET", "/health", makeHandler())).toThrow()
	})

	it("duplicate param name at same position throws", () => {
		const root = createNode()
		insertRoute(root, "GET", "/users/:id", makeHandler())
		expect(() => insertRoute(root, "GET", "/users/:userId", makeHandler())).toThrow()
	})

	it("builds correct tree for 10+ routes", () => {
		const routes: Array<[HttpMethod, string]> = [
			["GET", "/"],
			["GET", "/health"],
			["GET", "/v1/organizations"],
			["POST", "/v1/organizations"],
			["GET", "/v1/organizations/:orgId"],
			["PUT", "/v1/organizations/:orgId"],
			["DELETE", "/v1/organizations/:orgId"],
			["GET", "/v1/organizations/:orgId/members"],
			["POST", "/v1/organizations/:orgId/members"],
			["GET", "/v1/organizations/:orgId/members/:memberId"],
			["DELETE", "/v1/organizations/:orgId/members/:memberId"],
			["GET", "/files/*path"],
		]
		const root = createNode()
		for (const [method, path] of routes) {
			insertRoute(root, method, path, makeHandler())
		}

		for (const [method, path] of routes) {
			const testPath = path.replace(":orgId", "org-1").replace(":memberId", "m-1").replace("*path", "a/b.txt")
			const result = matchRoute(root, method, testPath)
			expect(result?.matched, `${method} ${testPath}`).toBe(true)
		}
	})
})

/** A tree in the RouteTree format: ids at leaves, data per id. */
function treeOf(routes: Array<[HttpMethod | "ALL", string, RouteEntry?]>, meta: RouteTree["meta"] = {}): RouteTree {
	const root = createNode()
	const entries: Record<string, RouteEntry> = {}
	for (const [method, path, entry] of routes) {
		const id = insertRoute(root, method, path)
		entries[id] = entry ?? {}
	}
	return { meta, root, routes: entries }
}

describe("mergeTree", () => {
	it("successful merge of disjoint trees", () => {
		const merged = mergeTree(treeOf([["GET", "/a"]]), treeOf([["GET", "/b"]]))
		expect(matchRoute(merged.root, "GET", "/a")?.matched).toBe(true)
		expect(matchRoute(merged.root, "GET", "/b")?.matched).toBe(true)
	})

	it("conflict on duplicate path+method throws", () => {
		expect(() => mergeTree(treeOf([["GET", "/a"]]), treeOf([["GET", "/a"]]))).toThrow("Merge conflict")
	})

	it("conflict on param name mismatch throws", () => {
		expect(() => mergeTree(treeOf([["GET", "/users/:id"]]), treeOf([["POST", "/users/:userId"]]))).toThrow(
			"param name mismatch",
		)
	})

	it("merges metadata records", () => {
		const merged = mergeTree(treeOf([["GET", "/a"]], { "GET /a": {} }), treeOf([["GET", "/b"]], { "GET /b": {} }))
		expect(merged.meta).toHaveProperty("GET /a")
		expect(merged.meta).toHaveProperty("GET /b")
	})

	it("tuple input injects meta into all routes", () => {
		const tree = treeOf([
			["GET", "/extract", { mt: { auth: "jwt" } }],
			["POST", "/extract", { mt: { auth: false } }],
		])
		const merged = mergeTree([tree, { worker: "extract" }])
		expect(merged.routes["GET /extract"]?.mt).toEqual({ auth: "jwt", worker: "extract" })
		expect(merged.routes["POST /extract"]?.mt).toEqual({ auth: false, worker: "extract" })
	})

	it("tuple input sets meta on routes with null mt", () => {
		const merged = mergeTree([treeOf([["GET", "/health", { mt: null }]]), { worker: "local" }])
		expect(merged.routes["GET /health"]?.mt).toEqual({ worker: "local" })
	})

	it("tuple and plain inputs can be mixed", () => {
		const merged = mergeTree(treeOf([["GET", "/a"]]), [treeOf([["GET", "/b", { mt: {} }]]), { worker: "svc" }])
		expect(matchRoute(merged.root, "GET", "/a")?.matched).toBe(true)
		expect(merged.routes["GET /a"]?.mt).toBeUndefined()
		expect(merged.routes["GET /b"]?.mt).toEqual({ worker: "svc" })
	})

	it("tuple meta overrides the same key", () => {
		const merged = mergeTree([
			treeOf([["GET", "/x", { mt: { auth: "jwt", worker: "original" } }]]),
			{ worker: "override" },
		])
		expect(merged.routes["GET /x"]?.mt).toEqual({ auth: "jwt", worker: "override" })
	})

	it("tuple injects meta into dynamic/wildcard routes", () => {
		const tree = treeOf([
			["GET", "/users/:id", { mt: {} }],
			["GET", "/files/*path", { mt: {} }],
		])
		const merged = mergeTree([tree, { worker: "api" }])
		expect(merged.routes["GET /users/:id"]?.mt).toEqual({ worker: "api" })
		expect(merged.routes["GET /files/*path"]?.mt).toEqual({ worker: "api" })
	})

	it("never mutates or shares its inputs", () => {
		const a = treeOf([["GET", "/a", { mt: { k: 1 } }]])
		const merged = mergeTree([a, { worker: "w" }], treeOf([["GET", "/a/b"]]))
		expect(a.routes["GET /a"]?.mt).toEqual({ k: 1 })
		expect(Object.keys(a.root.s.a?.s ?? {})).toEqual([])
		expect(merged.root.s.a).not.toBe(a.root.s.a)
	})
})

describe("overlaySchemas", () => {
	it("copies schemas onto registered routes that lack them and keeps their own", async () => {
		const { honey } = await import("../../../src/index.ts")
		const own = { json: { kind: "own" } } as unknown as RouteHandler["iv"]
		const ivB = { json: { kind: "b" } } as unknown as RouteHandler["iv"]
		const app = honey()
		app.post("/a").handler((c) => c.res.text("ok", "a"))
		app.post("/b/:id").handler((c) => c.res.text("ok", "b"))
		const records = (app as unknown as { _graph: { records: Map<string, RouteHandler> } })._graph.records
		const recA = records.get("POST /a")
		if (recA) recA.iv = own
		const source = treeOf([
			["POST", "/a", { iv: { json: {} } as unknown as RouteHandler["iv"] }],
			["POST", "/b/:id", { iv: ivB }],
			["GET", "/missing", { iv: ivB }],
		])
		overlaySchemas(app, source)
		expect(records.get("POST /a")?.iv).toBe(own)
		expect(records.get("POST /b/:id")?.iv).toBe(ivB)
	})
})

describe("matchRoute — performance", () => {
	it("1000 routes inserted, matchRoute under 1ms per call", () => {
		const root = createNode()
		for (let i = 0; i < 1000; i++) {
			insertRoute(root, "GET", `/route-${i}/sub`, makeHandler())
		}

		const start = performance.now()
		const iterations = 10_000
		for (let i = 0; i < iterations; i++) {
			matchRoute(root, "GET", `/route-${i % 1000}/sub`)
		}
		const elapsed = performance.now() - start
		const perCall = elapsed / iterations

		expect(perCall).toBeLessThan(1)
	})
})
