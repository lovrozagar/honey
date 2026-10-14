import { describe, expect, it } from "vitest"
import { isSensitiveHeader, pathOf, requestBindings, REQUEST_LOG_FIELDS } from "./fields.ts"

describe("pathOf: a path is logged without its query or fragment", () => {
	it.each([
		["a full URL", "https://app.example.com/users/7?token=secret#top", "/users/7"],
		["a path with a query", "/search?q=private", "/search"],
		["a path with only a fragment", "/docs#auth", "/docs"],
		["a bare path", "/health", "/health"],
		["the root of a URL", "https://app.example.com?x=1", "/"],
		["an empty target", "", "/"],
	])("%s", (_name, target, path) => {
		expect(pathOf(target)).toBe(path)
	})
})

describe("requestBindings: what a per-request logger binds", () => {
	it("method, the path without its query, the route id, and the request id only when there is one", () => {
		expect([
			requestBindings("GET", "/users/7?token=secret", "GET /users/:id", "r-1"),
			requestBindings("POST", "/upload", "POST /upload", undefined),
		]).toEqual([
			{ method: "GET", path: "/users/7", requestId: "r-1", routeId: "GET /users/:id" },
			{ method: "POST", path: "/upload", routeId: "POST /upload" },
		])
	})
})

describe("the request-log field catalog", () => {
	it("is closed, and names nothing private", () => {
		expect([...REQUEST_LOG_FIELDS]).toEqual([
			"bytes",
			"durationMs",
			"kind",
			"method",
			"path",
			"requestId",
			"routeId",
			"runtime",
			"status",
		])
		expect(Object.isFrozen(REQUEST_LOG_FIELDS)).toBe(true)
	})
})

describe("isSensitiveHeader: what never reaches a log line or a span", () => {
	it.each([
		["cookie", true],
		["Set-Cookie", true],
		["Authorization", true],
		["proxy-authorization", true],
		["x-api-key", true],
		["x-auth-token", true],
		["X-CSRF-Token", true],
		["x-xsrf-token", true],
		["x-session-id", true],
		["x-refresh-token", true],
		["x-client-secret", true],
		["x-password", true],
		["apikey", true],
		["x-api-key-id", true],
		["content-type", false],
		["x-request-id", false],
		["x-tokenizer", false],
		["x-secretary", false],
		["cache-control", false],
	])("%s: %s", (name, sensitive) => {
		expect(isSensitiveHeader(name)).toBe(sensitive)
	})
})
