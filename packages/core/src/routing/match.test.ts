import { describe, expect, it } from "vitest"
import { matchRoute, matchWsRoute } from "./match.ts"
import { createNode, insertRoute, insertWsRoute, type TreeNode } from "./tree.ts"
import type { HttpMethod } from "./types.ts"

/** A tree whose leaf for `[method, path]` holds the id `"METHOD path"`. */
function buildTree(routes: Array<[HttpMethod | "ALL", string]>): TreeNode {
	const root = createNode()
	for (const [method, path] of routes) insertRoute(root, method, path, `${method} ${path}`)
	return root
}

const hit = (id: string, params: Record<string, string> = {}) => ({ id, matched: true, params })

function wsTree(...paths: string[]): TreeNode {
	const root = createNode()
	for (const path of paths) insertWsRoute(root, path)
	return root
}

describe("matchRoute — static routes", () => {
	// v0: c824f0cff0
	it("matches /health", () => {
		expect(matchRoute(buildTree([["GET", "/health"]]), "GET", "/health")).toEqual(hit("GET /health"))
	})

	// v0: 46f1f0452d
	it("matches /v1/organizations", () => {
		const root = buildTree([["GET", "/v1/organizations"]])
		expect(matchRoute(root, "GET", "/v1/organizations")).toEqual(hit("GET /v1/organizations"))
	})

	// v0: e10571b9ae
	it("matches root path /", () => {
		expect(matchRoute(buildTree([["GET", "/"]]), "GET", "/")).toEqual(hit("GET /"))
	})
})

describe("matchRoute — param extraction", () => {
	// v0: 5376f26b95
	it("extracts :orgId from /v1/organizations/:orgId", () => {
		const root = buildTree([["GET", "/v1/organizations/:orgId"]])
		expect(matchRoute(root, "GET", "/v1/organizations/abc-123")).toEqual(
			hit("GET /v1/organizations/:orgId", { orgId: "abc-123" }),
		)
	})

	// v0: 2996fa9cf2
	it("extracts multiple params /v1/:orgId/members/:memberId", () => {
		const root = buildTree([["GET", "/v1/:orgId/members/:memberId"]])
		expect(matchRoute(root, "GET", "/v1/org-1/members/user-42")).toEqual(
			hit("GET /v1/:orgId/members/:memberId", { memberId: "user-42", orgId: "org-1" }),
		)
	})
})

describe("matchRoute — wildcards", () => {
	// v0: a02b9b5303
	it("captures named wildcard /files/*path", () => {
		const root = buildTree([["GET", "/files/*path"]])
		expect(matchRoute(root, "GET", "/files/images/photo.png")).toEqual(
			hit("GET /files/*path", { path: "images/photo.png" }),
		)
	})

	// v0: b4c916603f
	it("captures unnamed wildcard /proxy/*", () => {
		const root = buildTree([["GET", "/proxy/*"]])
		expect(matchRoute(root, "GET", "/proxy/api/v1/users")).toEqual(hit("GET /proxy/*", { "*": "api/v1/users" }))
	})

	// v0: 65e1eb3007
	it("wildcard empty remainder /files/*path matches /files/", () => {
		const root = buildTree([["GET", "/files/*path"]])
		expect(matchRoute(root, "GET", "/files/")).toEqual(hit("GET /files/*path", { path: "" }))
	})
})

describe("matchRoute — priority", () => {
	// v0: b7a1786702
	it("static > param > wildcard at same position", () => {
		const root = buildTree([
			["GET", "/users/new"],
			["GET", "/users/:id"],
			["GET", "/users/*rest"],
		])
		expect(matchRoute(root, "GET", "/users/new")).toEqual(hit("GET /users/new"))
	})

	// v0: 46b6f341e6
	it("/users/new wins over /users/:id", () => {
		const root = buildTree([
			["GET", "/users/new"],
			["GET", "/users/:id"],
		])
		expect(matchRoute(root, "GET", "/users/new")).toEqual(hit("GET /users/new"))
		expect(matchRoute(root, "GET", "/users/42")).toEqual(hit("GET /users/:id", { id: "42" }))
	})

	it("backtracks from a static branch that dead-ends to the param branch", () => {
		const root = buildTree([
			["GET", "/users/new/edit"],
			["GET", "/users/:id/posts"],
		])
		expect(matchRoute(root, "GET", "/users/new/posts")).toEqual(hit("GET /users/:id/posts", { id: "new" }))
	})

	it("backtracks from a param branch that dead-ends to the wildcard", () => {
		const root = buildTree([
			["GET", "/files/:id/meta"],
			["GET", "/files/*rest"],
		])
		expect(matchRoute(root, "GET", "/files/a/b")).toEqual(hit("GET /files/*rest", { rest: "a/b" }))
	})
})

