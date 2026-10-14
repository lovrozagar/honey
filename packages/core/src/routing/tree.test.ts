import { describe, expect, it } from "vitest"
import { matchRoute } from "./match.ts"
import { parsePattern } from "./pattern.ts"
import {
	assertTreeFormat,
	cloneTree,
	createNode,
	findLeaf,
	forEachLeaf,
	freezeTree,
	hasWsLeaf,
	insertLeaf,
	insertRoute,
	insertWsRoute,
	type TreeNode,
} from "./tree.ts"
import type { HttpMethod } from "./types.ts"

function leaves(root: TreeNode): string[] {
	const out: string[] = []
	forEachLeaf(root, (method, path, id) => out.push(`${method} ${path} -> ${id}`))
	return out
}

describe("createNode", () => {
	// v0: 0761dfc625
	it("returns node with null-prototype static children", () => {
		const node = createNode()
		expect(Object.getPrototypeOf(node.s)).toBeNull()
		expect(node).toEqual({ d: null, m: null, s: {}, w: null, ws: null })
	})
})

describe("insertRoute", () => {
	// v0: 04b8d66110
	it("duplicate path+method throws", () => {
		const root = createNode()
		insertRoute(root, "GET", "/health")
		expect(() => insertRoute(root, "GET", "/health")).toThrow("Duplicate route: GET /health")
	})

	// v0: c6b17b02e8
	it("duplicate param name at same position throws", () => {
		const root = createNode()
		insertRoute(root, "GET", "/users/:id")
		expect(() => insertRoute(root, "GET", "/users/:userId")).toThrow(
			'Route "/users/:userId": param name conflict — expected ":id" but got ":userId"',
		)
	})

	// v0: 5337ea97c4
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
		for (const [method, path] of routes) insertRoute(root, method, path)
		for (const [method, path] of routes) {
			const target = path.replace(":orgId", "org-1").replace(":memberId", "m-1").replace("*path", "a/b.txt")
			expect(matchRoute(root, method, target), `${method} ${target}`).toMatchObject({ id: `${method} ${path}` })
		}
	})
})

describe("insertRoute", () => {
	it("returns the route id, or places the id it is given", () => {
		const root = createNode()
		expect(insertRoute(root, "GET", "//a/:id/")).toBe("GET /a/:id")
		expect(insertRoute(root, "POST", "/a", "custom")).toBe("custom")
		expect(findLeaf(root, parsePattern("/a"), "POST")).toBe("custom")
	})

	// v0: 578aa3caac
	it("places both variants of an optional last param under one id", () => {
		const root = createNode()
		expect(insertRoute(root, "GET", "/u/:id?")).toBe("GET /u/:id?")
		expect(leaves(root)).toEqual(["GET /u -> GET /u/:id?", "GET /u/:id -> GET /u/:id?"])
		expect(() => insertRoute(root, "GET", "/u")).toThrow("Duplicate route: GET /u")
		expect(() => insertRoute(root, "GET", "/u/:id?")).toThrow("Duplicate route: GET /u")
	})

	// v0: c7bfeb18ec
	// v0: 92b3cd8527
	it("rejects a second wildcard name at one node", () => {
		const root = createNode()
		insertRoute(root, "GET", "/f/*rest")
		expect(() => insertRoute(root, "GET", "/f/*rest")).toThrow("Duplicate route: GET /f/*rest")
		expect(() => insertRoute(root, "POST", "/f/*path")).toThrow('Wildcard name conflict: "rest" vs "path"')
		insertRoute(root, "POST", "/f/*rest")
		expect(() => insertLeaf(root, parsePattern("/f/*rest"), "POST", "other")).toThrow("Duplicate route: POST /f/*rest")
	})

	it("is a no-op when the same id is placed twice", () => {
		const root = createNode()
		insertLeaf(root, parsePattern("/a"), "GET", "x")
		insertLeaf(root, parsePattern("/a"), "GET", "x")
		insertLeaf(root, parsePattern("/f/*"), "GET", "w")
		insertLeaf(root, parsePattern("/f/*"), "GET", "w")
		expect(leaves(root)).toEqual(["GET /a -> x", "GET /f/* -> w"])
	})
})

describe("websocket leaves", () => {
	// v0: 2b4a8364e1
	// v0: 8fff7915ba
	// v0: 56c735670a
	it("places a ws route in its own slot and rejects a duplicate or a wildcard", () => {
		const root = createNode()
		expect(insertWsRoute(root, "/chat/:room")).toBe("WS /chat/:room")
		expect(insertWsRoute(root, "/a", "custom")).toBe("custom")
		expect(() => insertWsRoute(root, "/chat/:room")).toThrow("Duplicate WebSocket route: /chat/:room")
		expect(() => insertLeaf(root, parsePattern("/a"), "WS", "other")).toThrow("Duplicate WebSocket route: /a")
		expect(() => insertWsRoute(root, "/ws/*path")).toThrow("Wildcard segments not supported for WebSocket routes")
		expect(findLeaf(root, parsePattern("/chat/:room"), "WS")).toBe("WS /chat/:room")
	})

	it("knows whether any websocket leaf exists", () => {
		const root = createNode()
		insertRoute(root, "GET", "/a/b")
		expect(hasWsLeaf(root)).toBe(false)
		insertWsRoute(root, "/a/:id/live")
		expect(hasWsLeaf(root)).toBe(true)
		const nested = createNode()
		insertWsRoute(nested, "/x/y")
		expect(hasWsLeaf(nested)).toBe(true)
	})
})

