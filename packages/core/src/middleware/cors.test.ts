import { describe, expect, it } from "vitest"
import { type Honey, honey } from "../routing/app.ts"
import { cors, type CORSOptions } from "./cors.ts"
import { ws } from "../ws/route.ts"

const ORIGIN = "https://app.example.com"

/** A GET and POST on /data behind cors(options), and the answer headers that matter for CORS. */
function corsApp(options?: CORSOptions) {
	const app = honey<{}>()
	const guarded = app.use(cors(options))
	guarded.get("/data").handler((ctx) => ctx.res.json("ok", { ok: true }))
	guarded.post("/data").handler((ctx) => ctx.res.json("ok", { posted: true }))
	return app
}

function request(path: string, init: { headers?: Record<string, string>; method?: string } = {}) {
	return new Request(`https://api.example.com${path}`, { headers: init.headers, method: init.method ?? "GET" })
}

const preflight = (origin: string, extra: Record<string, string> = {}) =>
	request("/data", {
		headers: { "access-control-request-method": "POST", origin, ...extra },
		method: "OPTIONS",
	})

/** The CORS-relevant part of an answer. */
async function corsOf(app: Honey<{}>, req: Request) {
	const res = await app.fetch(req, {})
	const header = (name: string) => res.headers.get(name)
	return {
		allowOrigin: header("access-control-allow-origin"),
		credentials: header("access-control-allow-credentials"),
		status: res.status,
		vary: header("vary"),
	}
}

const pick = (res: Response, names: string[]) => names.map((name) => res.headers.get(name))
const preflightHeaders = (res: Response) =>
	pick(res, ["access-control-allow-methods", "access-control-allow-headers", "access-control-max-age"])
const answerHeaders = (res: Response) =>
	pick(res, ["access-control-allow-origin", "access-control-allow-credentials", "access-control-expose-headers"])

describe("cors(): construction", () => {
	// v0: 046b4f8b46
	// v0: 79e1036e18
	// v0: 77b3d9f238
	// v0: c3f19b76b8
	it.each([
		["a wildcard origin", { credentials: true, origin: "*" }],
		["no origin at all", { credentials: true }],
	] as const)("credentials with %s is a construction error", (_name, options) => {
		expect(() => cors(options)).toThrow("cors: `credentials: true` needs an explicit `origin`")
	})
})

describe("cors(): which origins it allows", () => {
	// v0: 9414c41213
	// v0: f2485028c7
	// v0: 7adc19e84b
	// v0: 39d437f056
	// v0: 609e2137ad
	// v0: 43ccec6f9e
	// v0: 8983fefd23
	// v0: f8ab17465b
	// v0: db0150e9c4
	// v0: ff45bbc814
	// v0: 3de5b2eb99
	// v0: 80d0243ec5
	// v0: bce5053229
	// v0: e8e0b695a2
	// v0: 8864eb2446
	// v0: 06d58daec8
	// v0: ae4f1c3d8a
	// v0: 0ab3023571
	// v0: 41b3ad9d3b
	it.each([
		["no policy: any origin, as *", undefined, ORIGIN, "*"],
		["* : any origin", "*", "https://anyone.example", "*"],
		["a string: that origin", ORIGIN, ORIGIN, ORIGIN],
		["a string: not another", ORIGIN, "https://evil.example", null],
		["a string: not the same host on another port", ORIGIN, `${ORIGIN}:8443`, null],
		["a list: a listed origin", [ORIGIN, "https://b.example"], "https://b.example", "https://b.example"],
		["a list: not an unlisted one", [ORIGIN], "https://evil.example", null],
		["a predicate saying yes", (origin: string) => origin.endsWith(".example.com"), ORIGIN, ORIGIN],
		["a predicate saying no", () => false, ORIGIN, null],
		["an accept-all predicate never reflects the opaque null", () => true, "null", null],
		["a list never reflects null either", ["null"], "null", null],
	] as const)("%s", async (_name, origin, from, allowed) => {
		const app = corsApp({ origin: origin as CORSOptions["origin"] })
		expect((await corsOf(app, request("/data", { headers: { origin: from } }))).allowOrigin).toBe(allowed)
	})

	// v0: a0b9b8db07
	// v0: a035986de8
	// v0: cb01e6a3f0
	it("a request with no Origin is not a CORS request: no CORS headers", async () => {
		expect(await corsOf(corsApp(), request("/data"))).toEqual({
			allowOrigin: null,
			credentials: null,
			status: 200,
			vary: null,
		})
	})
})

