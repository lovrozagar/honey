import { afterEach, describe, expect, it } from "vitest"
import { honey } from "../routing/app.ts"
import { type TestClient, testClient } from "./testing.ts"

type Echo = { body: string; contentType: string | null; method: string; search: string; header: string | null }

/** An app that answers every method on `/echo` with what it received, and on `/peer` with `ctx.ip`. */
function echoApp() {
	const app = honey<{ tenant: string }>()
	app.all("/echo").handler(async (ctx) => {
		const url = new URL(ctx.req.url)
		const echo: Echo = {
			body: await ctx.req.text(),
			contentType: ctx.req.headers.get("content-type"),
			header: ctx.req.headers.get("x-trace"),
			method: ctx.req.method,
			search: url.search,
		}
		return ctx.res.json("ok", echo)
	})
	app.get("/peer").handler((ctx) => ctx.res.json("ok", { ip: ctx.ip }))
	app.get("/env").handler((ctx) => ctx.res.json("ok", { tenant: ctx.env.tenant }))
	return app
}

const echoed = async (response: Promise<Response>) => (await (await response).json()) as Echo
const clients: TestClient[] = []
const client = (options: Parameters<typeof testClient<{ tenant: string }>>[1]) => {
	const made = testClient(echoApp(), options)
	clients.push(made)
	return made
}
afterEach(async () => {
	for (const made of clients.splice(0)) await made.close()
})
const ENV = { env: { tenant: "acme" } }

/** What `/peer` answered for `ctx.ip`. */
const peer = async (c: TestClient, ip?: string) => (await (await c.get("/peer", { ip })).json()) as { ip: unknown }

/** Whether a Cookie header carries the workflow's session. */
const signedIn = (cookie: string | null) => cookie?.includes("sid=s1") === true

