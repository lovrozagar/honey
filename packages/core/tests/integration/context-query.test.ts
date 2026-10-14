/**
 * The query on ctx: ctx.search holds each key's first value, ctx.searchAll every value; both, and
 * ctx.headers, are built once per request and have no prototype.
 */
import { describe, expect, it, vi } from "vitest"
import { honey } from "../../src/routing/app.ts"

type Fetchable = { fetch: (r: Request, env: never) => Response | Promise<Response> }

async function send(app: Fetchable, target: string) {
	const res = await app.fetch(new Request(`http://localhost${target}`), {} as never)
	return { body: (await res.json()) as unknown, status: res.status }
}

const ok = (body: unknown) => ({ body, status: 200 })

/** A route reporting the query as ctx.search and ctx.searchAll see it. */
function queryApp() {
	const app = honey<{}>()
	app.get("/q").handler((ctx) => ctx.res.json("ok", { search: { ...ctx.search }, searchAll: { ...ctx.searchAll } }))
	return app
}

describe("ctx.search and ctx.searchAll", () => {
	// v0: cfceceb40b
	// v0: c9d290f508
	// v0: 4c42cc1508
	// v0: 4b97585409
	// v0: 7356e68fee
	// v0: e6e7e3d7f5
	// v0: 95dc922798
	// v0: c693e5af94
	// v0: 6f15033b68
	// v0: f3103b361e
	// v0: a0bccff57c
	// v0: 5ecaf2c0ab
	// v0: e814eb78e0
	// v0: 731d9c5324
	// v0: 0becebad64
	// v0: e82f6c8e4b
	// v0: bbb24285ca
	// v0: 559fd393e4
	// v0: 6fff113f3c
	// v0: ca89698339
	// v0: 7d752fdb69
	it.each([
		["", {}, {}],
		["?", {}, {}],
		["?name=foo", { name: "foo" }, { name: ["foo"] }],
		["?tags=a&tags=b&tags=c", { tags: "a" }, { tags: ["a", "b", "c"] }],
		["?a=1&b=2&b=3&c=4", { a: "1", b: "2", c: "4" }, { a: ["1"], b: ["2", "3"], c: ["4"] }],
		["?key=&flag", { flag: "", key: "" }, { flag: [""], key: [""] }],
		["?x=&x=b&x=", { x: "" }, { x: ["", "b", ""] }],
		["?tag=A&tag=A", { tag: "A" }, { tag: ["A", "A"] }],
		["?q=hello%20world", { q: "hello world" }, { q: ["hello world"] }],
		["?q=hello+world", { q: "hello world" }, { q: ["hello world"] }],
		["?q=hello%2Bworld", { q: "hello+world" }, { q: ["hello+world"] }],
	])("query %j: search holds each key's first value, searchAll every value", async (query, search, searchAll) => {
		expect(await send(queryApp(), `/q${query}`)).toEqual(ok({ search, searchAll }))
	})

	// v0: f53f84ed17
	// v0: 4e4bd462dd
	it("a thousand params, or one value a thousand characters long, are all readable", async () => {
		const query = Array.from({ length: 1000 }, (_, i) => `p${i}=v${i}`).join("&")
		const { search } = (await send(queryApp(), `/q?${query}`)).body as { search: Record<string, string> }
		expect([Object.keys(search).length, search.p0, search.p999]).toEqual([1000, "v0", "v999"])
		const long = (await send(queryApp(), `/q?q=${"x".repeat(1000)}`)).body as { search: Record<string, string> }
		expect(long.search.q).toBe("x".repeat(1000))
	})
})

describe("the query's place: never routed on, parsed once and only when read", () => {
	// v0: 40947b578c
	// v0: 345e93aa3f
	// v0: bfbcc31a4c
	// v0: a21d17f9fa
	it("the query and a fragment never reach routing", async () => {
		const res = await queryApp().fetch(new Request("http://localhost:3000/q?a=1&page=2#frag"), {})
		expect([res.status, await res.json()]).toEqual([
			200,
			{ search: { a: "1", page: "2" }, searchAll: { a: ["1"], page: ["2"] } },
		])
		expect((await queryApp().fetch(new Request("http://localhost/q#section"), {})).status).toBe(200)
	})

	// v0: b923ee605f
	// v0: ba457a0fb3
	// v0: 614be6edbc
	// v0: ed6a95adb5
	it("the query is parsed only when read, once for search and searchAll together", async () => {
		const parses: string[] = []
		class Counting extends URLSearchParams {
			constructor(init?: string) {
				super(init)
				parses.push(String(init))
			}
		}
		const seen: unknown[] = []
		const app = honey<{}>()
		app.get("/q").handler((ctx) => {
			seen.push(parses.length)
			seen.push(ctx.search === ctx.search, ctx.searchAll === ctx.searchAll, parses.length)
			return ctx.res.text("ok", "x")
		})
		app.get("/untouched").handler((ctx) => ctx.res.text("ok", "x"))
		vi.stubGlobal("URLSearchParams", Counting)
		try {
			await app.fetch(new Request("http://localhost/untouched?x=1"), {})
			const untouched = parses.length
			await app.fetch(new Request("http://localhost/q?x=1"), {})
			expect([untouched, seen]).toEqual([0, [0, true, true, 1]])
		} finally {
			vi.unstubAllGlobals()
		}
	})

	// v0: 78e98994c3
	// v0: 4f155bcec2
	// v0: cecf528269
	it("search and headers are built once, and stay readable after the answer is made", async () => {
		let after: unknown
		const app = honey<{}>()
		app.get("/q").handler((ctx) => {
			const res = ctx.res.json("ok", { headers: ctx.headers === ctx.headers, search: ctx.search === ctx.search })
			after = { ...ctx.search }
			return res
		})
		expect(await send(app, "/q?a=1")).toEqual(ok({ headers: true, search: true }))
		expect(after).toEqual({ a: "1" })
	})
})
const PROTO_KEYS = ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"]
describe("records without a prototype", () => {
	// v0: 6ed9c47660
	// v0: 9eb2f48506
	// v0: 22e52939fc
	// v0: 1b6b4a31fa
	it("search, searchAll and headers treat prototype names as plain keys", async () => {
		const app = honey<{}>()
		app.get("/q").handler((ctx) =>
			ctx.res.json("ok", {
				all: PROTO_KEYS.map((k) => ctx.searchAll[k] ?? null),
				first: PROTO_KEYS.map((k) => ctx.search[k] ?? null),
				header: PROTO_KEYS.map((k) => ctx.headers[k] ?? null),
				missing: ctx.search.nope ?? null,
			}),
		)
		const query = PROTO_KEYS.map((k) => `${k}=v-${k}&${k}=w`).join("&")
		expect(await send(app, `/q?${query}`)).toEqual(
			ok({
				all: PROTO_KEYS.map((k) => [`v-${k}`, "w"]),
				first: PROTO_KEYS.map((k) => `v-${k}`),
				header: PROTO_KEYS.map(() => null),
				missing: null,
			}),
		)
		const none = PROTO_KEYS.map(() => null)
		expect(await send(app, "/q")).toEqual(ok({ all: none, first: none, header: none, missing: null }))
	})
})
