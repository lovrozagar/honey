import { describe, expect, it } from "vitest"
import { createNode, insertRoute, insertWsRoute, mergeInto } from "../../../src/tree.ts"

describe("tree — error paths", () => {
	it("duplicate wildcard route throws", () => {
		const root = createNode()
		insertRoute(root, "GET", "/*path")
		expect(() => insertRoute(root, "GET", "/*path")).toThrow("Duplicate route")
	})

	it("duplicate optional param route throws", () => {
		const root = createNode()
		insertRoute(root, "GET", "/users/:id?")
		expect(() => insertRoute(root, "GET", "/users/:id?")).toThrow("Duplicate route")
	})

	it("wildcard name conflict throws", () => {
		const root = createNode()
		insertRoute(root, "GET", "/*foo")
		expect(() => insertRoute(root, "POST", "/*bar")).toThrow("Wildcard name conflict")
	})

	it("mergeInto with param name mismatch throws", () => {
		const target = createNode()
		insertRoute(target, "GET", "/users/:id")

		const source = createNode()
		insertRoute(source, "POST", "/users/:userId")

		expect(() => mergeInto(target, source)).toThrow("param name mismatch")
	})

	it("mergeInto with duplicate wildcard methods throws", () => {
		const target = createNode()
		insertRoute(target, "GET", "/*path")

		const source = createNode()
		insertRoute(source, "GET", "/*path")

		expect(() => mergeInto(target, source)).toThrow("duplicate GET")
	})

	it("mergeInto with wildcard name mismatch throws", () => {
		const target = createNode()
		insertRoute(target, "GET", "/*foo")

		const source = createNode()
		insertRoute(source, "POST", "/*bar")

		expect(() => mergeInto(target, source)).toThrow("wildcard name mismatch")
	})

	it("mergeInto with duplicate WS handlers throws", () => {
		const target = createNode()
		insertWsRoute(target, "/chat")

		const source = createNode()
		insertWsRoute(source, "/chat")

		expect(() => mergeInto(target, source)).toThrow("duplicate WebSocket handler")
	})
})