describe("cors(): the preflight", () => {
	// v0: f39a36746b
	// v0: e0b1014846
	// v0: 98847bee4e
	// v0: a1ef68aa4d
	// v0: 948ff8e568
	// v0: 9c5bc59d99
	// v0: 6ec4ba71d3
	it("answers 204 with the allowed methods, headers and max age, and runs no handler", async () => {
		const defaults = await corsApp().fetch(preflight(ORIGIN), {})
		const custom = await corsApp({ headers: ["x-a", "x-b"], maxAge: 60, methods: ["GET", "POST"] }).fetch(
			preflight(ORIGIN, { "access-control-request-headers": "x-c" }),
			{},
		)
		expect([
			defaults.status,
			preflightHeaders(defaults),
			custom.status,
			preflightHeaders(custom),
			await custom.text(),
		]).toEqual([204, ["GET, HEAD, PUT, PATCH, POST, DELETE", null, "86400"], 204, ["GET, POST", "x-a, x-b", "60"], ""])
	})

	// v0: 426d096888
	// v0: eddfc93294
	it("with no configured headers, echoes the requested ones and varies on them", async () => {
		const res = await corsApp({ origin: ORIGIN }).fetch(
			preflight(ORIGIN, { "access-control-request-headers": "x-token" }),
			{},
		)
		expect([res.headers.get("access-control-allow-headers"), res.headers.get("vary")]).toEqual([
			"x-token",
			"Access-Control-Request-Headers, Origin",
		])
	})

	// v0: 33f979eb71
	// v0: d8ab3b69ab
	it("with credentials: the credentials header, Vary: Origin and the max age", async () => {
		const res = await corsApp({ credentials: true, origin: ORIGIN }).fetch(preflight(ORIGIN), {})
		expect([res.status, res.headers.get("access-control-allow-credentials"), res.headers.get("vary")]).toEqual([
			204,
			"true",
			"Access-Control-Request-Headers, Origin",
		])
	})
})

describe("cors(): what is not a preflight", () => {
	// v0: 8f93483665
	// v0: 6570c3d37b
	// v0: 71abd11908
	// v0: da0007f738
	it.each([
		["from a disallowed origin: no allow-origin", preflight("https://evil.example"), null],
		[
			"without Access-Control-Request-Method: an actual answer, so it earns the allow-origin",
			request("/data", { headers: { origin: ORIGIN }, method: "OPTIONS" }),
			ORIGIN,
		],
	])("%s; no preflight answer, the 405 the path gives", async (_name, req, allowOrigin) => {
		const res = await corsApp({ origin: ORIGIN }).fetch(req, {})
		expect([res.status, res.headers.get("access-control-allow-origin")]).toEqual([405, allowOrigin])
	})
})

describe("cors(): which preflights it answers", () => {
	// v0: 419064e3bb
	// v0: 1d2042010a
	// v0: 4ab76e6b70
	// v0: fb5d34e689
	it("a preflight for a GET-only or POST-only route is answered by that route's cors; its handler never runs", async () => {
		let ran = 0
		const app = honey<{}>()
		const guarded = app.use(cors())
		guarded.get("/get").handler((ctx) => {
			ran++
			return ctx.res.text("ok", "x")
		})
		guarded.post("/post").handler((ctx) => ctx.res.text("ok", "x"))
		const asking = (path: string, method: string) =>
			request(path, { headers: { "access-control-request-method": method, origin: ORIGIN }, method: "OPTIONS" })
		const statuses = [
			(await app.fetch(asking("/get", "GET"), {})).status,
			(await app.fetch(asking("/post", "POST"), {})).status,
		]
		const before = ran
		const get = await app.fetch(request("/get"), {})
		expect([statuses, before, get.status, ran]).toEqual([[204, 204], 0, 200, 1])
	})
})

