import { describe, expect, it } from "vitest"
import {
	canonical,
	expandOptional,
	formatSegment,
	isStaticPattern,
	joinPatterns,
	normalizePattern,
	parsePattern,
	pathInScope,
	patternParams,
	routeId,
	scopeCoverage,
	splitRouteId,
	toOpenApiTemplate,
} from "./pattern.ts"

describe("parsePattern: the grammar", () => {
	it("reads static, param, optional param and wildcard segments", () => {
		expect(parsePattern("/users/:id/files/*rest")).toEqual([
			{ k: "static", v: "users" },
			{ k: "param", n: "id", o: false },
			{ k: "static", v: "files" },
			{ k: "wildcard", n: "rest" },
		])
		expect(parsePattern("/opt/:id?")).toEqual([
			{ k: "static", v: "opt" },
			{ k: "param", n: "id", o: true },
		])
		expect(parsePattern("/files/*")).toEqual([
			{ k: "static", v: "files" },
			{ k: "wildcard", n: "*" },
		])
	})

	// v0: 8e72644e69
	it("canonicalizes slashes", () => {
		expect(normalizePattern("admin/x")).toBe("/admin/x")
		expect(normalizePattern("//admin//b/")).toBe("/admin/b")
		expect(normalizePattern("/")).toBe("/")
		expect(normalizePattern("")).toBe("/")
		expect(normalizePattern("/files/*")).toBe("/files/*")
		expect(normalizePattern("/opt/:id?")).toBe("/opt/:id?")
		expect(canonical(parsePattern("/u/:user-id"))).toBe("/u/:user-id")
	})

	// v0: c372766cc0
	it("rejects what it cannot express", () => {
		expect(() => parsePattern("/f/:name.json")).toThrow(/not a valid name/)
		expect(() => parsePattern("/a/*rest/b")).toThrow(/last segment/)
		expect(() => parsePattern("/a/:id?/b")).toThrow(/optional parameter must be the last/)
		expect(() => parsePattern("/a/../b")).toThrow(/"\.\." segments/)
		expect(() => parsePattern("/a/:id/b/:id")).toThrow(/appears twice/)
		expect(() => parsePattern("/items?x=1")).toThrow(/query strings/)
	})

	it("rejects the rest of what a route pattern cannot hold", () => {
		expect(() => parsePattern(42 as never)).toThrow(/Invalid route pattern "42": must be a string/)
		expect(() => parsePattern("/a#b")).toThrow(/fragments/)
		expect(() => parsePattern("/f/*1x")).toThrow(/wildcard "\*1x" is not a valid name/)
		expect(() => parsePattern("/:rest/*rest")).toThrow(/"rest" appears twice/)
		expect(() => parsePattern("/a/./b")).toThrow(/"\." segments/)
	})

	it("encodes a literal the way the request path is encoded, so it can be requested", () => {
		expect(normalizePattern("/é/a b/x^y")).toBe("/%C3%A9/a%20b/x%5Ey")
		expect(normalizePattern("/%C3%A9")).toBe("/%C3%A9")
		expect(() => parsePattern("/a/%2e%2E")).toThrow(/segments are not allowed/)
	})
})

describe("printing and joining patterns", () => {
	it("prints each segment the way it is written", () => {
		expect(formatSegment({ k: "static", v: "a" })).toBe("a")
		expect(formatSegment({ k: "param", n: "id", o: false })).toBe(":id")
		expect(formatSegment({ k: "param", n: "id", o: true })).toBe(":id?")
		expect(formatSegment({ k: "wildcard", n: "*" })).toBe("*")
		expect(formatSegment({ k: "wildcard", n: "rest" })).toBe("*rest")
		expect(canonical([])).toBe("/")
	})

	// v0: 9fc9f82bdf
	it("joinPatterns rejects a param name used on both sides", () => {
		expect(joinPatterns("/api/", "users")).toBe("/api/users")
		expect(() => joinPatterns("/:id", "/:id?")).toThrow(/appears twice/)
	})

	it("joinPatterns appends nothing after a wildcard or an optional param", () => {
		expect(joinPatterns("/files/*", "/")).toBe("/files/*")
		expect(joinPatterns("/", "/a")).toBe("/a")
		expect(() => joinPatterns("/files/*", "/x")).toThrow(/cannot append to a wildcard or optional parameter/)
		expect(() => joinPatterns("/u/:id?", "/x")).toThrow(/cannot append/)
		expect(joinPatterns("/u/:id", "/x")).toBe("/u/:id/x")
	})
})