describe("matchRoute — ALL method", () => {
	// v0: 7244335a59
	it("ALL key fallback, specific method wins", () => {
		const root = buildTree([
			["GET", "/api"],
			["ALL", "/api"],
		])
		expect(matchRoute(root, "GET", "/api")).toEqual(hit("GET /api"))
		expect(matchRoute(root, "POST", "/api")).toEqual(hit("ALL /api"))
	})

	// v0: 77120aff68
	it("ALL only — all HTTP methods match", () => {
		const root = buildTree([["ALL", "/catch"]])
		for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
			expect(matchRoute(root, method, "/catch"), method).toEqual(hit("ALL /catch"))
		}
	})

	it("serves HEAD from GET when no HEAD route exists", () => {
		const root = buildTree([["GET", "/a"]])
		expect(matchRoute(root, "HEAD", "/a")).toEqual(hit("GET /a"))
		const wild = buildTree([["GET", "/f/*rest"]])
		expect(matchRoute(wild, "HEAD", "/f/x")).toEqual(hit("GET /f/*rest", { rest: "x" }))
	})
})

describe("matchRoute — 404", () => {
	// v0: 50eac8a7bc
	it("no match returns null", () => {
		expect(matchRoute(buildTree([["GET", "/health"]]), "GET", "/missing")).toBeNull()
	})

	// v0: 8191ccbae2
	it("partial path match returns null", () => {
		expect(matchRoute(buildTree([["GET", "/v1/organizations"]]), "GET", "/v1/organizations/abc/extra")).toBeNull()
	})
})

describe("matchRoute — 405", () => {
	// v0: f30c2773af
	it("path exists, wrong method returns allowed array", () => {
		const root = buildTree([
			["GET", "/items"],
			["POST", "/items"],
		])
		expect(matchRoute(root, "DELETE", "/items")).toEqual({ allowed: ["GET", "POST"], matched: false })
	})

	// v0: 3818374d75
	it("does not include ALL in allowed list", () => {
		const root = buildTree([
			["ALL", "/api"],
			["GET", "/api"],
		])
		/* GET matches directly, but DELETE falls through to ALL: a match, not 405 */
		expect(matchRoute(root, "DELETE", "/api")).toEqual(hit("ALL /api"))
	})

	it("lists the leaf's and its wildcard's methods together", () => {
		const root = buildTree([
			["POST", "/f"],
			["PUT", "/f/*rest"],
		])
		expect(matchRoute(root, "GET", "/f")).toEqual({ allowed: ["POST", "PUT"], matched: false })
	})

	it("lists a wildcard's methods, at the end of the path and below it", () => {
		const root = buildTree([["POST", "/f/*rest"]])
		expect(matchRoute(root, "GET", "/f/x")).toEqual({ allowed: ["POST"], matched: false })
		expect(matchRoute(root, "GET", "/f")).toEqual({ allowed: ["POST"], matched: false })
	})
})

describe("matchRoute — edge cases", () => {
	// v0: 319e8bd219
	it("trailing slash handling", () => {
		expect(matchRoute(buildTree([["GET", "/foo"]]), "GET", "/foo/")).toEqual(hit("GET /foo"))
	})

	// v0: 70e0069403
	it("double slashes in path", () => {
		expect(matchRoute(buildTree([["GET", "/foo/bar"]]), "GET", "/foo//bar")).toEqual(hit("GET /foo/bar"))
	})
})

