import { describe, expect, it } from "vitest"
import { matchRoute } from "./match.ts"
import { parsePattern } from "./pattern.ts"
import type { RouteRecord } from "./record.ts"
import { createNode, findLeaf, insertRoute, insertWsRoute, type RouteEntry, type RouteTree } from "./tree.ts"
import { mergeInto, mergeTree } from "./tree-merge.ts"
import type { HttpMethod } from "./types.ts"

/** A tree in the RouteTree format: ids at leaves, data per id. */
function treeOf(routes: Array<[HttpMethod | "ALL", string, RouteEntry?]>, meta: RouteTree["meta"] = {}): RouteTree {
	const root = createNode()
	const entries: Record<string, RouteEntry> = {}
	for (const [method, path, entry] of routes) entries[insertRoute(root, method, path)] = entry ?? {}
	return { meta, root, routes: entries }
}

/** A fresh tree holding one route (`WS` places a websocket route). */
function nodeWith(method: HttpMethod | "WS", path: string) {
	const node = createNode()
	if (method === "WS") insertWsRoute(node, path)
	else insertRoute(node, method, path)
	return node
}

describe("mergeTree", () => {
	// v0: 9c305251bd
	it("successful merge of disjoint trees", () => {
		const merged = mergeTree(treeOf([["GET", "/a"]]), treeOf([["GET", "/b"]]))
		expect(matchRoute(merged.root, "GET", "/a")).toMatchObject({ id: "GET /a" })
		expect(matchRoute(merged.root, "GET", "/b")).toMatchObject({ id: "GET /b" })
		expect(merged.v).toBe(2)
	})

	// v0: 81d08535c9
	it("conflict on duplicate path+method throws", () => {
		expect(() => mergeTree(treeOf([["GET", "/a"]]), treeOf([["GET", "/a"]]))).toThrow(
			"Merge conflict: duplicate GET /a",
		)
	})

	// v0: c77bf2a0de
	// v0: 00968d6802
	it("conflict on param name mismatch throws", () => {
		expect(() => mergeTree(treeOf([["GET", "/users/:id"]]), treeOf([["POST", "/users/:userId"]]))).toThrow(
			'Merge conflict: param name mismatch at /users: "id" vs "userId"',
		)
	})

	// v0: 741b32d382
	it("merges metadata records", () => {
		const merged = mergeTree(treeOf([["GET", "/a"]], { "GET /a": {} }), treeOf([["GET", "/b"]], { "GET /b": {} }))
		expect(Object.keys(merged.meta)).toEqual(["GET /a", "GET /b"])
	})

	// v0: ec9372f3f1
	it("tuple input injects meta into all routes", () => {
		const tree = treeOf([
			["GET", "/extract", { mt: { auth: "jwt" } }],
			["POST", "/extract", { mt: { auth: false } }],
		])
		const merged = mergeTree([tree, { worker: "extract" }])
		expect(merged.routes["GET /extract"]?.mt).toEqual({ auth: "jwt", worker: "extract" })
		expect(merged.routes["POST /extract"]?.mt).toEqual({ auth: false, worker: "extract" })
		expect(Object.isFrozen(merged.routes["GET /extract"]?.mt)).toBe(true)
	})

	// v0: cdb1cf1751
	it("tuple input sets meta on routes with null mt", () => {
		const merged = mergeTree([treeOf([["GET", "/health", { mt: null }]]), { worker: "local" }])
		expect(merged.routes["GET /health"]?.mt).toEqual({ worker: "local" })
	})

	// v0: f6a5b5628e
	it("tuple and plain inputs can be mixed", () => {
		const merged = mergeTree(treeOf([["GET", "/a"]]), [treeOf([["GET", "/b", { mt: {} }]]), { worker: "svc" }])
		expect(matchRoute(merged.root, "GET", "/a")).toMatchObject({ id: "GET /a" })
		expect(merged.routes["GET /a"]?.mt).toBeUndefined()
		expect(merged.routes["GET /b"]?.mt).toEqual({ worker: "svc" })
	})
})

describe("mergeTree", () => {
	// v0: 74c31f9233
	it("tuple meta overrides the same key", () => {
		const merged = mergeTree([
			treeOf([["GET", "/x", { mt: { auth: "jwt", worker: "original" } }]]),
			{ worker: "override" },
		])
		expect(merged.routes["GET /x"]?.mt).toEqual({ auth: "jwt", worker: "override" })
	})
})

