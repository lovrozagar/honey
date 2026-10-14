import type { AddressInfo } from "node:net"
import { describe, expect, it, vi } from "vitest"
import { serve } from "../adapters/node/serve.ts"
import { defineErrors } from "../errors/errors.ts"
import { createMiddleware } from "../middleware/middleware.ts"
import { createLogger } from "../telemetry/logger.ts"
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

describe("a failing tap never touches the answer", () => {
	// v0: 69bcc49cbd
	// v0: 8dce7abe58
	// v0: 05dba8c08a
	// v0: f9aa688055
	it("a throw or a rejection: the answer stands, the other taps fire, onError never hears, a warn says which", async () => {
		const lines: Record<string, unknown>[] = []
		const onError = vi.fn()
		const received: string[] = []
		const app = honey<{}>()
		app.logger(
			createLogger({
				format: "json",
				level: "info",
				write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
			}),
		)
		app.onError(onError)
		app.tap("throws", () => {
			throw new Error("sync tap bug")
		})
		app.tap("rejects", async () => {
			throw new Error("async tap bug")
		})
		app.tap("fine", () => void received.push("fine"))
		app.get("/t").handler((ctx) => {
			ctx.tap("throws", {})
			ctx.tap("rejects", {})
			ctx.tap("fine", {})
			return ctx.res.json("ok", {})
		})
		const res = await app.fetch(get("/t"), {})
		await settle()
		expect([
			res.status,
			received,
			onError.mock.calls.length,
			lines.map((line) => [line.level, line.msg, line.tap, (line.err as { message: string }).message, line.routeId]),
		]).toEqual([
			200,
			["fine"],
			0,
			[
				[40, "tap failed", "throws", "sync tap bug", "GET /t"],
				[40, "tap failed", "rejects", "async tap bug", "GET /t"],
			],
		])
	})
})

describe("what a tap sees", () => {
	// v0: fb4d1f631e
	// v0: 2343a4cd3e
	// v0: f33c24d889
	// v0: 379e3b2a6f
	// v0: 36f5ca835f
	it("the request's params, headers, meta, env, path, pattern, and what middleware added", async () => {
		let seen: Record<string, unknown> = {}
		const app = honey<{ REGION: string }>().meta<{ audit?: boolean }>()
		app.tap("audit", (ctx) => {
			seen = {
				added: (ctx as unknown as { user: string }).user,
				env: ctx.env.REGION,
				header: ctx.headers["x-trace"],
				meta: ctx.meta.audit,
				param: ctx.params.id,
				path: ctx.path,
				pattern: ctx.routePattern,
				search: ctx.search.q,
			}
		})
		app
			.use(createMiddleware(async (_ctx, next) => next({ user: "ada" })))
			.get("/items/:id")
			.meta({ audit: true })
			.handler((ctx) => ctx.res.json("ok", {}))
		await app.fetch(get("/items/42?q=x", { headers: { "x-trace": "t1" } }), { REGION: "eu" })
		expect(seen).toEqual({
			added: "ada",
			env: "eu",
			header: "t1",
			meta: true,
			param: "42",
			path: "/items/42",
			pattern: "/items/:id",
			search: "x",
		})
	})

	// v0: 18d4adb0e5
	it("each payload as given: one tap changing its own leaves another's untouched", async () => {
		const seen: unknown[] = []
		const app = honey<{}>()
		app.tap("first", (_ctx, payload) => {
			;(payload as Record<string, unknown>).mutated = true
		})
		app.tap("second", (_ctx, payload) => void seen.push(payload))
		app.get("/t").handler((ctx) => {
			ctx.tap("first", { id: 1 })
			ctx.tap("second", { id: 2 })
			return ctx.res.json("ok", {})
		})
		await app.fetch(get("/t"), {})
		expect(seen).toEqual([{ id: 2 }])
	})
})

describe("when taps run", () => {
	// v0: 269fbb17ea
	it("a slow tap does not delay the answer", async () => {
		const app = honey<{}>()
		app.tap("slow", () => new Promise((resolve) => setTimeout(resolve, 500)))
		app.get("/t").handler((ctx) => {
			ctx.tap("slow", {})
			return ctx.res.json("ok", {})
		})
		const started = performance.now()
		const res = await app.fetch(get("/t"), {})
		expect([res.status, performance.now() - started < 100]).toEqual([200, true])
	})

	// v0: d61bb1924d
	// v0: 339d1aec69
	it("through waitUntil, called as a method of the execution context", async () => {
		const received: unknown[] = []
		const app = honey<{}>()
		app.tap("audit", async (_ctx, payload) => {
			await settle()
			received.push(payload)
		})
		app.get("/t").handler((ctx) => {
			ctx.tap("audit", { tracked: true })
			return ctx.res.json("ok", {})
		})
		const executionCtx = {
			pending: [] as Promise<unknown>[],
			waitUntil(this: { pending: Promise<unknown>[] }, promise: Promise<unknown>) {
				this.pending.push(promise)
			},
		}
		await app.fetch(get("/t"), {}, executionCtx as never)
		await Promise.all(executionCtx.pending)
		expect([executionCtx.pending.length, received]).toEqual([1, [{ tracked: true }]])
	})
})

