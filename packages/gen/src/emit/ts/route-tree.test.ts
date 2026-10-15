/**
 * `generateRouteTree`: core's v2 route-tree data in, one `routes.gen.ts` module out. Each case
 * imports the emitted module and asserts what it exports (topology, route data, the meta export,
 * identity of shared data); types are checked in-process against core's tree types; text is read
 * only for what must be absent.
 */
import { Project, ts } from "ts-morph"
import { describe, expect, it } from "vitest"
import { emittedRouteTree } from "./__fixtures__/emitted.ts"
import { treeOf } from "./__fixtures__/tree-data.ts"
import { generateRouteTree, type RouteEntryV2, type RouteTreeV2, type TreeNodeV2 } from "./route-tree.ts"

type Loaded = {
	readonly meta?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
	readonly routeTree: RouteTreeV2 & { readonly meta: Readonly<Record<string, unknown>> }
	readonly routes: Readonly<Record<string, RouteEntryV2>>
	readonly text: string
	readonly tree: TreeNodeV2
}

/** The module emitted for `tree`, imported. */
const emitted = async (tree: RouteTreeV2) => (await emittedRouteTree(tree)) as unknown as Loaded

/** Core's tree types (core routing/tree.ts) restated: what `@lovrozagar/honey/tree` gives the emitted module. */
const CORE_TREE = `export type TreeNode = {
	d: { c: TreeNode; n: string } | null
	m: Record<string, string> | null
	s: Record<string, TreeNode>
	w: { m: Record<string, string>; n: string } | null
	ws: string | null
}
export type RouteEntry = {
	bek?: string | null
	ek?: readonly string[]
	es?: Readonly<Record<string, string>>
	h?: unknown
	i?: 1 | true
	iv?: unknown
	mt?: Readonly<Record<string, unknown>> | null
	out?: unknown
}
export interface RouteMeta {}
export type RouteTree = { meta: Record<string, RouteMeta>; root: TreeNode; routes: Record<string, RouteEntry>; v?: number }
`

const PRELUDE = `type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Optional<T, K extends keyof T> = {} extends Pick<T, K> ? true : false
declare function expectType<T extends true>(): void
`

/* one project for the file: the lib files parse once, each check swaps the module and its consumer */
const project = new Project({
	compilerOptions: {
		allowImportingTsExtensions: true,
		lib: ["lib.es2023.d.ts"],
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		noEmit: true,
		paths: { "@lovrozagar/honey/tree": ["/honey/tree.ts"] },
		strict: true,
		target: ts.ScriptTarget.ES2022,
	},
	useInMemoryFileSystem: true,
})
project.createSourceFile("/honey/tree.ts", CORE_TREE)

/** Every diagnostic of the module emitted for `tree` and of a `consumer.ts` of type assertions beside it. */
function typecheck(tree: RouteTreeV2, consumer: string): string[] {
	for (const file of project.getSourceFiles("/gen/**")) project.removeSourceFile(file)
	project.createSourceFile("/gen/routes.gen.ts", generateRouteTree(tree))
	project.createSourceFile("/gen/consumer.ts", `${PRELUDE}${consumer}\n`)
	return project.getPreEmitDiagnostics().map((d) => {
		const text = d.getMessageText()
		return `${d.getSourceFile()?.getBaseName()}:${d.getLineNumber()}: ${typeof text === "string" ? text : text.getMessageText()}`
	})
}

/** Route data equal by value, a fresh object each call. */
const shareable = () => ({
	bek: "internal_server_error",
	ek: ["internal_server_error", "forbidden"],
	mt: { worker: "api" },
})

/** Meta that refers to itself. */
const cycle: Record<string, unknown> = {}
cycle.self = cycle

/** The static child `segment` of `node`, by a plain string key. */
const child = (node: TreeNodeV2 | undefined, segment: string) => node?.s[segment]