describe("mergeTree", () => {
	// v0: d43114a5ba
	it("tuple injects meta into dynamic/wildcard routes", () => {
		const tree = treeOf([
			["GET", "/users/:id", { mt: {} }],
			["GET", "/files/*path", { mt: {} }],
		])
		const merged = mergeTree([tree, { worker: "api" }])
		expect(merged.routes["GET /users/:id"]?.mt).toEqual({ worker: "api" })
		expect(merged.routes["GET /files/*path"]?.mt).toEqual({ worker: "api" })
	})

	// v0: 78efa1c280
	it("never mutates or shares its inputs", () => {
		const a = treeOf([["GET", "/a", { mt: { k: 1 } }]])
		const merged = mergeTree([a, { worker: "w" }], treeOf([["GET", "/a/b"]]))
		expect(a.routes["GET /a"]?.mt).toEqual({ k: 1 })
		expect(Object.keys(a.root.s.a?.s ?? {})).toEqual([])
		expect(merged.root.s.a).not.toBe(a.root.s.a)
	})

	it("carries extra meta onto a snapshot's live record too", () => {
		const record: RouteRecord = { id: "GET /a", mt: { k: 1 }, rp: "/a", sg: [{ k: "static", v: "a" }] }
		const merged = mergeTree([treeOf([["GET", "/a", { h: record, mt: record.mt }]]), { worker: "w" }])
		expect(merged.routes["GET /a"]?.h).toEqual({ ...record, mt: { k: 1, worker: "w" } })
		expect(record.mt).toEqual({ k: 1 })
	})

	it("refuses a tree from an older format and a route id seen twice", () => {
		expect(() => mergeTree({ meta: {}, root: null, routes: {} } as never)).toThrow(/older honey/)
		const one = treeOf([["GET", "/a"]])
		const other: RouteTree = { meta: {}, root: createNode(), routes: { "GET /a": {} } }
		expect(() => mergeTree(one, other)).toThrow("Merge conflict: duplicate GET /a")
	})
})

describe("mergeInto", () => {
	it("merges param, wildcard and websocket subtrees, copying what the target lacks", () => {
		const target = createNode()
		insertRoute(target, "GET", "/u/:id")
		insertRoute(target, "GET", "/f/*rest")
		const source = createNode()
		insertRoute(source, "POST", "/u/:id/x")
		insertRoute(source, "POST", "/f/*rest")
		insertRoute(source, "GET", "/g/:slug")
		insertRoute(source, "GET", "/w/*")
		insertWsRoute(source, "/live")
		insertRoute(source, "GET", "/")
		mergeInto(target, source)
		for (const [method, path] of [
			["POST", "/u/:id/x"],
			["POST", "/f/*rest"],
			["GET", "/g/:slug"],
			["GET", "/w/*"],
			["WS", "/live"],
			["GET", "/"],
		] as const) {
			expect(findLeaf(target, parsePattern(path), method), `${method} ${path}`).toBe(`${method} ${path}`)
		}
		expect(target.s.g).not.toBe(source.s.g)
	})

	it("adds a param, wildcard or websocket leaf under a node the target already has", () => {
		const target = createNode()
		insertRoute(target, "GET", "/u")
		insertRoute(target, "GET", "/w")
		insertRoute(target, "GET", "/live")
		const source = createNode()
		insertRoute(source, "GET", "/u/:id")
		insertRoute(source, "GET", "/w/*rest")
		insertWsRoute(source, "/live")
		mergeInto(target, source)
		expect(findLeaf(target, parsePattern("/u/:id"), "GET")).toBe("GET /u/:id")
		expect(findLeaf(target, parsePattern("/w/*rest"), "GET")).toBe("GET /w/*rest")
		expect(findLeaf(target, parsePattern("/live"), "WS")).toBe("WS /live")
		expect(target.s.u?.d?.c).not.toBe(source.s.u?.d?.c)
	})
})

describe("mergeInto", () => {
	// v0: becb3889a5
	it("reports a wildcard, websocket or root conflict", () => {
		expect(() => mergeInto(nodeWith("GET", "/f/*a"), nodeWith("GET", "/f/*b"))).toThrow(
			'Merge conflict: wildcard name mismatch at /f: "a" vs "b"',
		)
		expect(() => mergeInto(nodeWith("GET", "/f/*a"), nodeWith("GET", "/f/*a"))).toThrow(
			"Merge conflict: duplicate GET /f/*a",
		)
		expect(() => mergeInto(nodeWith("WS", "/"), nodeWith("WS", "/"))).toThrow(
			"Merge conflict: duplicate WebSocket handler at /",
		)
		expect(() => mergeInto(nodeWith("GET", "/"), nodeWith("GET", "/"))).toThrow("Merge conflict: duplicate GET /")
	})

	// v0: 65f9bc79b6
	// v0: e6bc86c46f
	it("names the root as / in a wildcard or param conflict there", () => {
		expect(() => mergeInto(nodeWith("GET", "/*path"), nodeWith("GET", "/*path"))).toThrow(
			"Merge conflict: duplicate GET /*path",
		)
		expect(() => mergeInto(nodeWith("GET", "/*foo"), nodeWith("POST", "/*bar"))).toThrow(
			'Merge conflict: wildcard name mismatch at /: "foo" vs "bar"',
		)
		expect(() => mergeInto(nodeWith("GET", "/:a"), nodeWith("POST", "/:b"))).toThrow(
			'Merge conflict: param name mismatch at /: "a" vs "b"',
		)
	})
})