describe("when taps run: after the whole chain", () => {
	// v0: 60913cc86e
	// v0: a18485a7ce
	// v0: a566eaf468
	it("after the whole chain, an async handler's awaited work included", async () => {
		const order: string[] = []
		const app = honey<{}>()
		app.tap("audit", () => void order.push("tap"))
		app
			.use(
				createMiddleware(async (_ctx, next) => {
					order.push("mw:before")
					const res = await next()
					order.push("mw:after")
					return res
				}),
			)
			.get("/t")
			.handler(async (ctx) => {
				await settle()
				order.push("handler")
				await settle()
				ctx.tap("audit", {})
				return ctx.res.json("ok", {})
			})
		await app.fetch(get("/t"), {})
		expect(order).toEqual(["mw:before", "handler", "mw:after", "tap"])
	})
})

describe("methods and mounted apps", () => {
	// v0: 09552c968b
	it("each method on one path fires its own taps", async () => {
		const { app, received, tap } = recording()
		tap("audit")
		app.get("/items").handler((ctx) => {
			ctx.tap("audit", "read")
			return ctx.res.json("ok", {})
		})
		app.post("/items").handler((ctx) => {
			ctx.tap("audit", "write")
			return ctx.res.json("ok", {})
		})
		await app.fetch(get("/items"), { REGION: "eu" })
		await app.fetch(get("/items", { method: "POST" }), { REGION: "eu" })
		expect(received).toEqual([
			["audit", "read"],
			["audit", "write"],
		])
	})
})

describe("mounted apps", () => {
	// v0: 9b1bc502c2
	it("a mounted app's own taps fire for its routes, even when the app serving it has none", async () => {
		const received: unknown[] = []
		const sub = honey<{}>()
		sub.tap("audit", (_ctx, payload) => void received.push(payload))
		sub.get("/tapped").handler((ctx) => {
			ctx.tap("audit", { from: "sub" })
			return ctx.res.text("ok", "ok")
		})
		await honey<{}>().route(sub).fetch(get("/tapped"), {})
		expect(received).toEqual([{ from: "sub" }])
	})

	// v0: efd8986f2d
	it("a mounted app's routes fire the serving app's taps and their own; the serving app's win a shared key", async () => {
		const seen: string[] = []
		const child = honey<{}>()
		child.tap("own", (_ctx, payload) => void seen.push(`child own ${String(payload)}`))
		child.tap("shared", () => void seen.push("child shared"))
		child.get("/child").handler((ctx) => {
			ctx.tap("parent", "p")
			ctx.tap("own", "o")
			ctx.tap("shared", "s")
			return ctx.res.json("ok", {})
		})
		const parent = honey<{}>()
		parent.tap("parent", (_ctx, payload) => void seen.push(`parent ${String(payload)}`))
		parent.tap("shared", () => void seen.push("parent shared"))
		parent.route(child)
		await parent.fetch(get("/child"), {})
		expect(seen).toEqual(["parent p", "child own o", "parent shared"])
	})
})

describe("taps beside errorI18n", () => {
	// v0: a40d4a499b
	it("composed with errorI18n: a handler's answer fires its taps, a translated error answer fires none", async () => {
		const { errorI18n } = await import("../i18n/error-i18n.ts")
		const received: unknown[] = []
		const errors = defineErrors({ gone: "not_found" })
		const app = honey<{}>()
			.errorFactory(errors)
			.meta<{ audit?: { action: string } }>()
			.errorI18n(errorI18n({ errors: { en: { gone: "missing {id}" } }, resolveLocale: () => "en" }))
			.tap("audit", (_ctx, payload) => void received.push(payload))
		app
			.get("/item/:id")
			.meta({ audit: { action: "get" } })
			.errors("gone")
			.handler((ctx) => {
				if (ctx.params.id === "0") throw ctx.errors.gone({ vars: { id: "0" } })
				ctx.tap("audit", { action: "ok", id: ctx.params.id })
				return ctx.res.json("ok", { id: ctx.params.id })
			})
		const missing = await app.fetch(get("/item/0"), {})
		await app.fetch(get("/item/7"), {})
		await settle()
		expect([((await missing.json()) as { message: string }).message, received]).toEqual([
			"missing 0",
			[{ action: "get" }, { action: "ok", id: "7" }],
		])
	})
})

describe("over a real listen", () => {
	// v0: b8231ea031
	it("a 200 fires the meta tap and ctx.tap; an error answer fires none", async () => {
		const seen: unknown[] = []
		const app = honey<{}>()
			.errorFactory(defineErrors({ nope: "bad_request" }))
			.meta<{ audit?: { action: string } }>()
			.tap("audit", (_ctx, payload) => void seen.push(payload))
		app
			.get("/ok")
			.meta({ audit: { action: "list" } })
			.handler((ctx) => {
				ctx.tap("audit", { action: "dynamic" })
				return ctx.res.json("ok", { ok: true })
			})
		app
			.get("/boom")
			.errors("nope")
			.handler((ctx) => {
				ctx.tap("audit", { action: "should-not-fire" })
				throw ctx.errors.nope()
			})
		const server = serve(app, { env: {}, hostname: "127.0.0.1", port: 0 })
		await new Promise((resolve) => server.once("listening", resolve))
		const { port } = server.address() as AddressInfo
		try {
			const ok = await fetch(`http://127.0.0.1:${port}/ok`)
			const boom = await fetch(`http://127.0.0.1:${port}/boom`)
			await settle()
			expect([ok.status, await ok.json(), boom.status, seen]).toEqual([
				200,
				{ ok: true },
				400,
				[{ action: "list" }, { action: "dynamic" }],
			])
		} finally {
			await server.shutdown(0)
		}
	})
})