describe("cors(): preflights nothing answers", () => {
	// v0: d1e268484d
	// v0: cd2b09f179
	// v0: b6ffcf5f3e
	it("no cors: the preflight stays 405; an unknown path is answered only by cors every route runs", async () => {
		const bare = honey<{}>()
		bare.get("/x").handler((ctx) => ctx.res.text("ok", "x"))
		const partial = honey<{}>()
		partial
			.use(cors())
			.get("/a")
			.handler((ctx) => ctx.res.text("ok", "a"))
		partial.get("/b").handler((ctx) => ctx.res.text("ok", "b"))
		const everywhere = honey<{}>().use(cors())
		everywhere.get("/a").handler((ctx) => ctx.res.text("ok", "a"))
		const asking = (path: string) =>
			request(path, { headers: { "access-control-request-method": "GET", origin: ORIGIN }, method: "OPTIONS" })
		const statuses = await Promise.all([
			bare.fetch(asking("/x"), {}),
			partial.fetch(asking("/unknown"), {}),
			everywhere.fetch(asking("/unknown"), {}),
		])
		expect(statuses.map((res) => res.status)).toEqual([405, 404, 204])
	})
})

describe("cors(): preflights through mounts, scopes and per-route policies", () => {
	// v0: 8ad4483287
	// v0: 3e2e3ab346
	// v0: f22bcbd5b7
	// v0: 3ee0ccbb6f
	// v0: d0e4f7c9eb
	// v0: 7e845ebda7
	it("through a basePath, a mounted child, a scoped cors, and per route: each preflight gets its route's policy", async () => {
		const child = honey<{}>()
		child
			.use(cors())
			.get("/items/:id")
			.handler((ctx) => ctx.res.text("ok", ctx.params.id))
		const app = honey<{}>()
		app.basePath("/v1").route("/shop", child)
		app.use("/scoped", cors({ origin: ORIGIN }))
		app.get("/scoped/x").handler((ctx) => ctx.res.text("ok", "x"))
		app
			.use(cors({ origin: "*" }))
			.get("/open")
			.handler((ctx) => ctx.res.text("ok", "open"))
		app
			.use(cors({ origin: "https://admin.example" }))
			.post("/open")
			.handler((ctx) => ctx.res.text("ok", "posted"))
		const asking = (path: string, method: string) =>
			request(path, { headers: { "access-control-request-method": method, origin: ORIGIN }, method: "OPTIONS" })
		const answers = await Promise.all(
			[
				asking("/v1/shop/items/7", "GET"),
				asking("/scoped/x", "GET"),
				asking("/open", "GET"),
				asking("/open", "POST"),
			].map(async (req) => {
				const res = await app.fetch(req, {})
				return [res.status, res.headers.get("access-control-allow-origin")]
			}),
		)
		expect(answers).toEqual([
			[204, "*"],
			[204, ORIGIN],
			[204, "*"],
			[405, null],
		])
	})
})

describe("cors(): the actual response", () => {
	// v0: cfa773d80a
	// v0: aabef91984
	// v0: 393305c1af
	// v0: a84495d36a
	// v0: 607258b1a0
	// v0: 8125e22fb7
	// v0: a5579b7df3
	// v0: d8bb05c369
	// v0: dbb80f7ca0
	it("allowed: the allow-origin, credentials and exposed headers; disallowed: none of them", async () => {
		const app = corsApp({ credentials: true, exposeHeaders: ["x-total", "x-page"], origin: [ORIGIN] })
		const allowed = await app.fetch(request("/data", { headers: { origin: ORIGIN } }), {})
		const refused = await app.fetch(request("/data", { headers: { origin: "https://evil.example" } }), {})
		expect([allowed.status, answerHeaders(allowed), refused.status, answerHeaders(refused)]).toEqual([
			200,
			[ORIGIN, "true", "x-total, x-page"],
			200,
			[null, null, null],
		])
	})
})

