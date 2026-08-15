import { describe, expect, it } from "vitest"
import type { HttpMethod, RouteHandler, WSRouteHandler } from "../../../src/tree.ts"
import {
	createNode,
	insertRoute,
	insertWsRoute,
	matchRoute,
	matchWsRoute,
} from "../../../src/tree.ts"

function makeHandler(): RouteHandler {
	return {
		bek: null,
		ef: null,
		ek: new Set<string>(),
		fn: () => new Response("ok"),
		iv: null,
		mt: null,
		mw: [],
		os: null,
		ov: null,
		rp: "",
	}
}

function makeWsHandler(): WSRouteHandler {
	return {
		bek: null,
		ek: new Set<string>(),
		fn: {},
		iv: null,
		mt: null,
		mw: [],
	}
}

function buildTree(routes: Array<[HttpMethod | "ALL", string]>) {
	const root = createNode()
	for (const [method, path] of routes) {
		insertRoute(root, method, path, makeHandler())
	}
	return root
}

describe("param percent-decoding", () => {
	it("decodes %20 as space", () => {
		const root = buildTree([["GET", "/users/:name"]])
		const result = matchRoute(root, "GET", "/users/hello%20world")
		expect(result?.matched).toBe(true)
		if (result?.matched) {
			expect(result.params.name).toBe("hello world")
		}
	})

	it("decodes unicode %E4%B8%AD%E6%96%87 as chinese chars", () => {
		const root = buildTree([["GET", "/pages/:slug"]])
		const result = matchRoute(root, "GET", "/pages/%E4%B8%AD%E6%96%87")
		expect(result?.matched).toBe(true)
		if (result?.matched) {
			expect(result.params.slug).toBe("中文")
		}
	})

	it("decodes %2F as literal slash in param", () => {
		const root = buildTree([["GET", "/files/:name"]])
		const result = matchRoute(root, "GET", "/files/a%2Fb")
		expect(result?.matched).toBe(true)
		if (result?.matched) {
			expect(result.params.name).toBe("a/b")
		}
	})

	it("returns raw string for malformed percent sequence", () => {
		const root = buildTree([["GET", "/users/:id"]])
		const result = matchRoute(root, "GET", "/users/%ZZbad")
		expect(result?.matched).toBe(true)
		if (result?.matched) {
			expect(result.params.id).toBe("%ZZbad")
		}
	})

	it("passes through plain params unchanged", () => {
		const root = buildTree([["GET", "/users/:id"]])
		const result = matchRoute(root, "GET", "/users/42")
		expect(result?.matched).toBe(true)
		if (result?.matched) {
			expect(result.params.id).toBe("42")
		}
	})

	it("decodes multiple params independently", () => {
		const root = buildTree([["GET", "/orgs/:org/users/:name"]])
		const result = matchRoute(root, "GET", "/orgs/%C3%A9co/users/hello%20world")
		expect(result?.matched).toBe(true)
		if (result?.matched) {
			expect(result.params.org).toBe("éco")
			expect(result.params.name).toBe("hello world")
		}
	})
})

describe("wildcard percent-decoding", () => {
	it("decodes wildcard remainder", () => {
		const root = buildTree([["GET", "/files/*path"]])
		const result = matchRoute(root, "GET", "/files/docs/my%20file.txt")
		expect(result?.matched).toBe(true)
		if (result?.matched) {
			expect(result.params.path).toBe("docs/my file.txt")
		}
	})

	it("returns raw wildcard on malformed sequence", () => {
		const root = buildTree([["GET", "/files/*path"]])
		const result = matchRoute(root, "GET", "/files/%ZZ/foo")
		expect(result?.matched).toBe(true)
		if (result?.matched) {
			expect(result.params.path).toBe("%ZZ/foo")
		}
	})
})

describe("websocket param percent-decoding", () => {
	it("decodes ws route params", () => {
		const root = createNode()
		insertWsRoute(root, "/chat/:room", makeWsHandler())
		const result = matchWsRoute(root, "/chat/caf%C3%A9")
		expect(result).not.toBeNull()
		expect(result?.params.room).toBe("café")
	})

	it("passes plain ws params unchanged", () => {
		const root = createNode()
		insertWsRoute(root, "/chat/:room", makeWsHandler())
		const result = matchWsRoute(root, "/chat/general")
		expect(result).not.toBeNull()
		expect(result?.params.room).toBe("general")
	})
})
