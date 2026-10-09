import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"
import type { MiddlewareFn } from "../../../src/middleware.ts"
import { normalizePath, pathOfUrl, searchOfUrl } from "../../../src/request-path.ts"

describe("normalizePath", () => {
	it("leaves canonical paths untouched", () => {
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

	it("collapses empty segments", () => {
		expect(normalizePath("//admin/secret")).toBe("/admin/secret")
		expect(normalizePath("/admin///users//")).toBe("/admin/users/")
		expect(normalizePath("//")).toBe("/")
	})

	it("resolves dot segments, never above the root", () => {
		expect(normalizePath("/a/./b")).toBe("/a/b")
		expect(normalizePath("/a/b/../c")).toBe("/a/c")
		expect(normalizePath("/../../etc/passwd")).toBe("/etc/passwd")
		expect(normalizePath("/files/../admin/secret")).toBe("/admin/secret")
		expect(normalizePath("/a/b/..")).toBe("/a/")
		expect(normalizePath("/a/.")).toBe("/a/")
		expect(normalizePath("/..")).toBe("/")
	})

	it("treats %2e as a dot, in any case", () => {
		expect(normalizePath("/a/%2e%2e/b")).toBe("/b")
		expect(normalizePath("/a/%2E%2E/b")).toBe("/b")
		expect(normalizePath("/a/.%2e/b")).toBe("/b")
		expect(normalizePath("/a/%2e/b")).toBe("/a/b")
		expect(normalizePath("/a%2eb")).toBe("/a%2eb")
	})

	it("rejects encoded separators", () => {
		for (const p of ["/a%2fb", "/a%2Fb", "/a%5cb", "/a%5Cb", "/files/..%2fadmin"]) {
			expect(normalizePath(p), p).toBeNull()
		}
	})

	it("reads a backslash as a slash, as URL parsing does", () => {
		expect(normalizePath("/admin\\secret")).toBe("/admin/secret")
		expect(normalizePath("/a\\..\\admin")).toBe("/admin")
	})

	it("percent-encodes what a URL path cannot hold raw", () => {
		expect(normalizePath("/files/é")).toBe("/files/%C3%A9")
		expect(normalizePath('/a b/"q"')).toBe("/a%20b/%22q%22")
		expect(normalizePath("/{x}/<y>/`z`")).toBe("/%7Bx%7D/%3Cy%3E/%60z%60")
		expect(normalizePath("/\ud800")).toBe("/%EF%BF%BD")
		expect(normalizePath("/files/%")).toBe("/files/%")
	})

	it("keeps encoded separators when they are allowed", () => {
		expect(normalizePath("/repos/group%2Fproject", "allow")).toBe("/repos/group%2Fproject")
		expect(normalizePath("/a%5Cb", "allow")).toBe("/a%5Cb")
	})

	it("adds a missing leading slash", () => {
		expect(normalizePath("a/b")).toBe("/a/b")
		expect(normalizePath("")).toBe("/")
	})

	it("pathOfUrl and searchOfUrl split without new URL()", () => {
		expect(pathOfUrl("http://h/a/b?x=1#f")).toBe("/a/b")
		expect(pathOfUrl("http://h")).toBe("/")
		expect(pathOfUrl("http://h/a#f?x")).toBe("/a")
		expect(searchOfUrl("http://h/a?x=1&y#f")).toBe("?x=1&y")
		expect(searchOfUrl("http://h/a")).toBe("")
	})
})

const auth: MiddlewareFn<{ req: Request }, {}> = (ctx, next) =>
	ctx.req.headers.get("authorization") === "ok" ? next() : new Response("denied", { status: 401 })

describe("the router, scopes and ctx.path see one normalized path", () => {
	function app() {
		const a = honey<{}>()
		a.use("/admin", auth)
		a.get("/admin/secret").handler((ctx) => ctx.res.json("ok", { path: ctx.path, pattern: ctx.routePattern }))
		a.get("/files/*rest").handler((ctx) => ctx.res.json("ok", { path: ctx.path, rest: ctx.params.rest }))
		return a
	}

	it("//admin/secret is /admin/secret everywhere: scope guard, ctx.path and route", async () => {
		const a = app()
		expect((await a.fetch(new Request("http://localhost//admin/secret"), {})).status).toBe(401)
		const res = await a.fetch(new Request("http://localhost//admin/secret", { headers: { authorization: "ok" } }), {})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ path: "/admin/secret", pattern: "/admin/secret" })
	})

	it("a ctx.path.startsWith guard sees the normalized path", async () => {
		const a = honey<{}>().use((ctx, next) =>
			ctx.path.startsWith("/admin") ? new Response("no", { status: 403 }) : next(),
		)
		a.get("/admin/secret").handler((ctx) => ctx.res.text("ok", "secret"))
		for (const p of ["//admin/secret", "/./admin/secret", "/x/../admin/secret", "/%2e/admin/secret"]) {
			const raw = new Request("http://localhost/")
			Object.defineProperty(raw, "url", { value: `http://localhost${p}` })
			expect((await a.fetch(raw, {})).status, p).toBe(403)
		}
	})

	it("dot segments never reach a wildcard param", async () => {
		const raw = new Request("http://localhost/")
		Object.defineProperty(raw, "url", { value: "http://localhost/files/a/../../admin/secret" })
		const res = await app().fetch(raw, {})
		/* resolved to /admin/secret, which the scope guards */
		expect(res.status).toBe(401)
	})

	it("an encoded slash is 400 before routing or middleware", async () => {
		const a = app()
		const res = await a.fetch(new Request("http://localhost/files/..%2fadmin%2fsecret"), {})
		expect(res.status).toBe(400)
		expect(((await res.json()) as { error_key: string }).error_key).toBe("bad_request")
	})

	it("encodedSlashes('allow') decodes an encoded slash into the param, still scoped", async () => {
		const a = app().encodedSlashes("allow")
		const res = await a.fetch(new Request("http://localhost/files/a%2Fb"), {})
		expect(await res.json()).toEqual({ path: "/files/a%2Fb", rest: "a/b" })
	})
})

describe("trailing-slash redirects", () => {
	it("Location is relative and keeps the query", async () => {
		const a = honey<{}>().trailingSlash("strip")
		a.get("/users").handler((ctx) => ctx.res.text("ok", "users"))
		const res = await a.fetch(new Request("https://api.example.com:8443/users/?page=2"), {})
		expect(res.status).toBe(308)
		expect(res.headers.get("location")).toBe("/users?page=2")

		const enforce = honey<{}>().trailingSlash("enforce")
		enforce.get("/users/").handler((ctx) => ctx.res.text("ok", "users"))
		const r2 = await enforce.fetch(new Request("http://internal:3000/users"), {})
		expect(r2.headers.get("location")).toBe("/users/")
	})

	it("never reflects the Host header or emits a protocol-relative Location", async () => {
		const a = honey<{}>().trailingSlash("strip")
		a.get("/evil.example/x").handler((ctx) => ctx.res.text("ok", "x"))
		const res = await a.fetch(new Request("http://attacker.example//evil.example/x/"), {})
		expect(res.headers.get("location")).toBe("/evil.example/x")
	})

	it("keeps the prefix that stripPrefix removes", async () => {
		const a = honey<{}>().stripPrefix("/api").trailingSlash("strip")
		a.get("/users").handler((ctx) => ctx.res.text("ok", "users"))
		const res = await a.fetch(new Request("http://localhost/api/users/"), {})
		expect(res.headers.get("location")).toBe("/api/users")
	})
})