describe("cors(): Vary", () => {
	// v0: eee2c06ac4
	// v0: 0b8f36117a
	// v0: 30afd133c4
	// v0: 4dffbc4031
	// v0: 03ff2a0dfd
	// v0: 05802903a6
	// v0: e8e8b3fb6a
	// v0: 1f2106982b
	// v0: 3d2d1a3f91
	it.each([
		["a string policy, allowed", ORIGIN, ORIGIN, "Origin"],
		["a list policy, disallowed", [ORIGIN], "https://evil.example", "Origin"],
		["a predicate policy, no Origin sent", () => true, null, "Origin"],
		["a plain wildcard needs none", "*", ORIGIN, null],
	] as const)("%s → Vary %s", async (_name, origin, from, vary) => {
		const app = corsApp({ origin: origin as CORSOptions["origin"] })
		const res = await app.fetch(request("/data", { headers: from === null ? {} : { origin: from } }), {})
		expect(res.headers.get("vary")).toBe(vary)
	})

	// v0: 88bbcbf465
	// v0: 94d068c01a
	it("joins a handler's own Vary instead of duplicating it", async () => {
		const app = honey<{}>()
		const guarded = app.use(cors({ origin: ORIGIN }))
		guarded.get("/a").handler((ctx) => ctx.res.text("ok", "x", { headers: { vary: "Accept-Encoding" } }))
		guarded.get("/b").handler((ctx) => ctx.res.text("ok", "x", { headers: { vary: "origin" } }))
		const [a, b] = await Promise.all(
			["/a", "/b"].map((path) => app.fetch(request(path, { headers: { origin: ORIGIN } }), {})),
		)
		expect([a.headers.get("vary"), b.headers.get("vary")]).toEqual(["Accept-Encoding, Origin", "origin"])
	})
})

describe("cors(): what it leaves alone", () => {
	// v0: fc013fe4a5
	// v0: dbf68f8c8b
	// v0: 1bb981b2cd
	it("a large JSON body and a streamed body come through intact; a HEAD gets its headers (the adapter drops its body)", async () => {
		const big = { items: Array.from({ length: 2000 }, (_, i) => ({ i, name: `item-${i}` })) }
		const app = honey<{}>()
		const guarded = app.basePath("/v1").use(cors())
		guarded.get("/big").handler((ctx) => ctx.res.json("ok", big))
		guarded.get("/stream").handler((ctx) =>
			ctx.res.stream(async (writable) => {
				const writer = writable.getWriter()
				for (const part of ["a", "b", "c"]) await writer.write(new TextEncoder().encode(part))
				await writer.close()
			}),
		)
		const from = { origin: ORIGIN }
		const bigRes = await app.fetch(request("/v1/big", { headers: from }), {})
		const streamRes = await app.fetch(request("/v1/stream", { headers: from }), {})
		const head = await app.fetch(request("/v1/big", { headers: from, method: "HEAD" }), {})
		expect([
			await bigRes.json(),
			await streamRes.text(),
			[head.status, head.headers.get("access-control-allow-origin")],
		]).toEqual([big, "abc", [200, "*"]])
	})

	it("a response with immutable headers is copied with its body, status and headers, then given CORS", async () => {
		const app = honey<{}>()
		app
			.use(cors())
			.get("/moved")
			.handler(() => Response.redirect("https://elsewhere.example/", 302) as never)
		const res = await app.fetch(request("/moved", { headers: { origin: ORIGIN } }), {})
		expect([res.status, res.headers.get("location"), res.headers.get("access-control-allow-origin")]).toEqual([
			302,
			"https://elsewhere.example/",
			"*",
		])
	})

	// v0: c66efc187c
	it("a 101 upgrade passes through untouched", async () => {
		const upgraded = new Response(null)
		Object.defineProperty(upgraded, "status", { value: 101 })
		const socket = { close() {}, raw: null, readyState: 1 as const, send() {} }
		const app = honey<{}>().wsAdapter({ upgrade: () => ({ response: upgraded, socket }) })
		ws(app.use(cors({ origin: ORIGIN })), "/live").handler({})
		const res = await app.fetch(
			request("/live", { headers: { connection: "Upgrade", origin: ORIGIN, upgrade: "websocket" } }),
			{},
		)
		expect([res === upgraded, res.headers.get("access-control-allow-origin")]).toEqual([true, null])
	})
})
