/**
 * Path params through `app.fetch`: what a pattern captures (names, decoding, literals that are not
 * params, wildcards and optional params). Every case asserts the whole answer.
 */ import { describe, expect, it } from "vitest"
import { type Honey, honey } from "../../src/routing/app.ts"
import { normalizePattern, parsePattern } from "../../src/routing/pattern.ts"
import type { HttpMethod } from "../../src/routing/types.ts"

type App = Honey<{}>
type Echo = { method: string; params: Record<string, string>; path: string; pattern: string }

/** An app whose routes answer with the method, params, ctx.path and pattern they saw. */
function echoApp(routes: ReadonlyArray<readonly [HttpMethod | "ALL", string]>): App {
	const app = honey<{}>()
	for (const [method, pattern] of routes) {
		app
			.on([method], pattern)
			.handler((ctx) =>
				ctx.res.json("ok", { method: ctx.req.method, params: ctx.params, path: ctx.path, pattern: ctx.routePattern }),
			)
	}
	return app
}

async function send(app: App, target: string, init?: RequestInit) {
	const res = await app.fetch(new Request(`http://localhost${target}`, init), {})
	return { allow: res.headers.get("allow"), body: await res.text(), status: res.status }
}

async function echo(app: App, target: string, init?: RequestInit): Promise<Echo> {
	const res = await send(app, target, init)
	expect(res.status, `${init?.method ?? "GET"} ${target}`).toBe(200)
	return JSON.parse(res.body) as Echo
}

describe("path params: capture and names", () => {
	// v0: fd12cfc088
	// v0: b8488bc5a6
	// v0: ddd8a7fc9a
	// v0: af851d64d4
	// v0: 31703df14c
	it.each([
		["/a", "/a", {}],
		["/:x", "/q", { x: "q" }],
		["/orgs/:orgId/members/:memberId", "/orgs/o1/members/m2", { memberId: "m2", orgId: "o1" }],
		["/a/:b/c/:d/e/:f/g/:h", "/a/1/c/2/e/3/g/4", { b: "1", d: "2", f: "3", h: "4" }],
	])("%s captures every param it names from %s", async (pattern, target, params) => {
		const app = echoApp([["GET", pattern]])
		expect(await echo(app, target)).toEqual({ method: "GET", params, path: target, pattern })
	})
})

describe("path params: decoding", () => {
	// v0: a13a2b1446
	// v0: bc9f716611
	// v0: db5153c492
	// v0: a53f920a23
	// v0: b179cf8c99
	// v0: 7a8ae71e94
	// v0: d3abcffb88
	// v0: 46a4e97aa3
	it.each([
		["plain", "plain"],
		["a%20b", "a b"],
		["a%20b%2Bc", "a b+c"],
		["user%40example.com", "user@example.com"],
		["a+b", "a+b"],
		["caf%C3%A9", "café"],
		["%F0%9F%8D%AF", "🍯"],
		["%E0%A4%A", "%E0%A4%A"],
	])("a param sent as %s reads %s", async (sent, value) => {
		const app = echoApp([["GET", "/v/:value"]])
		expect((await echo(app, `/v/${sent}`)).params).toEqual({ value })
	})

	// v0: aa339b4531
	// v0: 8ac0edfc93
	it("a param named like a prototype key is an own value and touches no prototype", async () => {
		const before = Object.getOwnPropertyNames(Object.prototype)
		const app = echoApp([
			["GET", "/items/:__proto__"],
			["GET", "/things/:prototype"],
		])
		const proto = (await echo(app, "/items/safe")).params
		expect(Object.hasOwn(proto, "__proto__")).toBe(true)
		expect(proto["__proto__"]).toBe("safe")
		expect((await echo(app, "/things/evil")).params).toEqual({ prototype: "evil" })
		expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(before)
	})

	// v0: d96623e492
	it("an empty segment does not fill a param", async () => {
		const app = echoApp([["GET", "/users/:id"]])
		expect((await send(app, "/users/")).status).toBe(404)
		expect((await echo(app, "/users/7")).params).toEqual({ id: "7" })
	})
})

describe("literal segments", () => {
	// v0: 053ac894d6
	// v0: 3c2b1bb0f7
	// v0: 3cf829405e
	it.each(["/api/v1.0/test", "/files/[id]", "/group(1)"])("%s is a literal, not a pattern", async (pattern) => {
		const app = echoApp([["GET", pattern]])
		expect(await echo(app, pattern)).toMatchObject({ params: {}, pattern })
		expect((await send(app, pattern.replace(/[.[(]/, "x"))).status).toBe(404)
	})

	// v0: 17759e784b
	it("a literal is encoded the way the request path is, so either spelling reaches it", async () => {
		expect(normalizePattern("/é/a b/x^y")).toBe("/%C3%A9/a%20b/x%5Ey")
		expect(normalizePattern("/%C3%A9")).toBe("/%C3%A9")
		expect(() => parsePattern("/a/%2e%2E")).toThrow(/segments are not allowed/)
		const app = echoApp([["GET", "/é/a b"]])
		for (const target of ["/é/a b", "/%C3%A9/a%20b"]) {
			expect(await echo(app, target)).toMatchObject({ path: "/%C3%A9/a%20b", pattern: "/%C3%A9/a%20b" })
		}
	})
})

describe("wildcards and optional params", () => {
	// v0: 0d8247d678
	// v0: 435dfc0a98
	// v0: 088d9fe73f
	// v0: 77099d2ea8
	// v0: 37425c7390
	// v0: 6e7976882b
	// v0: bbc08090bf
	// v0: 4168bd9e45
	// v0: 722ff22ccb
	it.each([
		["/files/*rest", "/files/a/b/c/d/e", { rest: "a/b/c/d/e" }],
		["/files/*rest", "/files", { rest: "" }],
		["/files/*rest", "/files/", { rest: "" }],
		["/files/*rest", "/files/a/b/", { rest: "a/b/" }],
		["/files/*rest", "/files/a%20b", { rest: "a b" }],
		["/blob/*", "/blob/x/y", { "*": "x/y" }],
	])("%s on %s captures %j", async (pattern, target, params) => {
		const app = echoApp([["GET", pattern]])
		expect(await echo(app, target)).toEqual({ method: "GET", params, path: target, pattern })
	})

	// v0: a62ff22a0d
	// v0: 8a79392e36
	it("an optional last param matches with and without its segment", async () => {
		const app = echoApp([["GET", "/opt/:id?"]])
		expect(await echo(app, "/opt")).toEqual({ method: "GET", params: {}, path: "/opt", pattern: "/opt/:id?" })
		expect((await echo(app, "/opt/7")).params).toEqual({ id: "7" })
	})
})
