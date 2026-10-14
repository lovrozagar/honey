/**
 * The edge middleware over a real node:http listen: what a client gets on the wire from an app
 * with security headers, CORS, request ids and server timing (on a route and on a 404), a CORS
 * preflight, ipRestrict deciding on the socket's own peer whatever the client claims, context
 * values, and concurrent mixed requests each answered as their own.
 */
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { type HoneyServer, serve } from "../../src/adapters/node/serve.ts"
import { cors } from "../../src/middleware/cors.ts"
import { ipRestrict } from "../../src/middleware/ip-restrict.ts"
import { poweredBy } from "../../src/middleware/powered-by.ts"
import { requestId } from "../../src/middleware/request-id.ts"
import { secureHeaders } from "../../src/middleware/secure-headers.ts"
import { serverTiming } from "../../src/middleware/server-timing.ts"
import { HoneyError } from "../../src/errors/error.ts"
import { honey } from "../../src/routing/app.ts"

type App = { fetch(request: Request, env: {}): Response | Promise<Response> }

const servers: HoneyServer[] = []

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.shutdown(0)))
})

/** Serve `app` on a free loopback port; the base URL to reach it. */
async function listen(app: App): Promise<string> {
	const server = serve(app, { env: {}, hostname: "127.0.0.1", port: 0 })
	servers.push(server)
	await new Promise((resolve) => server.once("listening", resolve))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** An app with the whole edge stack in front of a health route. */
function edgeApp() {
	const app = honey<{}>()
	const edged = app
		.use(secureHeaders())
		.use(cors({ origin: "http://allowed.com" }))
		.use(requestId())
		.use(serverTiming())
	edged.get("/health").handler((ctx) => ctx.res.json("ok", { status: "healthy" }))
	return app
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe("the edge stack on the wire", () => {
	// v0: 83aaa2098d
	it("a route and an unknown path both carry the security headers and a fresh request id", async () => {
		const base = await listen(edgeApp())
		const [ok, missing] = [await fetch(`${base}/health`), await fetch(`${base}/nonexistent`)]
		const edge = (res: Response) => [
			res.headers.get("x-content-type-options"),
			res.headers.get("x-frame-options"),
			res.headers.get("referrer-policy"),
			UUID.test(res.headers.get("x-request-id") ?? ""),
		]
		expect([ok.status, await ok.json(), ...edge(ok), ok.headers.get("server-timing")?.includes("total;dur=")]).toEqual([
			200,
			{ status: "healthy" },
			"nosniff",
			"SAMEORIGIN",
			"strict-origin-when-cross-origin",
			true,
			true,
		])
		expect([missing.status, ...edge(missing)]).toEqual([
			404,
			"nosniff",
			"SAMEORIGIN",
			"strict-origin-when-cross-origin",
			true,
		])
	})

	// v0: 0b3b0b7584
	it("a preflight from the allowed origin is 204, naming it and varying on Origin", async () => {
		const base = await listen(edgeApp())
		const res = await fetch(`${base}/health`, {
			headers: { "access-control-request-method": "GET", origin: "http://allowed.com" },
			method: "OPTIONS",
		})
		expect([
			res.status,
			res.headers.get("access-control-allow-origin"),
			res.headers.get("vary")?.includes("Origin"),
		]).toEqual([204, "http://allowed.com", true])
	})
})

const missing = () => new HoneyError({ errorKey: "not_found", status: "not_found" })

/** A list of items with create, read and delete, behind CORS, security headers and request ids. */
function itemsApp() {
	const items: { id: number; name: string }[] = []
	const find = (id: string) => items.findIndex((item) => item.id === Number(id))
	const app = honey<{}>()
	const edged = app
		.use(cors({ origin: "*" }))
		.use(secureHeaders())
		.use(requestId())
	edged.get("/items").handler((ctx) => ctx.res.json("ok", items))
	edged.post("/items").handler(async (ctx) => {
		const item = { id: items.length + 1, name: ((await ctx.req.json()) as { name: string }).name }
		items.push(item)
		return ctx.res.json("created", item)
	})
	edged.get("/items/:id").handler((ctx) => {
		const at = find(ctx.params.id)
		if (at === -1) throw missing()
		return ctx.res.json("ok", items[at])
	})
	edged.delete("/items/:id").handler((ctx) => {
		const at = find(ctx.params.id)
		if (at === -1) throw missing()
		items.splice(at, 1)
		return ctx.res.noContent()
	})
	return app
}

describe("a resource's whole life behind the edge stack", () => {
	// v0: f69441538b
	it("list, create, read, miss, wrong method, delete and list again, each answer carrying the edge headers", async () => {
		const base = await listen(itemsApp())
		const steps: [string, string, string | undefined][] = [
			["GET", "/items", undefined],
			["POST", "/items", JSON.stringify({ name: "Widget" })],
			["GET", "/items/1", undefined],
			["GET", "/items/999", undefined],
			["PATCH", "/items", undefined],
			["DELETE", "/items/1", undefined],
			["GET", "/items", undefined],
		]
		const answers = []
		for (const [method, path, body] of steps) {
			const headers = { origin: "http://app.example", ...(body && { "content-type": "application/json" }) }
			const res = await fetch(`${base}${path}`, { body, headers, method })
			answers.push([
				method,
				path,
				res.status,
				res.status === 200 || res.status === 201 ? await res.json() : null,
				res.headers.get("access-control-allow-origin"),
				res.headers.get("x-content-type-options"),
				UUID.test(res.headers.get("x-request-id") ?? ""),
			])
		}
		const edge = ["*", "nosniff", true]
		expect(answers).toEqual([
			["GET", "/items", 200, [], ...edge],
			["POST", "/items", 201, { id: 1, name: "Widget" }, ...edge],
			["GET", "/items/1", 200, { id: 1, name: "Widget" }, ...edge],
			["GET", "/items/999", 404, null, ...edge],
			["PATCH", "/items", 405, null, ...edge],
			["DELETE", "/items/1", 204, null, ...edge],
			["GET", "/items", 200, [], ...edge],
		])
	})
})

describe("a redirect the handler builds, under the header middleware", () => {
	// v0: 679adf64e2
	// v0: 7b2670bde7
	it("Response.redirect, returned or through res.raw(), keeps its location and gains every middleware's headers", async () => {
		const app = honey<{}>()
		const stamped = app
			.use(requestId({ trustInbound: true }))
			.use(secureHeaders())
			.use(poweredBy())
			.use(serverTiming())
		stamped.get("/go").handler(() => Response.redirect("https://example.com/", 302) as never)
		stamped.get("/asset").handler((ctx) => ctx.res.raw(Response.redirect("https://example.com/asset.json", 302)))
		const base = await listen(app)
		const answers = []
		for (const path of ["/go", "/asset"]) {
			const res = await fetch(`${base}${path}`, { headers: { "x-request-id": "rid-1" }, redirect: "manual" })
			answers.push([
				res.status,
				res.headers.get("location"),
				res.headers.get("x-request-id"),
				res.headers.get("x-content-type-options"),
				res.headers.get("x-powered-by") !== null,
				res.headers.get("server-timing") !== null,
			])
		}
		expect(answers).toEqual([
			[302, "https://example.com/", "rid-1", "nosniff", true, true],
			[302, "https://example.com/asset.json", "rid-1", "nosniff", true, true],
		])
	})
})

describe("ipRestrict on a real socket", () => {
	// v0: 8345fd903e
	// v0: 3cd87b9b79
	it("decides on the socket's peer: loopback allowed or refused by the list, a forwarded claim changing nothing", async () => {
		const allowing = honey<{}>()
		allowing
			.use(ipRestrict({ allowList: ["127.0.0.1"] }))
			.get("/admin")
			.handler((ctx) => ctx.res.json("ok", { admin: true }))
		const refusing = honey<{}>()
		refusing
			.use(ipRestrict({ allowList: ["10.0.0.0/8"] }))
			.get("/admin")
			.handler((ctx) => ctx.res.json("ok", { admin: true }))
		const [allowed, refused] = [await listen(allowing), await listen(refusing)]
		const statuses = []
		for (const [base, claim] of [
			[allowed, "203.0.113.50"],
			[refused, "10.0.0.1"],
		] as const) {
			statuses.push((await fetch(`${base}/admin`, { headers: { "x-forwarded-for": claim } })).status)
		}
		expect(statuses).toEqual([200, 403])
	})
})

describe("context values and concurrency on a real socket", () => {
	// v0: 0c1527197c
	it("app.context() values reach the handler", async () => {
		const app = honey<{}>().context({ appName: "test-app", version: 42 })
		app.get("/info").handler((ctx) => ctx.res.json("ok", { app: ctx.appName, v: ctx.version }))
		const res = await fetch(`${await listen(app)}/info`)
		expect([res.status, await res.json()]).toEqual([200, { app: "test-app", v: 42 }])
	})

	// v0: 8c6407be66
	it("50 concurrent GETs and POSTs each get their own answer, CORS on every one", async () => {
		const app = honey<{}>()
		const corsed = app.use(cors({ origin: "*" }))
		corsed.get("/echo/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id, method: "GET" }))
		corsed
			.post("/echo/:id")
			.handler(async (ctx) =>
				ctx.res.json("created", { body: (await ctx.req.json()) as unknown, id: ctx.params.id, method: "POST" }),
			)
		const base = await listen(app)
		const answers = await Promise.all(
			Array.from({ length: 50 }, async (_, i) => {
				const init: RequestInit =
					i % 2 === 0
						? { headers: { origin: "http://app.com" } }
						: {
								body: JSON.stringify({ n: i }),
								headers: { "content-type": "application/json", origin: "http://app.com" },
								method: "POST",
							}
				const res = await fetch(`${base}/echo/${i}`, init)
				return [res.status, res.headers.get("access-control-allow-origin"), await res.json()]
			}),
		)
		expect(answers).toEqual(
			Array.from({ length: 50 }, (_, i) =>
				i % 2 === 0
					? [200, "*", { id: String(i), method: "GET" }]
					: [201, "*", { body: { n: i }, id: String(i), method: "POST" }],
			),
		)
	})
})
