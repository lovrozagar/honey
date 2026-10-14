import { describe, expect, it } from "vitest"
import { honey } from "../../src/routing/app.ts"

describe("root route /", () => {
	// v0: 50a9734c31
	it("root route matches /", async () => {
		const app = honey<{}>()
		app.get("/").handler((ctx) => ctx.res.json("ok", { root: true }))

		const res = await app.fetch(new Request("http://localhost/"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, boolean>
		expect(data.root).toBe(true)
	})
})

describe("wildcard with encoded segments", () => {
	// v0: 4168bd9e45
	it("wildcard with %20 in path → decoded", async () => {
		const app = honey<{}>()
		app.get("/files/*path").handler((ctx) => ctx.res.json("ok", { path: ctx.params.path }))

		const res = await app.fetch(new Request("http://localhost/files/my%20docs/file%20name.txt"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.path).toBe("my docs/file name.txt")
	})
})

describe("all HTTP method registrations", () => {
	// v0: 0b40b00bfb
	it("all 7 methods + ALL → each responds correctly", async () => {
		const app = honey<{}>()
		app.get("/m").handler((ctx) => ctx.res.json("ok", { m: "GET" }))
		app.post("/m").handler((ctx) => ctx.res.json("created", { m: "POST" }))
		app.put("/m").handler((ctx) => ctx.res.json("ok", { m: "PUT" }))
		app.patch("/m").handler((ctx) => ctx.res.json("ok", { m: "PATCH" }))
		app.delete("/m").handler((ctx) => ctx.res.json("ok", { m: "DELETE" }))
		app.options("/m").handler((ctx) => ctx.res.noContent())
		app.head("/m").handler((ctx) => ctx.res.json("ok", { m: "HEAD" }))

		const expected = { DELETE: 200, GET: 200, HEAD: 200, OPTIONS: 204, PATCH: 200, POST: 201, PUT: 200 }
		for (const [method, status] of Object.entries(expected)) {
			expect((await app.fetch(new Request("http://localhost/m", { method }), {})).status, method).toBe(status)
		}
	})
})

describe("route param decode fallback", () => {
	// v0: 46a4e97aa3
	it("param with invalid UTF-8 sequence → returns raw encoded string", async () => {
		const app = honey<{}>()
		app.get("/files/:name").handler((ctx) => ctx.res.json("ok", { name: ctx.params.name }))

		/* %C0 is an invalid UTF-8 continuation byte — decodeURIComponent throws */
		const res = await app.fetch(new Request("http://localhost/files/%C0"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		/* should fall back to the raw value */
		expect(data.name).toBe("%C0")
	})

	// v0: d3abcffb88
	it("param without encoding → returned as-is (no decode needed)", async () => {
		const app = honey<{}>()
		app.get("/items/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

		const res = await app.fetch(new Request("http://localhost/items/plain-text"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.id).toBe("plain-text")
	})
})

describe("unnamed wildcard route", () => {
	// v0: 722ff22ccb
	it("route /files/* with unnamed wildcard → param named '*'", async () => {
		const app = honey<{}>()
		app.get("/files/*").handler((ctx) => ctx.res.json("ok", { wild: ctx.params["*"] }))

		const res = await app.fetch(new Request("http://localhost/files/a/b/c"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.wild).toBe("a/b/c")
	})
})

describe("rapid sequential requests", () => {
	// v0: 0aa60ff52e
	it("100 sequential requests → all isolated", async () => {
		const app = honey<{}>()
		app.get("/echo/:n").handler((ctx) => ctx.res.json("ok", { n: ctx.params.n }))

		for (let i = 0; i < 100; i++) {
			const res = await app.fetch(new Request(`http://localhost/echo/${i}`), {})
			expect(res.status).toBe(200)
			const data = (await res.json()) as Record<string, string>
			expect(data.n).toBe(String(i))
		}
	})
})

describe("single-character paths", () => {
	// v0: 31703df14c
	it("route /a → matches", async () => {
		const app = honey<{}>()
		app.get("/a").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/a"), {})
		expect(res.status).toBe(200)
	})

	// v0: af851d64d4
	it("route /:x → single-char param name works", async () => {
		const app = honey<{}>()
		app.get("/:x").handler((ctx) => ctx.res.json("ok", { x: ctx.params.x }))

		const res = await app.fetch(new Request("http://localhost/hello"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.x).toBe("hello")
	})
})

describe("param values with special characters", () => {
	// v0: db5153c492
	it("param with URL-encoded @ → decoded", async () => {
		const app = honey<{}>()
		app.get("/users/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

		const res = await app.fetch(new Request("http://localhost/users/user%40domain.com"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.id).toBe("user@domain.com")
	})

	// v0: a53f920a23
	it("param with + (not encoded) → stays as +", async () => {
		const app = honey<{}>()
		app.get("/search/:q").handler((ctx) => ctx.res.json("ok", { q: ctx.params.q }))

		const res = await app.fetch(new Request("http://localhost/search/hello+world"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		/* + in URL path is NOT decoded to space (only in query strings) */
		expect(data.q).toBe("hello+world")
	})
})

describe("route matching with double slashes", () => {
	// v0: 98baced32e
	it("double slashes in path → still matches route", async () => {
		const app = honey<{}>()
		app.get("/users/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

		const res = await app.fetch(new Request("http://localhost//users//42"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.id).toBe("42")
	})
})

describe("wildcard route + method not allowed", () => {
	// v0: 67e1958891
	it("wildcard route with wrong method → 405", async () => {
		const app = honey<{}>()
		app.get("/files/*path").handler((ctx) => ctx.res.json("ok", { path: ctx.params.path }))

		const res = await app.fetch(new Request("http://localhost/files/docs/readme.md", { method: "DELETE" }), {})
		expect(res.status).toBe(405)
	})
})

describe("optional route params", () => {
	// v0: a62ff22a0d
	it("optional param matches without value", async () => {
		const app = honey<{}>()
		app.get("/users/:id?").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id ?? "none" }))

		const res = await app.fetch(new Request("http://localhost/users"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.id).toBe("none")
	})

	// v0: 8a79392e36
	it("optional param matches with value", async () => {
		const app = honey<{}>()
		app.get("/users/:id?").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id ?? "none" }))

		const res = await app.fetch(new Request("http://localhost/users/42"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.id).toBe("42")
	})
})

describe("ALL method + specific method priority", () => {
	// v0: 93535ff147
	it("specific method takes priority over ALL", async () => {
		const app = honey<{}>()
		app.all("/resource").handler((ctx) => ctx.res.json("ok", { via: "all" }))
		/* a different route id (GET vs ALL) at the same leaf: allowed, and the exact method wins */
		app.get("/resource").handler((ctx) => ctx.res.json("ok", { via: "get" }))
		expect(await (await app.fetch(new Request("http://localhost/resource"), {})).json()).toEqual({ via: "get" })
		const post = await app.fetch(new Request("http://localhost/resource", { method: "POST" }), {})
		expect(await post.json()).toEqual({ via: "all" })
	})

	// v0: 191f79b6a7
	it("ALL handler matches PUT when no PUT registered", async () => {
		const app = honey<{}>()
		app.all("/resource").handler((ctx) => ctx.res.json("ok", { via: "all" }))

		const res = await app.fetch(new Request("http://localhost/resource", { method: "PUT" }), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.via).toBe("all")
	})
})

describe("extreme path lengths", () => {
	// v0: 4dd3f6c1e7
	it("very long path → 404, no crash", async () => {
		const app = honey<{}>()
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const longPath = `/api/${"a".repeat(10000)}`
		const res = await app.fetch(new Request(`http://localhost${longPath}`), {})
		expect(res.status).toBe(404)
	})

	// v0: 5746507eaa
	it("many path segments → 404, no crash", async () => {
		const app = honey<{}>()
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const manySegments = `/api${"/seg".repeat(500)}`
		const res = await app.fetch(new Request(`http://localhost${manySegments}`), {})
		expect(res.status).toBe(404)
	})
})

describe("wildcard route depth", () => {
	// v0: 435dfc0a98
	it("wildcard captures deeply nested paths", async () => {
		const app = honey<{}>()
		app.get("/files/*path").handler((ctx) => ctx.res.json("ok", { path: ctx.params.path }))

		const res = await app.fetch(new Request("http://localhost/files/a/b/c/d/e.txt"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.path).toBe("a/b/c/d/e.txt")
	})

	// v0: 77099d2ea8
	it("wildcard with empty remainder", async () => {
		const app = honey<{}>()
		app.get("/files/*path").handler((ctx) => ctx.res.json("ok", { path: ctx.params.path }))

		const res = await app.fetch(new Request("http://localhost/files"), {})
		/* should match with empty path */
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.path).toBe("")
	})
})

describe("duplicate route registration", () => {
	// v0: 3ba595eaeb
	it("same method + path twice → throws", () => {
		const app = honey<{}>()
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))
		expect(() => app.get("/api").handler((ctx) => ctx.res.json("ok", {}))).toThrow("Duplicate route")
	})

	// v0: c938683aa6
	it("different methods on same path → allowed", () => {
		const app = honey<{}>()
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))
		expect(() => app.post("/api").handler((ctx) => ctx.res.json("created", {}))).not.toThrow()
	})
})

describe("wildcard name conflict on insertRoute", () => {
	// v0: 8cce2d79a9
	it("different wildcard names at same node → throws", () => {
		const app = honey<{}>()
		app.get("/files/*path").handler((ctx) => ctx.res.json("ok", {}))
		expect(() => app.get("/files/*filepath").handler((ctx) => ctx.res.json("ok", {}))).toThrow("Wildcard name conflict")
	})
})

describe("param name conflict on insertRoute", () => {
	// v0: 30a1012a5a
	it("different param names at same position → throws", () => {
		const app = honey<{}>()
		app.get("/users/:userId").handler((ctx) => ctx.res.json("ok", {}))
		expect(() => app.post("/users/:id").handler((ctx) => ctx.res.json("created", {}))).toThrow("param name conflict")
	})
})

describe("multiple dynamic params", () => {
	// v0: fd12cfc088
	it("/orgs/:orgId/members/:memberId → both params extracted", async () => {
		const app = honey<{}>()
		app.get("/orgs/:orgId/members/:memberId").handler((ctx) =>
			ctx.res.json("ok", {
				memberId: ctx.params.memberId,
				orgId: ctx.params.orgId,
			}),
		)

		const res = await app.fetch(new Request("http://localhost/orgs/acme/members/user-42"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.orgId).toBe("acme")
		expect(data.memberId).toBe("user-42")
	})
})

describe("route param with encoded characters", () => {
	// v0: 4df2cd8ea8
	it("encoded slash %2F in param → 400 by default", async () => {
		const app = honey<{}>()
		app.get("/files/:path").handler((ctx) => ctx.res.json("ok", { path: ctx.params.path }))

		const res = await app.fetch(new Request("http://localhost/files/docs%2Freadme.md"), {})
		expect(res.status).toBe(400)
	})

	// v0: 6927ae9908
	it("encoded slash %2F in param → decoded correctly with encodedSlashes('allow')", async () => {
		const app = honey<{}>().encodedSlashes("allow")
		app.get("/files/:path").handler((ctx) => ctx.res.json("ok", { path: ctx.params.path }))

		/* %2F is encoded slash — the URL parser splits on real / but param
		   segment should contain the encoded version decoded */
		const res = await app.fetch(new Request("http://localhost/files/docs%2Freadme.md"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.path).toBe("docs/readme.md")
	})

	// v0: a13a2b1446
	it("encoded space %20 in param → decoded correctly", async () => {
		const app = honey<{}>()
		app.get("/search/:query").handler((ctx) => ctx.res.json("ok", { query: ctx.params.query }))

		const res = await app.fetch(new Request("http://localhost/search/hello%20world"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.query).toBe("hello world")
	})
})

describe("payload: empty and zero-length edge cases", () => {
	// v0: 2a6b90e677
	it("GET with no body → ctx.req.text() returns empty string", async () => {
		const app = honey<{}>()
		app.get("/nobody").handler(async (ctx) => {
			const body = await ctx.req.text()
			return ctx.res.json("ok", { body, length: body.length })
		})

		const res = await app.fetch(new Request("http://localhost/nobody"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.body).toBe("")
		expect(data.length).toBe(0)
	})
})