describe("pattern facts", () => {
	it("expands an optional last param into both concrete variants", () => {
		expect(expandOptional(parsePattern("/u/:id?")).map(canonical)).toEqual(["/u", "/u/:id"])
		expect(expandOptional(parsePattern("/u/:id")).map(canonical)).toEqual(["/u/:id"])
		expect(expandOptional([]).map(canonical)).toEqual(["/"])
	})

	it("knows a static pattern and lists param names in order", () => {
		expect(isStaticPattern(parsePattern("/a/b"))).toBe(true)
		expect(isStaticPattern(parsePattern("/a/:b"))).toBe(false)
		expect(patternParams(parsePattern("/a/:b/c/*rest"))).toEqual(["b", "rest"])
	})

	it("joins and splits a route id at the first space", () => {
		expect(routeId("GET", "/a b")).toBe("GET /a b")
		expect(splitRouteId("GET /a b")).toEqual({ method: "GET", pattern: "/a b" })
	})

	it("prints an OpenAPI path template", () => {
		expect(toOpenApiTemplate([])).toBe("/")
		expect(toOpenApiTemplate(parsePattern("/u/:user-id/files/*rest"))).toBe("/u/{user-id}/files/{rest}")
		expect(toOpenApiTemplate(parsePattern("/files/*"))).toBe("/files/{wildcard}")
	})
})

const cover = (route: string, scope: string) => scopeCoverage(parsePattern(route), parsePattern(scope))
const inScope = (path: string, scope: string) => pathInScope(path, parsePattern(scope))

describe("scopeCoverage: decided at registration", () => {
	it("covers every path, none, or only some", () => {
		expect(cover("/admin/users", "/admin")).toBe("all")
		expect(cover("/public", "/admin")).toBe("none")
		expect(cover("/:section/users", "/admin")).toBe("some")
		expect(cover("/files/*", "/files/secret")).toBe("some")
		expect(cover("/admin", "/admin/users")).toBe("none")
	})

	it("treats a scope wildcard or optional last param as covering everything below", () => {
		expect(cover("/admin/a/b", "/admin/*")).toBe("all")
		expect(cover("/admin/a", "/admin/:x?")).toBe("all")
		expect(cover("/:org/a", "/admin/*")).toBe("some")
		expect(cover("/orgs/1/a", "/orgs/:id")).toBe("all")
	})

	it("combines an optional route param's variants", () => {
		expect(cover("/admin/:id?", "/admin")).toBe("all")
		expect(cover("/admin/:id?", "/admin/x")).toBe("some")
	})

	it("compares encoded literals by their decoded bytes", () => {
		expect(cover("/%C3%A9/x", "/%c3%a9")).toBe("all")
		expect(cover("/%E0%A4%A/x", "/%E0%A4%A")).toBe("all")
		expect(cover("/%ZZ/x", "/%zz")).toBe("none")
	})
})

describe("pathInScope: decided per request", () => {
	it("matches leading segments, ignoring empty ones", () => {
		expect(inScope("/admin/users", "/admin")).toBe(true)
		expect(inScope("//admin//users", "/admin")).toBe(true)
		expect(inScope("/administrator", "/admin")).toBe(false)
		expect(inScope("/", "/admin")).toBe(false)
		expect(inScope("/orgs/7/x", "/orgs/:id")).toBe(true)
	})

	it("covers everything below a wildcard or optional param", () => {
		expect(inScope("/admin", "/admin/*")).toBe(true)
		expect(inScope("/admin/a/b", "/admin/:x?")).toBe(true)
	})

	it("compares a segment as sent and decoded", () => {
		expect(inScope("/%c3%a9/x", "/é")).toBe(true)
		expect(inScope("/é", "/é")).toBe(true)
	})
})
