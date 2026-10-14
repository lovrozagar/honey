import { describe, expect, it } from "vitest"
import { HoneyError } from "../errors/error.ts"
import { defineErrors } from "../errors/errors.ts"
import { createMiddleware } from "../middleware/middleware.ts"
import { honey } from "./app.ts"

const get = (path: string, init: RequestInit = {}) => new Request(`http://app.test${path}`, init)
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

/** An app recording every tap it receives, as [key, payload]. */
function recording() {
	const received: [string, unknown][] = []
	const app = honey<{ REGION: string }>()
	const tap = (key: string) => app.tap(key, (_ctx, payload) => void received.push([key, payload]))
	return { app, received, tap }
}

describe("ctx.tap(): payloads queued during the handler fire after its answer", () => {
	// v0: c884d2e967
	// v0: ef3d085579
	// v0: 82c8527a37
	it("each call fires its key once, in call order, the same key as often as called", async () => {
		const { app, received, tap } = recording()
		tap("audit")
		tap("webhook")
		app.get("/t").handler((ctx) => {
			ctx.tap("audit", { action: "first" })
			ctx.tap("webhook", { event: "created" })
			ctx.tap("audit", { action: "second" })
			return ctx.res.json("ok", {})
		})
		const res = await app.fetch(get("/t"), { REGION: "eu" })
		expect([res.status, received]).toEqual([
			200,
			[
				["audit", { action: "first" }],
				["webhook", { event: "created" }],
				["audit", { action: "second" }],
			],
		])
	})

	// v0: 6fea98e765
	// v0: 859201c776
	it("a key nothing registered is ignored, with or without taps on the app", async () => {
		const { app, received, tap } = recording()
		tap("audit")
		app.get("/t").handler((ctx) => {
			ctx.tap("unknown", {})
			return ctx.res.json("ok", {})
		})
		const bare = honey<{}>()
		bare.get("/t").handler((ctx) => {
			ctx.tap("anything", { x: 1 })
			return ctx.res.json("ok", {})
		})
		const [res, plain] = [await app.fetch(get("/t"), { REGION: "eu" }), await bare.fetch(get("/t"), {})]
		expect([res.status, plain.status, received]).toEqual([200, 200, []])
	})
})

describe("ctx.tap(): one queue per request", () => {
	// v0: 741f939aca
	// v0: 645fa8268f
	// v0: d9c2f4b86f
	it("each request has its own queue: 100 calls in one, 5 in each of 50 at once", async () => {
		const { app, received, tap } = recording()
		tap("n")
		app.get("/many").handler((ctx) => {
			for (let i = 0; i < 100; i++) ctx.tap("n", i)
			return ctx.res.json("ok", {})
		})
		app.get("/r/:id").handler((ctx) => {
			for (let i = 0; i < 5; i++) ctx.tap("n", `${ctx.params.id}:${i}`)
			return ctx.res.json("ok", {})
		})
		await app.fetch(get("/many"), { REGION: "eu" })
		await Promise.all(Array.from({ length: 50 }, (_, i) => app.fetch(get(`/r/${i}`), { REGION: "eu" })))
		const perRequest = (id: number) =>
			received.filter(([, p]) => typeof p === "string" && p.startsWith(`${id}:`)).map(([, p]) => p)
		expect([received.length, perRequest(7)]).toEqual([350, ["7:0", "7:1", "7:2", "7:3", "7:4"]])
	})
})

describe("app.tap(): registration", () => {
	// v0: 21b3df6299
	// v0: f5a21f5cb4
	// v0: 51a93aa401
	// v0: ab1bdcfc0d
	it("chainable; the last handler for a key wins; shared by every handle; registered after the routes, still fires", async () => {
		const received: string[] = []
		const app = honey<{}>()
		const scoped = app.use(createMiddleware((_ctx, next) => next()))
		scoped.get("/t").handler((ctx) => {
			ctx.tap("audit", {})
			return ctx.res.json("ok", {})
		})
		const chained = scoped
			.tap("audit", () => void received.push("first"))
			.tap("audit", () => void received.push("second"))
		await app.fetch(get("/t"), {})
		expect([chained === scoped, received]).toEqual([true, ["second"]])
	})

	// v0: 96b7a09811
	// v0: b399142eba
	it(".taps<T>() is types only: the same handle, and taps fire as without it", async () => {
		const received: unknown[] = []
		const base = honey<{}>().meta<{ purge?: { key: string } }>()
		const typed = base.taps<{ purge: { key: string } }>()
		typed.tap("purge", (_ctx, payload) => void received.push(payload.key))
		typed
			.get("/t")
			.meta({ purge: { key: "items" } })
			.handler((ctx) => ctx.res.json("ok", {}))
		await base.fetch(get("/t"), {})
		expect([typed === (base as unknown), received]).toEqual([true, ["items"]])
	})
})

/** An app with taps for `purge` and `audit`, whose route meta may carry either. */
function metaApp() {
	const { app, received, tap } = recording()
	const withMeta = app.meta<{ audit?: unknown; purge?: unknown }>()
	tap("purge")
	tap("audit")
	return { app: withMeta, received }
}