describe("matchRoute — char-based path walking", () => {
	// v0: 29e11bba12
	it("simple path /users matches", () => {
		expect(matchRoute(buildTree([["GET", "/users"]]), "GET", "/users")).toEqual(hit("GET /users"))
	})

	// v0: 4fda8f0951
	it("nested path /users/123/posts matches all segments", () => {
		const root = buildTree([["GET", "/users/:id/posts"]])
		expect(matchRoute(root, "GET", "/users/123/posts")).toEqual(hit("GET /users/:id/posts", { id: "123" }))
	})

	// v0: 12f71bc9d6
	it("trailing slash /users/ matches (empty last segment skipped)", () => {
		expect(matchRoute(buildTree([["GET", "/users"]]), "GET", "/users/")).toEqual(hit("GET /users"))
	})

	// v0: cc080fae94
	it("double slash /users//123 skips empty segment, matches", () => {
		const root = buildTree([["GET", "/users/:id"]])
		expect(matchRoute(root, "GET", "/users//123")).toEqual(hit("GET /users/:id", { id: "123" }))
	})

	// v0: 845449cf61
	it("root path / matches", () => {
		expect(matchRoute(buildTree([["GET", "/"]]), "GET", "/")).toEqual(hit("GET /"))
	})

	// v0: 4b3cd0d4a2
	it("no leading slash still matches", () => {
		expect(matchRoute(buildTree([["GET", "/users"]]), "GET", "users")).toEqual(hit("GET /users"))
	})

	// v0: b16e75459c
	it("path with encoded segment preserves raw encoding in segment", () => {
		const root = buildTree([["GET", "/users/:name"]])
		expect(matchRoute(root, "GET", "/users/john%20doe")).toEqual(hit("GET /users/:name", { name: "john doe" }))
	})
})

describe("matchRoute — char-based path walking", () => {
	// v0: 09c785c318
	it("dynamic param extraction /users/:id with /users/42", () => {
		expect(matchRoute(buildTree([["GET", "/users/:id"]]), "GET", "/users/42")).toEqual(
			hit("GET /users/:id", { id: "42" }),
		)
	})

	// v0: 062b7bb8e1
	it("wildcard /files/*path with /files/a/b/c captures full remainder", () => {
		const root = buildTree([["GET", "/files/*path"]])
		expect(matchRoute(root, "GET", "/files/a/b/c")).toEqual(hit("GET /files/*path", { path: "a/b/c" }))
	})

	// v0: d4ddd7d5f7
	it("wildcard with single segment /files/*path with /files/readme.txt", () => {
		const root = buildTree([["GET", "/files/*path"]])
		expect(matchRoute(root, "GET", "/files/readme.txt")).toEqual(hit("GET /files/*path", { path: "readme.txt" }))
	})

	// v0: 9eae4d8a06
	it("empty wildcard remainder /files/*path with /files/", () => {
		const root = buildTree([["GET", "/files/*path"]])
		expect(matchRoute(root, "GET", "/files/")).toEqual(hit("GET /files/*path", { path: "" }))
	})
})

describe("matchRoute — char-based path walking", () => {
	// v0: 6e55ad0f15
	it("multiple params in single path", () => {
		const root = buildTree([["GET", "/orgs/:orgId/teams/:teamId/members/:memberId"]])
		expect(matchRoute(root, "GET", "/orgs/org-1/teams/team-a/members/user-42")).toEqual(
			hit("GET /orgs/:orgId/teams/:teamId/members/:memberId", {
				memberId: "user-42",
				orgId: "org-1",
				teamId: "team-a",
			}),
		)
	})

	// v0: 0525464b01
	it("encoded special characters decoded correctly", () => {
		const root = buildTree([["GET", "/search/:query"]])
		expect(matchRoute(root, "GET", "/search/hello%26world%3Dfoo")).toEqual(
			hit("GET /search/:query", { query: "hello&world=foo" }),
		)
	})

	// v0: 61ff42916f
	it("segment without percent sign skips decodeURIComponent", () => {
		const root = buildTree([["GET", "/items/:id"]])
		expect(matchRoute(root, "GET", "/items/simple-id-123")).toEqual(hit("GET /items/:id", { id: "simple-id-123" }))
	})

	// v0: e9d772153c
	it("malformed percent encoding returns raw string", () => {
		expect(matchRoute(buildTree([["GET", "/items/:id"]]), "GET", "/items/%ZZ")).toEqual(
			hit("GET /items/:id", { id: "%ZZ" }),
		)
	})
})

