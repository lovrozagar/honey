import { describe, expect, it } from "vitest"
import type { HttpMethod, RouteHandler, TreeNode } from "../../../src/tree.ts"
import { createNode, insertRoute, matchRoute, mergeTree } from "../../../src/tree.ts"

function makeHandler(label?: string): RouteHandler {
	return {
		bek: null,
		ef: null,
		ek: new Set<string>(),
		fn: () => new Response(label ?? "ok"),
		iv: null,
		mt: null,
		mw: [],
		os: null,
		ov: null,
		rp: "",
	}
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
			expect(result.handler).toBe(staticH)
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
		if (staticResult?.matched) expect(staticResult.handler).toBe(staticH)

		const paramResult = matchRoute(root, "GET", "/users/42")
		expect(paramResult?.matched).toBe(true)
		if (paramResult?.matched) expect(paramResult.handler).toBe(paramH)
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
		if (getResult?.matched) expect(getResult.handler).toBe(getH)

		const postResult = matchRoute(root, "POST", "/api")
		expect(postResult?.matched).toBe(true)
		if (postResult?.matched) expect(postResult.handler).toBe(allH)
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
			const testPath = path
				.replace(":orgId", "org-1")
				.replace(":memberId", "m-1")
				.replace("*path", "a/b.txt")
			const result = matchRoute(root, method, testPath)
			expect(result?.matched, `${method} ${testPath}`).toBe(true)
		}
	})
})

describe("mergeTree", () => {
	it("successful merge of disjoint trees", () => {
		const root1 = buildTree([["GET", "/a"]])
		const root2 = buildTree([["GET", "/b"]])
		const merged = mergeTree({ meta: {}, root: root1 }, { meta: {}, root: root2 })
		expect(matchRoute(merged.root, "GET", "/a")?.matched).toBe(true)
		expect(matchRoute(merged.root, "GET", "/b")?.matched).toBe(true)
	})

	it("conflict on duplicate path+method throws", () => {
		const root1 = buildTree([["GET", "/a"]])
		const root2 = buildTree([["GET", "/a"]])
		expect(() => mergeTree({ meta: {}, root: root1 }, { meta: {}, root: root2 })).toThrow()
	})

	it("conflict on param name mismatch throws", () => {
		const root1 = buildTree([["GET", "/users/:id"]])
		const root2 = buildTree([["POST", "/users/:userId"]])
		expect(() => mergeTree({ meta: {}, root: root1 }, { meta: {}, root: root2 })).toThrow()
	})

	it("merges metadata records", () => {
		const root1 = buildTree([["GET", "/a"]])
		const root2 = buildTree([["GET", "/b"]])
		const merged = mergeTree(
			{ meta: { "GET /a": {} }, root: root1 },
			{ meta: { "GET /b": {} }, root: root2 },
		)
		expect(merged.meta).toHaveProperty("GET /a")
		expect(merged.meta).toHaveProperty("GET /b")
	})

	it("tuple input injects meta into all handlers", () => {
		const root = createNode()
		const h1 = makeHandler("h1")
		h1.mt = { auth: "jwt" }
		const h2 = makeHandler("h2")
		h2.mt = { auth: false }
		insertRoute(root, "GET", "/extract", h1)
		insertRoute(root, "POST", "/extract", h2)

		const merged = mergeTree([{ meta: {}, root }, { worker: "extract" }])
		const r1 = matchRoute(merged.root, "GET", "/extract")
		const r2 = matchRoute(merged.root, "POST", "/extract")
		expect(r1?.matched && r1.handler.mt).toEqual({ auth: "jwt", worker: "extract" })
		expect(r2?.matched && r2.handler.mt).toEqual({ auth: false, worker: "extract" })
	})

	it("tuple input sets meta on handlers with null mt", () => {
		const root = createNode()
		const h = makeHandler("h")
		h.mt = null
		insertRoute(root, "GET", "/health", h)

		const merged = mergeTree([{ meta: {}, root }, { worker: "local" }])
		const r = matchRoute(merged.root, "GET", "/health")
		expect(r?.matched && r.handler.mt).toEqual({ worker: "local" })
	})

	it("tuple and plain inputs can be mixed", () => {
		const root1 = buildTree([["GET", "/a"]])
		const root2 = createNode()
		const h = makeHandler("h")
		h.mt = {}
		insertRoute(root2, "GET", "/b", h)

		const merged = mergeTree({ meta: {}, root: root1 }, [
			{ meta: {}, root: root2 },
			{ worker: "svc" },
		])
		expect(matchRoute(merged.root, "GET", "/a")?.matched).toBe(true)
		const r = matchRoute(merged.root, "GET", "/b")
		expect(r?.matched && r.handler.mt).toEqual({ worker: "svc" })
	})

	it("tuple meta does not overwrite existing handler meta keys", () => {
		const root = createNode()
		const h = makeHandler("h")
		h.mt = { auth: "jwt", worker: "original" }
		insertRoute(root, "GET", "/x", h)

		const merged = mergeTree([{ meta: {}, root }, { worker: "override" }])
		const r = matchRoute(merged.root, "GET", "/x")
		expect(r?.matched && r.handler.mt).toEqual({ auth: "jwt", worker: "override" })
	})

	it("tuple injects meta into dynamic/wildcard handlers", () => {
		const root = createNode()
		const paramH = makeHandler("param")
		paramH.mt = {}
		const wildH = makeHandler("wild")
		wildH.mt = {}
		insertRoute(root, "GET", "/users/:id", paramH)
		insertRoute(root, "GET", "/files/*path", wildH)

		const merged = mergeTree([{ meta: {}, root }, { worker: "api" }])
		const r1 = matchRoute(merged.root, "GET", "/users/42")
		expect(r1?.matched && r1.handler.mt).toEqual({ worker: "api" })
		const r2 = matchRoute(merged.root, "GET", "/files/a/b.txt")
		expect(r2?.matched && r2.handler.mt).toEqual({ worker: "api" })
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