describe("testClient: each method reaches the app as itself", () => {
	// v0: 192ed684df
	// v0: b158176fbe
	// v0: dac3319e1a
	// v0: 0feaafe3bc
	// v0: 7c5d2db8c9
	// v0: 8c1ddeb157
	// v0: d7a83c1e5f
	it("sends GET, POST, PUT, PATCH, DELETE, OPTIONS and HEAD, each to a route that takes every method", async () => {
		const c = client(ENV)
		const methods = await Promise.all(
			[c.get, c.post, c.put, c.patch, c.delete, c.options].map(async (send) => (await echoed(send("/echo"))).method),
		)
		const head = await c.head("/echo")
		expect([methods, head.status, await head.text()]).toEqual([
			["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
			200,
			"",
		])
	})

	// v0: d8a9592fb6
	// v0: 5ad5c54b7e
	// v0: 1c8e17bb4c
	// v0: ca8a94bca3
	it("sends any method through request(), a custom one included", async () => {
		const c = client(ENV)
		const sent = await Promise.all(
			["PURGE", "PUT"].map(async (method) => (await echoed(c.request(method, "/echo"))).method),
		)
		expect(sent).toEqual(["PURGE", "PUT"])
	})

	// v0: bd6f03e0bd
	it("answers with the app's own Web Response, status and headers untouched", async () => {
		const response = await client(ENV).get("/echo")
		expect([response instanceof Response, response.status, response.headers.get("content-type")]).toEqual([
			true,
			200,
			"application/json",
		])
	})

	// v0: d19e57ec22
	it("hands the app its env", async () => {
		expect(await (await client(ENV).get("/env")).json()).toEqual({ tenant: "acme" })
	})
})

describe("testClient: what a request carries", () => {
	// v0: 2be4c99eee
	// v0: bf3f1bdbd0
	// v0: 4b97c057b5
	// v0: 765de32bdb
	it("sends json as an application/json body, on POST and on DELETE alike", async () => {
		const c = client(ENV)
		const json = { items: [1, { deep: true }], name: "ada" }
		const [post, del] = await Promise.all([echoed(c.post("/echo", { json })), echoed(c.delete("/echo", { json }))])
		expect([post.contentType, JSON.parse(post.body), del.method, JSON.parse(del.body)]).toEqual([
			"application/json",
			json,
			"DELETE",
			json,
		])
	})

	// v0: fd21265be6
	// v0: 860d0750c5
	// v0: 1d520006b8
	it("sends form as multipart/form-data, each entry a field the app parses", async () => {
		const app = honey()
		app.post("/form").handler(async (ctx) => ctx.res.json("ok", Object.fromEntries(await ctx.req.formData())))
		const c = testClient(app, { env: {} })
		const response = await c.post("/form", { form: { a: "1", name: "ada" } })
		expect(await response.json()).toEqual({ a: "1", name: "ada" })
	})

	// v0: 2f01ec0e94
	// v0: 9878ae3a54
	// v0: 88eee17f85
	// v0: 3961c077ea
	// v0: 041e410fa8
	// v0: d7cccc30cb
	// v0: da043c3cd5
	it("sends headers and search params, with json, on one request", async () => {
		const sent = await echoed(
			client(ENV).put("/echo", { headers: { "x-trace": "t-1" }, json: { ok: true }, search: { page: "2", q: "a b" } }),
		)
		expect([sent.method, sent.header, sent.search, sent.contentType, sent.body]).toEqual([
			"PUT",
			"t-1",
			"?page=2&q=a+b",
			"application/json",
			'{"ok":true}',
		])
	})

	// v0: b3a15575a9
	it("sets the peer ctx.ip reads: the client's default, a request's own ip over it, none when neither", async () => {
		const ips = [
			await peer(client({ ...ENV, ip: "203.0.113.7" })),
			await peer(client({ ...ENV, ip: "203.0.113.7" }), "::1"),
		]
		expect([...ips, await peer(client(ENV))]).toEqual([{ ip: "203.0.113.7" }, { ip: "::1" }, { ip: null }])
	})
})

/** An app whose `/set` answers the Set-Cookie lines in `?c=` (repeatable) and whose `/seen` echoes the Cookie header. */
function cookieApp() {
	const app = honey()
	app.get("/set").handler((ctx) => {
		const lines = new URL(ctx.req.url).searchParams.getAll("c")
		return ctx.res.raw(new Response("set", { headers: lines.map((line) => ["set-cookie", line]) }))
	})
	app.get("/seen").handler((ctx) => ctx.res.json("ok", { cookie: ctx.req.headers.get("cookie") }))
	return app
}

/** Each `/set` call's lines, then what `/seen` received, through one client. */
async function jarAfter(c: TestClient, ...calls: string[][]): Promise<unknown> {
	for (const lines of calls)
		await c.request("GET", `/set?${lines.map((line) => `c=${encodeURIComponent(line)}`).join("&")}`)
	return ((await (await c.get("/seen")).json()) as { cookie: unknown }).cookie
}

describe("testClient: the cookie jar", () => {
	// v0: 6baf77dafc
	// v0: c3424aadd9
	// v0: f55c62ec29
	// v0: 9fb5f21d42
	// v0: 50b9d60a33
	// v0: 96f77f8fef
	it("keeps each response's cookies and sends them all on the next request", async () => {
		const c = testClient(cookieApp(), { cookies: true, env: {} })
		expect(await jarAfter(c, ["sid=abc; Path=/; HttpOnly"], ["cart=3", "theme=dark"])).toBe(
			"sid=abc; cart=3; theme=dark",
		)
	})

	// v0: 973cec1e23
	// v0: 50748c19d1
	// v0: b5a8266f07
	it("keeps nothing when cookies is off", async () => {
		expect(await jarAfter(testClient(cookieApp(), { env: {} }), ["sid=abc"])).toBeNull()
	})

	// v0: a62caef8ed
	it("replaces a cookie a later response sets again, and adds the caller's own Cookie header first", async () => {
		const c = testClient(cookieApp(), { cookies: true, env: {} })
		await jarAfter(c, ["sid=old"], ["sid=new"])
		const seen = await (await c.get("/seen", { headers: { cookie: "mine=1" } })).json()
		expect(seen).toEqual({ cookie: "mine=1; sid=new" })
	})

	// v0: e575591e5e
	// v0: a096e84d84
	it("drops a cookie a response expires, Max-Age deciding over Expires", async () => {
		const c = testClient(cookieApp(), { cookies: true, env: {} })
		const past = "Thu, 01 Jan 1970 00:00:00 GMT"
		const future = "Fri, 01 Jan 2100 00:00:00 GMT"
		await jarAfter(c, ["a=1", "b=1", "c=1", "d=1", "e=1"])
		const left = await jarAfter(c, [
			"a=x; Max-Age=0",
			`b=x; Expires=${past}`,
			`c=kept; Max-Age=60; Expires=${past}`,
			`d=x; Max-Age=0; Expires=${future}`,
			"bad-line-no-equals",
			"=no-name",
		])
		expect(left).toBe("c=kept; e=1")
	})
})

describe("testClient: a workflow across requests", () => {
	// v0: 794130ef3d
	// v0: 947be001a8
	it("signs in, keeps the session cookie, creates, lists, deletes and sees the 401 once signed out", async () => {
		const app = honey()
		const items = new Map<string, string>()
		app.post("/login").handler((ctx) => ctx.res.json("ok", {}, { cookies: { sid: { path: "/", value: "s1" } } }))
		app
			.post("/logout")
			.handler((ctx) => ctx.res.json("ok", {}, { cookies: { sid: { maxAge: 0, path: "/", value: "" } } }))
		app.all("/items").handler(async (ctx) => {
			if (!signedIn(ctx.req.headers.get("cookie"))) return ctx.res.json("unauthorized", { error: "sign in" })
			if (ctx.req.method === "POST")
				items.set(String(items.size + 1), ((await ctx.req.json()) as { name: string }).name)
			if (ctx.req.method === "DELETE") items.delete(new URL(ctx.req.url).searchParams.get("id") ?? "")
			return ctx.res.json("ok", [...items.values()])
		})
		const c = testClient(app, { cookies: true, env: {} })
		const statuses: number[] = [(await c.get("/items")).status, (await c.post("/login")).status]
		await c.post("/items", { json: { name: "a" } })
		await c.post("/items", { json: { name: "b" } })
		const listed = await (await c.delete("/items", { search: { id: "1" } })).json()
		statuses.push((await c.post("/logout")).status, (await c.get("/items")).status)
		expect([statuses, listed]).toEqual([[401, 200, 200, 401], ["b"]])
	})
})

describe("testClient: transport serve", () => {
	// v0: 08c44f3b06
	it("sends real HTTP through serve(app), the socket's peer and the cookie jar included, until close()", async () => {
		const c = testClient(cookieApp(), { cookies: true, env: {}, transport: "serve" })
		const peerApp = honey()
		peerApp.get("/peer").handler((ctx) => ctx.res.json("ok", { ip: ctx.ip }))
		const served = testClient(peerApp, { env: {}, ip: "203.0.113.7", transport: "serve" })
		const ip = await (await served.get("/peer")).json()
		const cookie = await jarAfter(c, ["sid=abc"])
		await Promise.all([c.close(), served.close(), c.close()])
		expect([ip, cookie]).toEqual([{ ip: "127.0.0.1" }, "sid=abc"])
	})
})