describe("findLeaf", () => {
	it("looks a leaf up by segments without matching values", () => {
		const root = createNode()
		insertRoute(root, "GET", "/a/:id/*rest")
		expect(findLeaf(root, parsePattern("/a/:id/*rest"), "GET")).toBe("GET /a/:id/*rest")
		expect(findLeaf(root, parsePattern("/a/:other/*rest"), "GET")).toBeUndefined()
		expect(findLeaf(root, parsePattern("/a/:id/*path"), "GET")).toBeUndefined()
		expect(findLeaf(root, parsePattern("/b/x"), "GET")).toBeUndefined()
		expect(findLeaf(root, parsePattern("/a/:id/x/y"), "GET")).toBeUndefined()
		expect(findLeaf(root, parsePattern("/a"), "GET")).toBeUndefined()
		expect(findLeaf(root, parsePattern("/a/:id"), "WS")).toBeUndefined()
		expect(findLeaf(createNode(), parsePattern("/x/:id"), "GET")).toBeUndefined()
	})
})

describe("forEachLeaf", () => {
	it("visits every leaf with its concrete pattern", () => {
		const root = createNode()
		insertRoute(root, "GET", "/")
		insertRoute(root, "POST", "/a/:id")
		insertRoute(root, "GET", "/f/*")
		insertRoute(root, "GET", "/g/*rest")
		insertWsRoute(root, "/")
		expect(leaves(root)).toEqual([
			"GET / -> GET /",
			"WS / -> WS /",
			"POST /a/:id -> POST /a/:id",
			"GET /f/* -> GET /f/*",
			"GET /g/*rest -> GET /g/*rest",
		])
	})
})

describe("cloneTree and freezeTree", () => {
	it("copies into fresh nodes that share nothing with the source", () => {
		const root = createNode()
		insertRoute(root, "GET", "/a/:id/*rest")
		insertRoute(root, "GET", "/a")
		insertWsRoute(root, "/a/:id/live")
		const copy = cloneTree(root)
		expect(leaves(copy)).toEqual(leaves(root))
		insertRoute(copy, "POST", "/a")
		expect(findLeaf(root, parsePattern("/a"), "POST")).toBeUndefined()
		expect(Object.getPrototypeOf(copy.s)).toBeNull()
	})

	it("deep-freezes a tree once, so no app mutates a module others import", () => {
		const root = createNode()
		insertRoute(root, "GET", "/a/:id/*rest")
		insertRoute(root, "GET", "/a")
		expect(freezeTree(root)).toBe(root)
		expect(Object.isFrozen(root.s)).toBe(true)
		expect(Object.isFrozen(root.s.a?.m)).toBe(true)
		expect(Object.isFrozen(root.s.a?.d?.c.w?.m)).toBe(true)
		expect(freezeTree(root)).toBe(root)
		expect(() => insertRoute(root, "POST", "/a")).toThrow(TypeError)
	})
})

describe("assertTreeFormat", () => {
	const stale = /generated by an older honey/

	it("accepts a tree whose leaves are route ids", () => {
		const root = createNode()
		insertRoute(root, "GET", "/a/:id/*rest")
		insertWsRoute(root, "/ws")
		expect(() => assertTreeFormat({ root, routes: {} })).not.toThrow()
		const { ws: _ws, ...withoutWs } = createNode()
		expect(() => assertTreeFormat({ root: withoutWs, routes: {} })).not.toThrow()
	})

	it("rejects a tree with handler objects at its leaves, or no tree at all", () => {
		const handlerLeaf = { ...createNode(), m: { GET: { fn() {} } } }
		const wildLeaf = { ...createNode(), w: { m: { GET: {} }, n: "*" } }
		const wsLeaf = { ...createNode(), ws: {} }
		const nested = { ...createNode(), d: { c: handlerLeaf, n: "id" } }
		const underStatic = { ...createNode(), s: { a: handlerLeaf } }
		for (const root of [handlerLeaf, wildLeaf, wsLeaf, nested, underStatic, { ...createNode(), s: null }]) {
			expect(() => assertTreeFormat({ root, routes: {} })).toThrow(stale)
		}
		expect(() => assertTreeFormat(null as never)).toThrow(stale)
		expect(() => assertTreeFormat({ root: null, routes: {} })).toThrow(stale)
		expect(() => assertTreeFormat({ root: createNode(), routes: null })).toThrow(stale)
	})
})