describe("meta-driven taps: a route meta key a tap is registered for fires it", () => {
	// v0: 4003bbad46
	// v0: 0a3d596143
	// v0: 84dccc7642
	// v0: 97f511c813
	// v0: 8bb7b91e96
	// v0: daddedc5ca
	it("with the exact meta value as payload, once per matching key; no key or an undefined value fires nothing", async () => {
		const { app, received } = metaApp()
		app
			.get("/both")
			.meta({ audit: { who: "a" }, purge: { key: "items" } })
			.handler((ctx) => ctx.res.json("ok", {}))
		app.get("/none").handler((ctx) => ctx.res.json("ok", {}))
		app
			.get("/undefined")
			.meta({ audit: undefined })
			.handler((ctx) => ctx.res.json("ok", {}))
		for (const path of ["/both", "/none", "/undefined"]) await app.fetch(get(path), { REGION: "eu" })
		expect(received).toEqual([
			["purge", { key: "items" }],
			["audit", { who: "a" }],
		])
	})

	// v0: f49b814aa4
	// v0: 4451425ccc
	it("chain meta fires on every route of the chain; a route's own meta wins over it", async () => {
		const { app, received } = metaApp()
		const chain = app.meta({ audit: { source: "chain" } })
		chain.get("/a").handler((ctx) => ctx.res.json("ok", {}))
		chain
			.get("/b")
			.meta({ audit: { source: "route" } })
			.handler((ctx) => ctx.res.json("ok", {}))
		await app.fetch(get("/a"), { REGION: "eu" })
		await app.fetch(get("/b"), { REGION: "eu" })
		expect(received).toEqual([
			["audit", { source: "chain" }],
			["audit", { source: "route" }],
		])
	})
})

describe("meta-driven taps: their order beside ctx.tap", () => {
	// v0: 043d466d0b
	// v0: 2149fadd7e
	// v0: 503b33d0d7
	it("meta taps fire before ctx.tap ones, and one key fires from both", async () => {
		const { app, received } = metaApp()
		app
			.get("/t")
			.meta({ purge: { key: "items" } })
			.handler((ctx) => {
				ctx.tap("audit", { action: "create" })
				ctx.tap("purge", { key: "extra" })
				return ctx.res.json("ok", {})
			})
		await app.fetch(get("/t"), { REGION: "eu" })
		expect(received).toEqual([
			["purge", { key: "items" }],
			["audit", { action: "create" }],
			["purge", { key: "extra" }],
		])
	})
})

/** A handler that taps, then fails the way `fail` does. */
function tapped(fail: () => never) {
	return (ctx: { tap(key: string, payload: unknown): void }) => {
		ctx.tap("audit", {})
		return fail()
	}
}

/** Routes that tap and then fail every way an answer can: none may fire. */
function failingApp() {
	const errors = defineErrors({ gone: "gone" })
	const { app, received, tap } = recording()
	tap("audit")
	const withMeta = app.meta<{ audit?: unknown }>().errorFactory(errors)
	const audited = withMeta.meta({ audit: { on: "chain" } })
	audited.get("/honey").handler(
		tapped(() => {
			throw new HoneyError({ errorKey: "gone", status: "gone" })
		}),
	)
	audited.get("/unknown").handler(
		tapped(() => {
			throw new Error("boom")
		}),
	)
	audited
		.get("/factory")
		.errors("gone")
		.handler((ctx) => {
			ctx.tap("audit", {})
			throw ctx.errors.gone()
		})
	audited
		.use(
			createMiddleware(() => {
				throw new Error("guard")
			}),
		)
		.get("/mw-before")
		.handler((ctx) => ctx.res.json("ok", {}))
	audited
		.use(
			createMiddleware(async (_ctx, next) => {
				await next()
				throw new Error("after")
			}),
		)
		.get("/mw-after")
		.handler((ctx) => {
			ctx.tap("audit", {})
			return ctx.res.json("ok", {})
		})
	audited
		.use(createMiddleware(() => new Response(null, { status: 204 })))
		.get("/short")
		.handler((ctx) => ctx.res.json("ok", {}))
	return { app, received }
}

describe("taps fire only after a handler's answer, never on an error answer", () => {
	// v0: 6b097e878d
	// v0: b24e95281c
	// v0: 74bc76f994
	// v0: a351da1510
	// v0: 59780c02bb
	// v0: a66409cf0d
	it.each([
		["a thrown HoneyError", "/honey", 410],
		["an unknown throw", "/unknown", 500],
		["a factory error", "/factory", 410],
		["a 404", "/nowhere", 404],
		["a 405", "/honey?m=post", 405],
		["a middleware throw before the handler", "/mw-before", 500],
		["a middleware throw after the handler answered", "/mw-after", 500],
		["a middleware that answers without calling the handler", "/short", 204],
	])("%s: none", async (_name, path, status) => {
		const { app, received } = failingApp()
		const [route, query] = path.split("?")
		const res = await app.fetch(get(route as string, { method: query === "m=post" ? "POST" : "GET" }), { REGION: "eu" })
		await settle()
		expect([res.status, received]).toEqual([status, []])
	})
})
