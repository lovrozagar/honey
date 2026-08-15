import { describe, expect, it } from "vitest"
import type { HttpMethod, RouteHandler, TreeNode, WSRouteHandler } from "../../../src/tree.ts"
import {
	createNode,
	insertRoute,
	insertWsRoute,
	matchRoute,
	matchWsRoute,
} from "../../../src/tree.ts"

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

/* ---- char-based path walking in matchRoute ---- */

describe("matchRoute — char-based path walking", () => {
	it("simple path /users matches", () => {
		const root = buildTree([["GET", "/users"]])
		const result = matchRoute(root, "GET", "/users")
		expect(result).not.toBeNull()
		expect(result?.matched).toBe(true)
	})

	it("nested path /users/123/posts matches all segments", () => {
		const root = buildTree([["GET", "/users/:id/posts"]])
		const result = matchRoute(root, "GET", "/users/123/posts")
		expect(result?.matched).toBe(true)
		if (result?.matched) {
			expect(result.params.id).toBe("123")
		}
	})

	it("trailing slash /users/ matches (empty last segment skipped)", () => {
		const root = buildTree([["GET", "/users"]])
		const result = matchRoute(root, "GET", "/users/")
		expect(result?.matched).toBe(true)
	})

	it("double slash /users//123 skips empty segment, matches", () => {
		const root = buildTree([["GET", "/users/:id"]])
		const result = matchRoute(root, "GET", "/users//123")
		expect(result?.matched).toBe(true)
		if (result?.matched) {
			expect(result.params.id).toBe("123")
		}
	})

	it("root path / matches", () => {
		const root = buildTree([["GET", "/"]])
		const result = matchRoute(root, "GET", "/")
		expect(result?.matched).toBe(true)
	})

	it("no leading slash still matches", () => {
		const root = buildTree([["GET", "/users"]])
		/* charCode check: if first char is not '/', pos starts at 0 */
		const result = matchRoute(root, "GET", "users")
		expect(result?.matched).toBe(true)
	})

	it("path with encoded segment preserves raw encoding in segment", () => {
		const root = buildTree([["GET", "/users/:name"]])
		const result = matchRoute(root, "GET", "/users/john%20doe")
		expect(result?.matched).toBe(true)
		if (result?.matched) {
			/* decode() in tree converts %20 to space */
			expect(result.params.name).toBe("john doe")
		}
	})

	it("dynamic param extraction /users/:id with /users/42", () => {
		const root = buildTree([["GET", "/users/:id"]])
		const result = matchRoute(root, "GET", "/users/42")
		expect(result?.matched).toBe(true)
		if (result?.matched) {
			expect(result.params.id).toBe("42")
		}
	})

	it("wildcard /files/*path with /files/a/b/c captures full remainder", () => {
		const root = buildTree([["GET", "/files/*path"]])
		const result = matchRoute(root, "GET", "/files/a/b/c")
		expect(result?.matched).toBe(true)
		if (result?.matched) {
			expect(result.params.path).toBe("a/b/c")
		}
	})

	it("wildcard with single segment /files/*path with /files/readme.txt", () => {
		const root = buildTree([["GET", "/files/*path"]])
		const result = matchRoute(root, "GET", "/files/readme.txt")
		expect(result?.matched).toBe(true)
		if (result?.matched) {
			expect(result.params.path).toBe("readme.txt")
		}
	})

	it("empty wildcard remainder /files/*path with /files/", () => {
		const root = buildTree([["GET", "/files/*path"]])
		const result = matchRoute(root, "GET", "/files/")
		expect(result?.matched).toBe(true)
		if (result?.matched) {
			expect(result.params.path).toBe("")
		}
	})

	it("multiple params in single path", () => {
		const root = buildTree([["GET", "/orgs/:orgId/teams/:teamId/members/:memberId"]])
		const result = matchRoute(root, "GET", "/orgs/org-1/teams/team-a/members/user-42")
		expect(result?.matched).toBe(true)
		if (result?.matched) {
			expect(result.params.orgId).toBe("org-1")
			expect(result.params.teamId).toBe("team-a")
			expect(result.params.memberId).toBe("user-42")
		}
	})

	it("encoded special characters decoded correctly", () => {
		const root = buildTree([["GET", "/search/:query"]])
		const result = matchRoute(root, "GET", "/search/hello%26world%3Dfoo")
		expect(result?.matched).toBe(true)
		if (result?.matched) {
			expect(result.params.query).toBe("hello&world=foo")
		}
	})

	it("segment without percent sign skips decodeURIComponent", () => {
		const root = buildTree([["GET", "/items/:id"]])
		const result = matchRoute(root, "GET", "/items/simple-id-123")
		expect(result?.matched).toBe(true)
		if (result?.matched) {
			expect(result.params.id).toBe("simple-id-123")
		}
	})

	it("malformed percent encoding returns raw string", () => {
		const root = buildTree([["GET", "/items/:id"]])
		const result = matchRoute(root, "GET", "/items/%ZZ")
		expect(result?.matched).toBe(true)
		if (result?.matched) {
			/* decode() catches error and returns raw string */
			expect(result.params.id).toBe("%ZZ")
		}
	})
})

/* ---- matchWsRoute path walking ---- */

describe("matchWsRoute — path walking", () => {
	function makeWsHandler(): WSRouteHandler {
		return {
			bek: null,
			ek: new Set<string>(),
			fn: { onOpen: () => {} },
			iv: null,
			mt: null,
			mw: [],
		}
	}

	it("simple WS path /ws matches", () => {
		const root = createNode()
		insertWsRoute(root, "/ws", makeWsHandler())
		const result = matchWsRoute(root, "/ws")
		expect(result).not.toBeNull()
		expect(result?.handler).toBeDefined()
	})

	it("WS path with param /chat/:roomId extracts param", () => {
		const root = createNode()
		insertWsRoute(root, "/chat/:roomId", makeWsHandler())
		const result = matchWsRoute(root, "/chat/room-42")
		expect(result).not.toBeNull()
		expect(result?.params.roomId).toBe("room-42")
	})

	it("WS path with no match returns null", () => {
		const root = createNode()
		insertWsRoute(root, "/ws", makeWsHandler())
		const result = matchWsRoute(root, "/missing")
		expect(result).toBeNull()
	})

	it("WS route does not support wildcards", () => {
		const root = createNode()
		expect(() => insertWsRoute(root, "/ws/*path", makeWsHandler())).toThrow(
			"Wildcard segments not supported for WebSocket routes",
		)
	})

	it("WS path with trailing slash matches", () => {
		const root = createNode()
		insertWsRoute(root, "/ws", makeWsHandler())
		const result = matchWsRoute(root, "/ws/")
		expect(result).not.toBeNull()
	})

	it("WS path double slash skips empty segment", () => {
		const root = createNode()
		insertWsRoute(root, "/chat/:id", makeWsHandler())
		const result = matchWsRoute(root, "/chat//abc")
		expect(result).not.toBeNull()
		expect(result?.params.id).toBe("abc")
	})
})
