/**
 * The edge middleware over a real node:http listen: what a client gets on the wire from an app
 * with security headers, CORS, request ids and server timing (on a route and on a 404), a CORS
 * preflight, ipRestrict deciding on the socket's own peer whatever the client claims, context
 * values, concurrent mixed requests each answered as their own, csrf on a form POST, and each
 * header middleware over a redirect, an upgrade and an immutable fetch() answer; and an app with all
 * of it at once beside bodyLimit, etag, validation, translated errors and telemetry.
 */
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { type HoneyServer, serve } from "../../src/adapters/node/serve.ts"
import { cors } from "../../src/middleware/cors.ts"
import { csrf } from "../../src/middleware/csrf.ts"
import { ipRestrict } from "../../src/middleware/ip-restrict.ts"
import { poweredBy } from "../../src/middleware/powered-by.ts"
import { requestId } from "../../src/middleware/request-id.ts"
import { secureHeaders } from "../../src/middleware/secure-headers.ts"
import { serverTiming } from "../../src/middleware/server-timing.ts"
import * as z from "zod"
import { HoneyError } from "../../src/errors/error.ts"
import { defineErrors } from "../../src/errors/errors.ts"
import { errorI18n } from "../../src/i18n/error-i18n.ts"
import { bodyLimit } from "../../src/input/body-limit.ts"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { etag } from "../../src/response/etag.ts"
import { recorder } from "../../src/telemetry/__fixtures__/recording-tracer.ts"
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