describe("param percent-decoding", () => {
	// v0: af05b7c388
	it("decodes %20 as space", () => {
		const root = buildTree([["GET", "/users/:name"]])
		expect(matchRoute(root, "GET", "/users/hello%20world")).toEqual(hit("GET /users/:name", { name: "hello world" }))
	})

	// v0: 4deb992042
	it("decodes unicode %E4%B8%AD%E6%96%87 as chinese chars", () => {
		const root = buildTree([["GET", "/pages/:slug"]])
		expect(matchRoute(root, "GET", "/pages/%E4%B8%AD%E6%96%87")).toEqual(hit("GET /pages/:slug", { slug: "中文" }))
	})

	// v0: 7c3aba2ef4
	it("decodes %2F as literal slash in param", () => {
		const root = buildTree([["GET", "/files/:name"]])
		expect(matchRoute(root, "GET", "/files/a%2Fb")).toEqual(hit("GET /files/:name", { name: "a/b" }))
	})

	// v0: a3fc746fe6
	it("returns raw string for malformed percent sequence", () => {
		const root = buildTree([["GET", "/users/:id"]])
		expect(matchRoute(root, "GET", "/users/%ZZbad")).toEqual(hit("GET /users/:id", { id: "%ZZbad" }))
	})

	// v0: b082df22ce
	it("passes through plain params unchanged", () => {
		expect(matchRoute(buildTree([["GET", "/users/:id"]]), "GET", "/users/42")).toEqual(
			hit("GET /users/:id", { id: "42" }),
		)
	})

	// v0: 0fc90f4c19
	it("decodes multiple params independently", () => {
		const root = buildTree([["GET", "/orgs/:org/users/:name"]])
		expect(matchRoute(root, "GET", "/orgs/%C3%A9co/users/hello%20world")).toEqual(
			hit("GET /orgs/:org/users/:name", { name: "hello world", org: "éco" }),
		)
	})
})

describe("wildcard percent-decoding", () => {
	// v0: 5b135625b4
	it("decodes wildcard remainder", () => {
		const root = buildTree([["GET", "/files/*path"]])
		expect(matchRoute(root, "GET", "/files/docs/my%20file.txt")).toEqual(
			hit("GET /files/*path", { path: "docs/my file.txt" }),
		)
	})

	// v0: 810b89e94a
	it("returns raw wildcard on malformed sequence", () => {
		const root = buildTree([["GET", "/files/*path"]])
		expect(matchRoute(root, "GET", "/files/%ZZ/foo")).toEqual(hit("GET /files/*path", { path: "%ZZ/foo" }))
	})
})

describe("matchWsRoute — path walking", () => {
	// v0: 188e108e01
	// v0: 25297505b7
	it("simple WS path /ws matches", () => {
		expect(matchWsRoute(wsTree("/ws"), "/ws")).toEqual({ id: "WS /ws", params: {} })
	})

	// v0: 7cc911a5b6
	// v0: ae5c4c02ba
	it("WS path with param /chat/:roomId extracts param", () => {
		expect(matchWsRoute(wsTree("/chat/:roomId"), "/chat/room-42")).toEqual({
			id: "WS /chat/:roomId",
			params: { roomId: "room-42" },
		})
	})

	// v0: a72bc0d4a3
	// v0: becd4b7140
	it("WS path with no match returns null", () => {
		expect(matchWsRoute(wsTree("/ws"), "/missing")).toBeNull()
	})

	// v0: 2aceab8dfc
	it("WS path with trailing slash matches", () => {
		expect(matchWsRoute(wsTree("/ws"), "/ws/")).toEqual({ id: "WS /ws", params: {} })
	})

	// v0: 28e35369be
	it("WS path double slash skips empty segment", () => {
		expect(matchWsRoute(wsTree("/chat/:id"), "/chat//abc")).toEqual({ id: "WS /chat/:id", params: { id: "abc" } })
	})

	// v0: 55b9892839
	it("backtracks from a static ws branch that dead-ends to the param branch", () => {
		const root = wsTree("/chat/lobby/x", "/chat/:room")
		expect(matchWsRoute(root, "/chat/lobby")).toEqual({ id: "WS /chat/:room", params: { room: "lobby" } })
		expect(matchWsRoute(root, "/chat/a/b")).toBeNull()
	})
})

describe("websocket param percent-decoding", () => {
	// v0: f9e525aa72
	it("decodes ws route params", () => {
		expect(matchWsRoute(wsTree("/chat/:room"), "/chat/caf%C3%A9")).toEqual({
			id: "WS /chat/:room",
			params: { room: "café" },
		})
	})

	// v0: 3ac61d888a
	it("passes plain ws params unchanged", () => {
		expect(matchWsRoute(wsTree("/chat/:room"), "/chat/general")).toEqual({
			id: "WS /chat/:room",
			params: { room: "general" },
		})
	})
})

describe("matchRoute — performance", () => {
	// v0: dbb7b3212a
	it("1000 routes inserted, matchRoute under 1ms per call", () => {
		const root = createNode()
		for (let i = 0; i < 1000; i++) insertRoute(root, "GET", `/route-${i}/sub`)
		const start = performance.now()
		for (let i = 0; i < 10_000; i++) matchRoute(root, "GET", `/route-${i % 1000}/sub`)
		expect((performance.now() - start) / 10_000).toBeLessThan(1)
	})
})
