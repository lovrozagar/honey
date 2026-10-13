import { describe, expect, it } from "vitest"
import { encodeSegment, normalizePath, pathOfUrl, searchOfUrl } from "./request-path.ts"

describe("normalizePath: collapsing and resolving", () => {
	// v0: c68e807bb3
	it("leaves canonical paths untouched, returning the same string", () => {
		for (const p of [
			"/",
			"/a",
			"/a/b",
			"/a/b/",
			"/a%20b",
			"/caf%C3%A9",
			"/a.b",
			"/.well-known/x",
			"/a/.b",
			"/v1/books:archive",
		]) {
			expect(normalizePath(p), p).toBe(p)
		}
	})

	// v0: d246753b14
	it("collapses empty segments", () => {
		expect(normalizePath("//admin/secret")).toBe("/admin/secret")
		expect(normalizePath("/admin///users//")).toBe("/admin/users/")
		expect(normalizePath("//")).toBe("/")
	})

	// v0: 3d3a39d677
	it("resolves dot segments, never above the root", () => {
		expect(normalizePath("/a/./b")).toBe("/a/b")
		expect(normalizePath("/a/b/../c")).toBe("/a/c")
		expect(normalizePath("/../../etc/passwd")).toBe("/etc/passwd")
		expect(normalizePath("/files/../admin/secret")).toBe("/admin/secret")
		expect(normalizePath("/a/b/..")).toBe("/a/")
		expect(normalizePath("/a/.")).toBe("/a/")
		expect(normalizePath("/..")).toBe("/")
	})

	// v0: 2b1d68ca68
	it("treats %2e as a dot, in any case", () => {
		expect(normalizePath("/a/%2e%2e/b")).toBe("/b")
		expect(normalizePath("/a/%2E%2E/b")).toBe("/b")
		expect(normalizePath("/a/.%2e/b")).toBe("/b")
		expect(normalizePath("/a/%2e/b")).toBe("/a/b")
		expect(normalizePath("/a%2eb")).toBe("/a%2eb")
		expect(normalizePath("/a/%2e%2e%2e/b")).toBe("/a/%2e%2e%2e/b")
	})
})

describe("normalizePath: separators and encoding", () => {
	// v0: 45a4bc9aa8
	it("rejects encoded separators", () => {
		for (const p of ["/a%2fb", "/a%2Fb", "/a%5cb", "/a%5Cb", "/files/..%2fadmin"]) {
			expect(normalizePath(p), p).toBeNull()
		}
	})

	// v0: 05627fc9b0
	it("reads a backslash as a slash, as URL parsing does", () => {
		expect(normalizePath("/admin\\secret")).toBe("/admin/secret")
		expect(normalizePath("/a\\..\\admin")).toBe("/admin")
	})

	// v0: 02d2d7a8c3
	it("percent-encodes what a URL path cannot hold raw", () => {
		expect(normalizePath("/files/é")).toBe("/files/%C3%A9")
		expect(normalizePath('/a b/"q"')).toBe("/a%20b/%22q%22")
		expect(normalizePath("/{x}/<y>/`z`")).toBe("/%7Bx%7D/%3Cy%3E/%60z%60")
		expect(normalizePath("/\ud800")).toBe("/%EF%BF%BD")
		expect(normalizePath("/files/%")).toBe("/files/%")
		expect(normalizePath("/a\u007fb")).toBe("/a%7Fb")
	})

	// v0: af594803e2
	it("encodes ^ whatever the runtime's URL parser does with it", () => {
		expect(normalizePath("/a^b")).toBe("/a%5Eb")
		expect(normalizePath(new URL("http://h/a^b").pathname)).toBe("/a%5Eb")
	})

	// v0: 70fc22af41
	it("keeps encoded separators when they are allowed", () => {
		expect(normalizePath("/repos/group%2Fproject", "allow")).toBe("/repos/group%2Fproject")
		expect(normalizePath("/a%5Cb", "allow")).toBe("/a%5Cb")
	})

	// v0: a13a53c17e
	it("adds a missing leading slash", () => {
		expect(normalizePath("a/b")).toBe("/a/b")
		expect(normalizePath("")).toBe("/")
	})
})

describe("encodeSegment", () => {
	it("returns a segment that needs nothing unchanged", () => {
		const seg = "users"
		expect(encodeSegment(seg)).toBe(seg)
	})

	it("encodes a route pattern's static segment the way requests arrive", () => {
		expect(encodeSegment("é")).toBe("%C3%A9")
		expect(encodeSegment("a b")).toBe("a%20b")
		expect(encodeSegment("%41")).toBe("%41")
	})
})

describe("pathOfUrl and searchOfUrl", () => {
	// v0: 5a3a15eb3a
	it("split a request URL without new URL()", () => {
		expect(pathOfUrl("http://h/a/b?x=1#f")).toBe("/a/b")
		expect(pathOfUrl("http://h")).toBe("/")
		expect(pathOfUrl("http://h/a#f?x")).toBe("/a")
		expect(searchOfUrl("http://h/a?x=1&y#f")).toBe("?x=1&y")
		expect(searchOfUrl("http://h/a")).toBe("")
	})

	it("read an origin-form target with no scheme", () => {
		expect(pathOfUrl("/a?x")).toBe("/a")
		expect(pathOfUrl("http://h/a/b")).toBe("/a/b")
		expect(searchOfUrl("/a?x")).toBe("?x")
		expect(searchOfUrl("http://h")).toBe("")
	})
})