describe("request ids on a real socket", () => {
	// v0: 0e6419f4a8
	it("10 concurrent requests each get their own request id", async () => {
		const app = honey<{}>()
		app
			.use(requestId())
			.get("/ping")
			.handler((ctx) => ctx.res.json("ok", { pong: true }))
		const base = await listen(app)
		const answers = await Promise.all(
			Array.from({ length: 10 }, async () => {
				const res = await fetch(`${base}/ping`)
				return { body: (await res.json()) as unknown, id: res.headers.get("x-request-id") ?? "", status: res.status }
			}),
		)
		const ids = answers.map((answer) => answer.id)
		expect([
			answers.every((answer) => answer.status === 200 && JSON.stringify(answer.body) === '{"pong":true}'),
			ids.every((id) => UUID.test(id)),
			new Set(ids).size,
		]).toEqual([true, true, 10])
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
	// v0: 99895f5e73
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

describe("csrf on a real socket", () => {
	// v0: 2700653e0c
	it("a same-origin form POST reaches the handler; a cross-site one is refused before it", async () => {
		const app = honey<{}>()
		app
			.use(csrf())
			.post("/echo")
			.handler(async (ctx) => ctx.res.text("ok", await ctx.req.text()))
		const base = await listen(app)
		const post = async (site: string) => {
			const res = await fetch(`${base}/echo`, {
				body: "data=safe",
				headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": site },
				method: "POST",
			})
			return [res.status, await res.text()]
		}
		expect([await post("same-origin"), (await post("cross-site"))[0]]).toEqual([[200, "data=safe"], 403])
	})
})

/** Each middleware that edits the headers of the answer it gets back from next(). */
const HEADER_MIDDLEWARE = [
	["requestId", requestId()],
	["poweredBy", poweredBy()],
	["secureHeaders", secureHeaders()],
	["serverTiming", serverTiming()],
	["cors", cors({ origin: "http://app.test" })],
] as const

describe("header middleware over answers it cannot edit in place", () => {
	// v0: 5771b583ff
	it.each(HEADER_MIDDLEWARE)("%s over Response.redirect() answers its 302 and location", async (_name, mw) => {
		const app = honey<{}>()
		app
			.use(mw as never)
			.get("/go")
			.handler(() => Response.redirect("http://example.com/next", 302) as never)
		const res = await app.fetch(new Request("http://localhost/go", { headers: { origin: "http://app.test" } }), {})
		expect([res.status, res.headers.get("location")]).toEqual([302, "http://example.com/next"])
	})

	// v0: 87ad46cd4d
	it.each(HEADER_MIDDLEWARE)("%s passes a 101 upgrade through as the same response", async (_name, mw) => {
		const upgraded = new Response(null)
		Object.defineProperty(upgraded, "status", { value: 101 })
		const socket = { close() {}, raw: null, readyState: 1 as const, send() {} }
		const app = honey<{}>().wsAdapter({ upgrade: () => ({ response: upgraded, socket }) })
		app
			.use(mw as never)
			.ws("/live")
			.handler({})
		const headers = { connection: "Upgrade", origin: "http://app.test", upgrade: "websocket" }
		expect(await app.fetch(new Request("http://localhost/live", { headers }), {})).toBe(upgraded)
	})

	// v0: f411af65ff
	it("all of them on Node over a fetch() answer, whose headers are immutable, add every header", async () => {
		const origin = honey<{}>()
		origin.get("/").handler((ctx) => ctx.res.text("ok", "from upstream"))
		const upstream = await listen(origin)
		const app = honey<{}>()
		app
			.use(requestId())
			.use(poweredBy())
			.use(secureHeaders())
			.use(serverTiming())
			.use(cors({ origin: "http://app.test" }))
			.get("/p")
			.handler(() => fetch(`${upstream}/`) as never)
		const res = await fetch(`${await listen(app)}/p`, { headers: { origin: "http://app.test" } })
		expect([
			res.status,
			await res.text(),
			UUID.test(res.headers.get("x-request-id") ?? ""),
			res.headers.get("x-powered-by"),
			res.headers.get("x-content-type-options"),
			res.headers.get("server-timing")?.includes("total;dur="),
			res.headers.get("access-control-allow-origin"),
		]).toEqual([200, "from upstream", true, "Honey", "nosniff", true, "http://app.test"])
	})
})

/** A production-shaped app: every edge middleware, an auth chain, validated routes, translated errors, telemetry. */
function productionApp() {
	const errors = defineErrors({ item_not_found: "not_found", rate_limited: "too_many_requests" })
	const { spans, telemetry } = recorder()
	const auth = createMiddleware((ctx, next) => {
		if ((ctx as { req: Request }).req.headers.get("authorization") === null) {
			throw new HoneyError({ errorKey: "unauthorized", status: "unauthorized" })
		}
		return next({ userId: "u-1" })
	})
	const app = honey<{}>()
		.logger(false)
		.errorFactory(errors)
		.defaultErrors("rate_limited")
		.outputValidation("always")
		.telemetry(telemetry)
		.errorI18n(errorI18n({ errors: { en: { item_not_found: "Item not found" } }, resolveLocale: () => "en" }))
		/* the auth middleware's refusal is no route's declared error: the app answers it as it is */
		.onError((error, ctx) =>
			error instanceof HoneyError && error.errorKey === "unauthorized" ? ctx.jsonFromError(error) : undefined,
		)
	const api = app
		.use(cors({ credentials: true, origin: "http://app.com" }))
		.use(bodyLimit({ maxSize: 50_000 }))
		.use(etag())
		.use(requestId())
		.use(serverTiming())
		.use(secureHeaders())
		.basePath("/api")
	api.get("/health").handler((ctx) => ctx.res.text("ok", "healthy"))
	const authed = api.use(auth)
	authed
		.get("/items")
		.output({ "application/json": { ok: z.array(z.object({ id: z.number(), name: z.string() })) } })
		.handler((ctx) => {
			ctx.timing.start("db")
			ctx.timing.end("db")
			return ctx.res.json("ok", [{ id: 1, name: "Widget" }])
		})
	authed
		.post("/items")
		.input({ json: z.object({ name: z.string() }) })
		.handler((ctx) => ctx.res.json("created", { name: ctx.input.json.name, userId: ctx.userId }))
	authed
		.get("/items/:id")
		.errors("item_not_found")
		.handler((ctx) => {
			if (ctx.params.id === "0") throw ctx.errors.item_not_found()
			return ctx.res.json("ok", { id: ctx.params.id })
		})
	return { app, spans }
}

describe("a production-shaped app on the wire", () => {
	// v0: e5e2ce62c3
	it("answers public, authed, conditional, created, missing, refused, wrong-method and preflight requests, traced", async () => {
		const { app, spans } = productionApp()
		const base = await listen(app)
		const auth = { authorization: "Bearer tok", origin: "http://app.com" }
		const health = await fetch(`${base}/api/health`)
		const list = await fetch(`${base}/api/items`, { headers: auth })
		const tag = list.headers.get("etag") ?? ""
		const again = await fetch(`${base}/api/items`, { headers: { ...auth, "if-none-match": tag } })
		const created = await fetch(`${base}/api/items`, {
			body: '{"name":"Gadget"}',
			headers: { ...auth, "content-type": "application/json" },
			method: "POST",
		})
		const notFound = await fetch(`${base}/api/items/0`, { headers: auth })
		const preflight = await fetch(`${base}/api/items`, {
			headers: {
				"access-control-request-headers": "content-type, authorization",
				"access-control-request-method": "POST",
				origin: "http://app.com",
			},
			method: "OPTIONS",
		})
		expect([
			[
				health.status,
				await health.text(),
				health.headers.has("x-request-id"),
				health.headers.get("x-content-type-options"),
			],
			[
				list.status,
				list.headers.get("access-control-allow-credentials"),
				tag.startsWith('W/"'),
				list.headers.get("server-timing")?.includes("db"),
				await list.json(),
			],
			[again.status, again.headers.get("access-control-allow-origin")],
			[created.status, await created.json()],
			[notFound.status, ((await notFound.json()) as { message: string }).message],
			(await fetch(`${base}/api/items`)).status,
			[(await fetch(`${base}/api/items`, { method: "PATCH" })).headers.has("allow")],
			[preflight.status, preflight.headers.get("access-control-allow-headers")?.includes("content-type")],
			spans.some((span) => span.name.startsWith("GET") || span.name.startsWith("http")),
		]).toEqual([
			[200, "healthy", true, "nosniff"],
			[200, "true", true, true, [{ id: 1, name: "Widget" }]],
			[304, "http://app.com"],
			[201, { name: "Gadget", userId: "u-1" }],
			[404, "Item not found"],
			401,
			[true],
			[204, true],
			true,
		])
	})
})
