import { describe, expect, it } from "vitest"
import type { RouteHandler, WSRouteHandler } from "../../../src/tree.ts"
import { createNode, insertRoute, insertWsRoute, mergeInto } from "../../../src/tree.ts"

function stubHandler(path = "/stub"): RouteHandler {
	return {
		bek: null,
		ef: null,
		ek: new Set(),
		fn: () => new Response("ok"),
		iv: null,
		mt: null,
		mw: [],
		os: null,
		ov: null,
		rp: path,
	}
}

function stubWsHandler(): WSRouteHandler {
	return {
		bek: null,
		ek: new Set(),
		fn: { onMessage() {} },
		iv: null,
		mt: null,
		mw: [],
	}
}

describe("tree — error paths", () => {
	it("duplicate wildcard route throws", () => {
		const root = createNode()
		insertRoute(root, "GET", "/*path", stubHandler("/*path"))
		expect(() => insertRoute(root, "GET", "/*path", stubHandler("/*path"))).toThrow(
			"Duplicate route",
		)
	})

	it("duplicate optional param route throws", () => {
		const root = createNode()
		insertRoute(root, "GET", "/users/:id?", stubHandler("/users/:id?"))
		expect(() => insertRoute(root, "GET", "/users/:id?", stubHandler("/users/:id?"))).toThrow(
			"Duplicate route",
		)
	})

	it("wildcard name conflict throws", () => {
		const root = createNode()
		insertRoute(root, "GET", "/*foo", stubHandler("/*foo"))
		expect(() => insertRoute(root, "POST", "/*bar", stubHandler("/*bar"))).toThrow(
			"Wildcard name conflict",
		)
	})

	it("mergeInto with param name mismatch throws", () => {
		const target = createNode()
		insertRoute(target, "GET", "/users/:id", stubHandler("/users/:id"))

		const source = createNode()
		insertRoute(source, "POST", "/users/:userId", stubHandler("/users/:userId"))

		expect(() => mergeInto(target, source)).toThrow("param name mismatch")
	})

	it("mergeInto with duplicate wildcard methods throws", () => {
		const target = createNode()
		insertRoute(target, "GET", "/*path", stubHandler("/*path"))

		const source = createNode()
		insertRoute(source, "GET", "/*path", stubHandler("/*path"))

		expect(() => mergeInto(target, source)).toThrow("duplicate GET")
	})

	it("mergeInto with wildcard name mismatch throws", () => {
		const target = createNode()
		insertRoute(target, "GET", "/*foo", stubHandler("/*foo"))

		const source = createNode()
		insertRoute(source, "POST", "/*bar", stubHandler("/*bar"))

		expect(() => mergeInto(target, source)).toThrow("wildcard name mismatch")
	})

	it("mergeInto with duplicate WS handlers throws", () => {
		const target = createNode()
		insertWsRoute(target, "/chat", stubWsHandler())

		const source = createNode()
		insertWsRoute(source, "/chat", stubWsHandler())

		expect(() => mergeInto(target, source)).toThrow("duplicate WebSocket handler")
	})
})