/** The message `run` throws, or `null`. */
function thrown(run: () => unknown): string | null {
	try {
		run()
		return null
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
}

describe("generateRouteTree: the module", () => {
	// v0: 04ac84d67d
	// v0: 5a96d675c2
	it("exports the topology with route-id leaves, the route data keyed by id, and routeTree over both", async () => {
		const { routeTree, routes, tree } = await emitted(
			treeOf([
				["GET", "/users"],
				["POST", "/users"],
				["GET", "/users/:id", { ek: ["not_found"], mt: { auth: true } }],
				["GET", "/"],
			]),
		)
		expect([
			Object.keys(routes),
			tree.m,
			tree.s.users?.m,
			tree.s.users?.d?.n,
			tree.s.users?.d?.c.m,
			routes["GET /users/:id"],
		]).toEqual([
			["GET /users", "POST /users", "GET /users/:id", "GET /"],
			{ GET: "GET /" },
			{ GET: "GET /users", POST: "POST /users" },
			"id",
			{ GET: "GET /users/:id" },
			{ ek: ["not_found"], mt: { auth: true } },
		])
		expect([routeTree.v, routeTree.root === tree, routeTree.routes === routes]).toEqual([2, true, true])
	})

	// v0: aa9b10eb21
	it("keeps a wildcard's name, named or not, and its route id", async () => {
		const { routes, tree } = await emitted(
			treeOf([
				["GET", "/files/*path"],
				["GET", "/raw/*"],
			]),
		)
		expect([Object.keys(routes), tree.s.files?.w, tree.s.raw?.w]).toEqual([
			["GET /files/*path", "GET /raw/*"],
			{ m: { GET: "GET /files/*path" }, n: "path" },
			{ m: { GET: "GET /raw/*" }, n: "*" },
		])
	})
})

describe("generateRouteTree: segments and records", () => {
	// v0: 1c3f943ad0
	it("routes the root, a wildcard and segments named like Object.prototype members as plain keys", async () => {
		const { routes, tree } = await emitted(
			treeOf([
				["GET", "/"],
				["GET", "/files/*path"],
				["GET", "/constructor/toString"],
				["GET", "/__proto__/hasOwnProperty"],
			]),
		)
		expect([
			Object.keys(routes),
			Object.keys(tree.s),
			child(child(tree, "constructor"), "toString")?.m,
			Object.hasOwn(tree.s, "__proto__") ? child(child(tree, "__proto__"), "hasOwnProperty")?.m : "inherited",
		]).toEqual([
			["GET /", "GET /files/*path", "GET /constructor/toString", "GET /__proto__/hasOwnProperty"],
			["files", "constructor", "__proto__"],
			{ GET: "GET /constructor/toString" },
			{ GET: "GET /__proto__/hasOwnProperty" },
		])
	})

	// v0: aef1c13482
	it("builds every record of the topology null-prototype, and no two nodes share one", async () => {
		const { tree } = await emitted(
			treeOf([
				["GET", "/users/:id"],
				["GET", "/health"],
				["GET", "/files/*path"],
			]),
		)
		const users = tree.s.users
		const id = users?.d?.c
		const records = [tree.s, users?.s, id?.s, id?.m, tree.s.health?.s, tree.s.health?.m, tree.s.files?.w?.m]
		expect(records.map((record) => record !== undefined && Object.getPrototypeOf(record) === null)).toEqual(
			records.map(() => true),
		)
		expect(new Set([tree.s, users?.s, id?.s, tree.s.health?.s, tree.s.files?.s]).size).toBe(5)
	})
})

describe("generateRouteTree: route data", () => {
	// v0: 4b34d0a127
	it("writes the boundary key, declared error keys, their status keys and meta as data", async () => {
		const entry = { bek: "gone", ek: ["email_taken", "gone"], es: { email_taken: "conflict", gone: "gone" } }
		const { routes } = await emitted(treeOf([["GET", "/users", { ...entry, mt: { auth: "required" } }]]))
		expect(routes["GET /users"]).toEqual({ ...entry, mt: { auth: "required" } })
	})

	// v0: a66923fc91
	// v0: 5eb9c55499
	it("writes route data only: never a live record, validators, schemas or any other key", async () => {
		const iv = { json: { properties: { id: { type: "string" } }, type: "object" } }
		const out = { "application/json": { ok: { properties: { secret: { type: "string" } } } } }
		const h = { fn: () => "handler-body-marker", id: "POST /one" }
		const live = { bek: null, ek: [], h, iv, mt: null, out, x: 1 } as RouteEntryV2
		const { routes, text } = await emitted(
			treeOf([
				["POST", "/one", live],
				["POST", "/two", { iv, mt: { summary: "two" }, out }],
				["GET", "/orgs"],
			]),
		)
		expect([routes["POST /one"], routes["POST /two"], routes["GET /orgs"]]).toEqual([
			{},
			{ mt: { summary: "two" } },
			{},
		])
		expect(["properties", "secret", "application/json", "handler-body-marker"].filter((s) => text.includes(s))).toEqual(
			[],
		)
	})
})

describe("generateRouteTree: shared and passed-through data", () => {
	// v0: eaf65f57f6
	it("shares equal route data by identity after import, from equal but distinct source objects", async () => {
		const { routes, tree } = await emitted(
			treeOf([
				["GET", "/a", shareable()],
				["GET", "/b", shareable()],
			]),
		)
		const [a, b] = [routes["GET /a"], routes["GET /b"]]
		expect([a?.mt === b?.mt, a?.ek === b?.ek, b, tree.s.a?.m]).toEqual([true, true, shareable(), { GET: "GET /a" }])
	})

	// v0: 8df5de9200
	it("keeps a route's invalidate selectors in its meta", async () => {
		const { routes } = await emitted(
			treeOf([
				["GET", "/v1/users"],
				["POST", "/v1/users", { mt: { invalidate: ["GET /v1/users"] } }],
			]),
		)
		expect(routes["POST /v1/users"]?.mt).toEqual({ invalidate: ["GET /v1/users"] })
	})

	it("writes status keys code-unit sorted and the internal flag as given", async () => {
		const es = { b_key: "gone", B_key: "conflict", a_key: "not_found" }
		const { routes } = await emitted(
			treeOf([
				["GET", "/spec", { ek: ["a_key", "b_key", "B_key"], es, i: 1 }],
				["GET", "/docs", { i: true }],
			]),
		)
		expect([Object.keys(routes["GET /spec"]?.es ?? {}), routes["GET /spec"]?.i, routes["GET /docs"]]).toEqual([
			["B_key", "a_key", "b_key"],
			1,
			{ i: true },
		])
	})
})

describe("generateRouteTree: the meta export", () => {
	// v0: 6e6392a52f
	// v0: c3c69b195f
	// v0: 21490b85ed
	it("exports each route that has meta with its full meta, openApi-only meta included, as routeTree.meta", async () => {
		const users = { auth: "required", rateLimit: "strict", summary: "List users" }
		const { meta, routeTree } = await emitted(
			treeOf([
				["GET", "/items", { mt: { cached: true, ttl: 60 } }],
				["GET", "/users", { mt: users }],
				["GET", "/health", { mt: { summary: "Health", tags: ["ops"] } }],
				["GET", "/plain"],
			]),
		)
		expect([meta, routeTree.meta === meta]).toEqual([
			{
				"GET /health": { summary: "Health", tags: ["ops"] },
				"GET /items": { cached: true, ttl: 60 },
				"GET /users": users,
			},
			true,
		])
	})

	// v0: 2b3a524b7d
	it("exports no meta and gives routeTree an empty meta when no route has any, an empty mt counting as none", async () => {
		const module = await emitted(
			treeOf([
				["GET", "/items", { mt: {} }],
				["GET", "/other", { mt: null }],
				["GET", "/bare"],
			]),
		)
		expect(["meta" in module, module.routeTree.meta, Object.values(module.routes)]).toEqual([false, {}, [{}, {}, {}]])
	})
})

describe("generateRouteTree: MetaShape and RouteSelector", () => {
	// v0: e0ff761d81
	it("gives the meta export each route's own mt object, typed by MetaShape", async () => {
		const tree = treeOf([
			["GET", "/orgs", { mt: { summary: "List orgs", tags: ["orgs"] } }],
			["POST", "/orgs", { mt: { summary: "Create org" } }],
		])
		const { meta, routeTree, routes } = await emitted(tree)
		const mt = routes["GET /orgs"]?.mt
		expect([meta?.["GET /orgs"] === mt, routeTree.meta["GET /orgs"] === mt, mt]).toEqual([
			true,
			true,
			{ summary: "List orgs", tags: ["orgs"] },
		])
		const consumer = `import { meta } from "./routes.gen.ts"
import type { MetaShape } from "./routes.gen.ts"
expectType<Equal<MetaShape["summary"], "List orgs" | "Create org">>()
expectType<Equal<MetaShape["tags"], ["orgs"] | undefined>>()
expectType<Optional<MetaShape, "tags">>()
expectType<Equal<MetaShape["custom"], unknown>>()
expectType<Equal<(typeof meta)[string], MetaShape>>()`
		expect(typecheck(tree, consumer)).toEqual([])
	})

	// v0: fa6a97ea33
	// v0: 4b465e0068
	// v0: 6de7a00415
	// v0: 89e639eb73
	it("types each MetaShape key as the union of its literal values, never widened", () => {
		const tree = treeOf([
			["GET", "/a", { mt: { auth: "jwt", flag: true, permissions: false, priority: 1, worker: "extract" } }],
			["GET", "/b", { mt: { auth: "jwt", flag: false, permissions: false, priority: 2, worker: "saas" } }],
		])
		const consumer = `import type { MetaShape } from "./routes.gen.ts"
expectType<Equal<MetaShape["worker"], "extract" | "saas">>()
expectType<Equal<MetaShape["priority"], 1 | 2>>()
expectType<Equal<MetaShape["flag"], boolean>>()
expectType<Equal<MetaShape["auth"], "jwt">>()
expectType<Equal<MetaShape["permissions"], false>>()`
		expect(typecheck(tree, consumer)).toEqual([])
	})

	it("types RouteSelector as the documented ids, leaving out websocket and internal routes, and omits it when none", () => {
		const tree = treeOf([
			["GET", "/a"],
			["POST", "/a"],
			["WS", "/chat"],
			["GET", "/spec", { mt: { internal: true } }],
			["GET", "/docs", { i: 1 }],
		])
		const selector = `import type { RouteSelector } from "./routes.gen.ts"
expectType<Equal<RouteSelector, "GET /a" | "POST /a">>()`
		expect(typecheck(tree, selector)).toEqual([])
		const internalOnly = treeOf([["GET", "/spec", { mt: { internal: true } }]])
		expect(typecheck(internalOnly, selector).some((d) => d.includes("RouteSelector"))).toBe(true)
	})
})

describe("generateRouteTree: what it refuses", () => {
	// v0: 713b41d0f5
	it("refuses meta JSON cannot carry, naming the route and the path to the value", () => {
		expect(() => generateRouteTree(treeOf([["GET", "/when", { mt: { at: new Date(0) } }]]))).toThrow(/GET \/when.*Date/)
		expect(() => generateRouteTree(treeOf([["GET", "/n", { mt: { n: Number.NaN } }]]))).toThrow(/NaN/)
		expect(thrown(() => generateRouteTree(treeOf([["GET", "/deep", { mt: { a: [{ b: Infinity }] } }]])))).toMatch(
			/GET \/deep.*a.*b.*Infinity/,
		)
	})

	// v0: e105286902
	it.each([
		["NaN", Number.NaN, null],
		["Infinity", Number.POSITIVE_INFINITY, null],
		["-Infinity", Number.NEGATIVE_INFINITY, null],
		["a bigint", 10n, 10],
		["a symbol", Symbol("s"), null],
		["a function", () => 1, null],
		["a Date", new Date(0), {}],
		["a RegExp", /x/, {}],
		["a Map", new Map([["k", 1]]), {}],
		["an instance", new URL("http://x"), {}],
		["a cycle", cycle, { self: {} }],
	])("refuses %s in meta before interning, rather than merging it with its JSON twin", (_name, value, twin) => {
		const tree = treeOf([
			["GET", "/a", { mt: { v: value } }],
			["GET", "/b", { mt: { v: twin } }],
		])
		expect(thrown(() => generateRouteTree(tree))).toMatch(/GET \/a/)
	})

	it("refuses a tree that is not format v2, naming the version it got", () => {
		const message = thrown(() => generateRouteTree({ ...treeOf([["GET", "/a"]]), v: 3 }))
		expect([message?.includes("3"), /v2|version 2/.test(message ?? "")]).toEqual([true, true])
		expect(thrown(() => generateRouteTree({ ...treeOf([["GET", "/a"]]), v: undefined }))).not.toBeNull()
	})

	it("refuses a leaf whose route id has no route entry, naming it", () => {
		const tree = treeOf([["GET", "/orphan"]])
		expect(() => generateRouteTree({ ...tree, routes: {} })).toThrow(/GET \/orphan/)
	})

	it("refuses a string that is not well-formed UTF-16, in route data or topology, rather than re-keying it", () => {
		const cases = [
			treeOf([["GET", "/a", { mt: { label: "x\uD800y" } }]]),
			treeOf([["GET", "/a", { mt: { "\uDC00": 1 } }]]),
			treeOf([["GET", "/\uD800"]]),
		]
		expect(cases.map((tree) => thrown(() => generateRouteTree(tree)) !== null)).toEqual([true, true, true])
	})
})

describe("generateRouteTree: escaping and order", () => {
	it("carries every string and key losslessly, `__proto__` as an own key", async () => {
		const text = `q"b\\n\n${String.fromCharCode(0x2028)}\u0000\${x}\`</script>\u{1F600}`
		const mt = { ...(JSON.parse('{"__proto__": {"own": true}}') as object), "": text, "a-b": [text], constructor: "c" }
		const { routes, tree } = await emitted(treeOf([["GET", "/a\"b/it's", { ek: [text], mt }]]))
		const got = routes[`GET /a"b/it's`]
		expect([got?.ek, got?.mt, Object.hasOwn(got?.mt ?? {}, "__proto__"), tree.s['a"b']?.s["it's"]?.m]).toEqual([
			[text],
			mt,
			true,
			{ GET: `GET /a"b/it's` },
		])
	})

	it("writes routes in the input's order, leaves only, the topology in its own key order, and the same bytes each time", async () => {
		const tree = treeOf([
			["GET", "/b"],
			["GET", "/a"],
		])
		const reordered = { ...tree, routes: { "GET /a": {}, "GET /b": {}, "GET /unplaced": { mt: { x: 1 } } } }
		const { routes, tree: root } = await emitted(reordered)
		expect([Object.keys(routes), Object.keys(root.s)]).toEqual([
			["GET /a", "GET /b"],
			["b", "a"],
		])
		const equal = treeOf([
			["GET", "/b"],
			["GET", "/a"],
		])
		expect(generateRouteTree(tree)).toBe(generateRouteTree(equal))
	})
})

describe("generateRouteTree: edges", () => {
	it("names an object without a constructor plainly, and emits a tree with no routes at all", async () => {
		const orphan = Object.create(Object.create(null) as object) as object
		expect(thrown(() => generateRouteTree(treeOf([["GET", "/o", { mt: { orphan } }]])))).toMatch(/non-plain object/)
		const { routeTree, routes } = await emitted(treeOf([]))
		expect([Object.keys(routes), routeTree.meta]).toEqual([[], {}])
	})
})
