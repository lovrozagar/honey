import { describe, expect, it, vi } from "vitest"
import { createMiddleware, honey } from "../../../src/index.ts"
import type { WSHandler } from "../../../src/ws/cloudflare.ts"
import { WSContextImpl } from "../../../src/ws/cloudflare.ts"

function make101Response(): Response {
	const response = new Response(null, { status: 200 })
	Object.defineProperty(response, "status", { value: 101 })
	return response
}

function testWsAdapter() {
	const mockRaw = { close: vi.fn(), readyState: 1, send: vi.fn() }
	return {
		upgrade(_req: Request, _env: unknown, handler: WSHandler<unknown>) {
			const socket = new WSContextImpl(mockRaw)
			handler.onOpen?.(undefined, socket)
			return { response: make101Response(), socket }
		},
	}
}

describe(".route() merges sub-router tree into parent", () => {
	it("sub-router routes accessible on parent after .route()", async () => {
		const sub = honey<{}>()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "from-sub"))

		const app = honey<{}>()
			.get("/main")
			.handler((ctx) => ctx.res.text("ok", "from-main"))
			.route(sub)

		const mainRes = await app.fetch(new Request("http://localhost/main"), {})
		expect(mainRes.status).toBe(200)
		expect(await mainRes.text()).toBe("from-main")

		const subRes = await app.fetch(new Request("http://localhost/health"), {})
		expect(subRes.status).toBe(200)
		expect(await subRes.text()).toBe("from-sub")
	})

	it("multiple .route() calls merge all sub-routers", async () => {
		const auth = honey<{}>()
			.get("/login")
			.handler((ctx) => ctx.res.text("ok", "login"))

		const users = honey<{}>()
			.get("/users")
			.handler((ctx) => ctx.res.text("ok", "users"))

		const app = honey<{}>()
			.get("/")
			.handler((ctx) => ctx.res.text("ok", "root"))
			.route(auth)
			.route(users)

		expect((await app.fetch(new Request("http://localhost/"), {})).status).toBe(200)
		expect(await (await app.fetch(new Request("http://localhost/login"), {})).text()).toBe("login")
		expect(await (await app.fetch(new Request("http://localhost/users"), {})).text()).toBe("users")
	})

	it("sub-router with params merges correctly", async () => {
		const sub = honey<{}>()
			.get("/orgs/:orgId")
			.handler((ctx) => ctx.res.json("ok", { id: ctx.params.orgId }))

		const app = honey<{}>().route(sub)

		const res = await app.fetch(new Request("http://localhost/orgs/o-1"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.id).toBe("o-1")
	})

	it("duplicate route across parent and sub → throws on merge", async () => {
		const sub = honey<{}>()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "sub"))

		const app = honey<{}>()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "parent"))

		expect(() => app.route(sub)).toThrow(/conflict|duplicate/i)
	})

	it("sub-router middleware runs for sub routes", async () => {
		let mwCalled = false
		const mw = createMiddleware(async (_ctx, next) => {
			mwCalled = true
			return next()
		})

		const sub = honey<{}>()
			.use(mw)
			.get("/guarded")
			.handler((ctx) => ctx.res.text("ok", "guarded"))

		const app = honey<{}>()
			.get("/public")
			.handler((ctx) => ctx.res.text("ok", "public"))
			.route(sub)

		/* public route — middleware should NOT run */
		mwCalled = false
		await app.fetch(new Request("http://localhost/public"), {})
		expect(mwCalled).toBe(false)

		/* guarded route — middleware should run (stored on handler.mw) */
		mwCalled = false
		await app.fetch(new Request("http://localhost/guarded"), {})
		expect(mwCalled).toBe(true)
	})

	it("route() of a separate app carries realtime config (426 + upgrade)", async () => {
		const ran: string[] = []
		const sub = honey()
			.wsAdapter(testWsAdapter())
			.realtime("/chat/stream", {
				handler: () => {
					ran.push("open")
				},
			})

		const app = honey().wsAdapter(testWsAdapter()).route(sub)

		const http = await app.fetch(new Request("http://localhost/chat/stream"), {})
		expect(http.status).toBe(426)

		const ws = await app.fetch(
			new Request("http://localhost/chat/stream", {
				headers: { connection: "Upgrade", upgrade: "websocket" },
			}),
			{},
		)
		expect(ws.status).toBe(101)
		expect(ran).toEqual(["open"])
	})

	it("parent HEAD uses a GET route registered on the child", async () => {
		const app = honey()
		const child = app.use(async (_ctx, next) => next())
		child.get("/only-get").handler((ctx) => ctx.res.text("ok", "hello"))
		const res = await app.fetch(new Request("http://localhost/only-get", { method: "HEAD" }), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("")
	})

	it("routeTree() after use() is visible on the child fetch", async () => {
		const live = honey()
		live.get("/from-tree").handler((ctx) => ctx.res.text("ok", "tree"))
		const app = honey()
		const child = app.use(async (_ctx, next) => next())
		app.routeTree(live.toRouteTree())

		const viaParent = await app.fetch(new Request("http://localhost/from-tree"), {})
		expect(viaParent.status).toBe(200)
		expect(await viaParent.text()).toBe("tree")

		const viaChild = await child.fetch(new Request("http://localhost/from-tree"), {})
		expect(viaChild.status).toBe(200)
		expect(await viaChild.text()).toBe("tree")
	})

	it("parent fetch runs realtime registered on a use() child", async () => {
		const ran: string[] = []
		const app = honey().wsAdapter(testWsAdapter())
		const child = app.use(async (_ctx, next) => next())
		child.realtime("/live", {
			handler: () => {
				ran.push("child")
			},
		})

		const res = await app.fetch(
			new Request("http://localhost/live", {
				headers: { connection: "Upgrade", upgrade: "websocket" },
			}),
			{},
		)
		expect(res.status).toBe(101)
		expect(ran).toEqual(["child"])
	})

	it("route() of a separate app carries tap handlers", async () => {
		const received: unknown[] = []
		const sub = honey()
		sub.tap("audit", async (_ctx, payload) => {
			received.push(payload)
		})
		sub.get("/tapped").handler((ctx) => {
			ctx.tap("audit", { from: "sub" })
			return ctx.res.text("ok", "ok")
		})

		const app = honey().route(sub)
		await app.fetch(new Request("http://localhost/tapped"), {})
		expect(received).toEqual([{ from: "sub" }])
	})
})
