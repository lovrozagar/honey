import { describe, expect, it } from "vitest"
import { defineMiddleware, type RuntimeMiddleware } from "../middleware/middleware.ts"
import { GRAPH, honey } from "./app.ts"
import { parsePattern } from "./pattern.ts"
import {
	addChain,
	addRoute,
	assertNothingDiscarded,
	chainErrorKeys,
	createGraph,
	markUsed,
	mount,
	ROOT_VIEW,
	type RouteSource,
} from "./register.ts"

const get = <E>(app: { fetch: (r: Request, env: E) => Response | Promise<Response> }, path: string) =>
	app.fetch(new Request(`http://h${path}`), {} as E)
const pass: RuntimeMiddleware = (_ctx, next) => next()
const auditMw = function audit() {} as unknown as RuntimeMiddleware

function source(): RouteSource {
	return {
		cm: [],
		cv: null,
		dk: new Set(),
		ef: null,
		fn: () => new Response("x"),
		in: null,
		own: createGraph().settings,
		rb: null,
		rm: [],
		xm: null,
	}
}

describe("the graph", () => {
	it("addRoute gives each record its id and pattern, places an optional param's two leaves, refuses a duplicate", () => {
		const g = createGraph()
		const id = addRoute(g, "GET", parsePattern("/u/:id?"), source())
		expect(id).toBe("GET /u/:id?")
		expect(g.records.get(id)).toMatchObject({ id, mt: null, rp: "/u/:id?" })
		expect(g.epoch).toBe(1)
		expect(() => addRoute(g, "GET", parsePattern("/u/:id?"), source())).toThrow("Duplicate route: GET /u/:id?")
	})

	it("markUsed marks a chain node and its ancestors; a root view has none", () => {
		const g = createGraph()
		const parent = addChain(g, null, pass)
		const child = addChain(g, parent, pass)
		markUsed(child)
		expect([parent.used, child.used]).toEqual([true, true])
		markUsed(ROOT_VIEW.node)
		expect(Object.isFrozen(ROOT_VIEW)).toBe(true)
	})

	it("assertNothingDiscarded names the unused use() and every dangling builder", () => {
		const g = createGraph()
		addChain(g, null, auditMw)
		g.pending.add({ id: "GET /a" })
		expect(() => assertNothingDiscarded(g)).toThrow(/app\.use\("audit"\)[\s\S]*GET \/a was declared/)
	})
})

describe("the graph: mounting", () => {
	it("mounting a graph into itself changes nothing; a scope already brought is not added twice", () => {
		const app = honey()
		const g = app[GRAPH]
		mount(g, ROOT_VIEW, g)
		expect(g.epoch).toBe(0)
		const sub = honey()
		sub.use("/s", pass as never)
		sub.get("/s/x").handler((c) => c.res.text("ok", "x"))
		mount(g, ROOT_VIEW, sub[GRAPH])
		expect(() => mount(g, ROOT_VIEW, sub[GRAPH])).toThrow(/Duplicate route/)
		expect(g.scoped).toHaveLength(1)
		const scopesOnly = honey()
		scopesOnly.use("/t", pass as never)
		mount(g, ROOT_VIEW, scopesOnly[GRAPH])
		mount(g, ROOT_VIEW, scopesOnly[GRAPH])
		expect(g.scoped.map((e) => e.prefix)).toEqual(["/s", "/t"])
	})

	it("a mounted record keeps the sub's context values and meta under the mounting handle's", async () => {
		const sub = honey().context({ a: "sub", b: "sub" })
		sub
			.meta({ tier: 2 })
			.get("/x")
			.handler((c) => c.res.json("ok", { a: c.a, b: c.b, meta: c.meta }))
		const app = honey().context({ a: "app", c: "app" })
		app.meta({ owner: "app", tier: 1 }).route(sub as never)
		expect(await (await get(app, "/x")).json()).toEqual({ a: "sub", b: "sub", meta: { owner: "app", tier: 2 } })
	})

	it("chainErrorKeys lists the keys a chain declares, in run order", () => {
		const factory = { a: () => null, b: () => null }
		const first = defineMiddleware({ errors: [factory, "b"], fn: (_c, next) => next() }) as unknown as RuntimeMiddleware
		const second = defineMiddleware({
			errors: [factory, "a"],
			fn: (_c, next) => next(),
		}) as unknown as RuntimeMiddleware
		expect(chainErrorKeys([first, pass, second])).toEqual(["b", "a"])
	})
})
