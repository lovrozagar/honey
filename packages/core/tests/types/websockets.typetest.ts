/**
 * WebSockets and realtime as typed: the ws(app, path) builder and the ctx its callbacks get, the
 * WSContext/WSHandler/WSAdapter shapes, wsAdapter(), and realtime()'s options, ConnContext and
 * publisher. WS `.input()` is typed at bit 08. Checked by typecheck.
 */
import { describe, expectTypeOf, it } from "vitest"
import type { HoneyContext } from "../../src/context/context.ts"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { realtime } from "../../src/realtime/realtime.ts"
import type { ConnContext } from "../../src/realtime/route.ts"
import type { WSRouteBuilder, WsMeta } from "../../src/routing/ws-builder.ts"
import type { RealtimePublisher } from "../../src/realtime/server.ts"
import { honey } from "../../src/routing/app.ts"
import type { WSAdapter, WSContext, WSHandler, WSReadyState } from "../../src/ws/contract.ts"
import { nodeWebSocket } from "../../src/ws/node.ts"
import { ws } from "../../src/ws/route.ts"

const withUser = createMiddleware((_ctx, next) => next({ user: "ada" as const }))

describe("ws(app, path): the ctx and the socket its callbacks get", () => {
	it("every callback gets the route's params, env and what middleware added, and a WSContext", () => {
		const app = honey<{ db: string }>()
		ws(app.use(withUser), "/rooms/:room").handler({
			onClose: (ctx, socket, code, reason) => {
				expectTypeOf(ctx.params.room).toEqualTypeOf<string>()
				expectTypeOf([socket, code, reason]).toEqualTypeOf<(WSContext | number | string)[]>()
			},
			onError: (ctx, _ws, error) => {
				expectTypeOf(ctx.env.db).toEqualTypeOf<string>()
				expectTypeOf(error).toEqualTypeOf<unknown>()
			},
			onMessage: (ctx, _ws, data) => {
				expectTypeOf(ctx.user).toEqualTypeOf<"ada">()
				expectTypeOf(data).toEqualTypeOf<ArrayBuffer | string>()
			},
			onOpen: (_ctx, socket) => {
				expectTypeOf(socket).toEqualTypeOf<WSContext>()
			},
			onReconnect: (_ctx, _ws, token) => {
				expectTypeOf(token).toEqualTypeOf<string>()
			},
		})
	})

	it("a base path joins the params; a route-level use() adds to the ctx", () => {
		ws(honey<{}>().basePath("/org/:org"), "/feed/:id")
			.use(withUser)
			.handler({
				onOpen: (ctx) => {
					expectTypeOf([ctx.params.id, ctx.params.org]).toEqualTypeOf<string[]>()
					expectTypeOf(ctx.user).toEqualTypeOf<"ada">()
				},
			})
	})

	it("handler() hands back the app; origins, meta and errors keep the builder", () => {
		const app = honey<{}>()
		expectTypeOf(ws(app, "/a").handler({})).toEqualTypeOf(app)
		const built = ws(app, "/b")
			.origins("*")
			.origins(["https://app.example.com"])
			.origins((origin) => origin.endsWith(".example.com"))
			.meta({ summary: "live" })
			.errors("forbidden")
		expectTypeOf(built.handler({})).toEqualTypeOf(app)
		// @ts-expect-error an origin policy is "*", a list or a predicate
		ws(app, "/c").origins("https://app.example.com")
	})
})

describe("ws(app, path): the ctx, params and parent of a WebSocket route", () => {
	const withTenant = createMiddleware((_ctx, next) => next({ tenant: "acme" as const }))
	type Params<T> = Record<string, string> & T

	it("the app's ctx, and a scoped middleware's additions on a path under its scope alone", () => {
		const app = honey<{ db: string }>().use(withUser).use("/rooms", withTenant)
		ws(app, "/rooms/:id").handler({
			onOpen: (ctx) => {
				expectTypeOf(ctx.env.db).toEqualTypeOf<string>()
				expectTypeOf(ctx.user).toEqualTypeOf<"ada">()
				expectTypeOf(ctx.tenant).toEqualTypeOf<"acme">()
				expectTypeOf(ctx.params).toEqualTypeOf<Params<{ id: string }>>()
			},
		})
		// @ts-expect-error the scope is /rooms: /lobby gets no tenant
		ws(app, "/lobby").handler({ onOpen: (ctx) => void ctx.tenant })
		type Ctx = HoneyContext<{ db: string }> & { user: "ada" }
		expectTypeOf(ws(app, "/rooms/:id")).toEqualTypeOf<
			WSRouteBuilder<Ctx & { tenant: "acme" }, "/rooms/:id", typeof app>
		>()
		expectTypeOf(ws(app, "/lobby")).toEqualTypeOf<WSRouteBuilder<Ctx, "/lobby", typeof app>>()
	})

	it("params join a base path's, and handler() hands back the handle it was given", () => {
		const org = honey<{}>().basePath("/org/:org")
		ws(org, "/rooms/:id").handler({
			onOpen: (ctx) => {
				expectTypeOf(ctx.params).toEqualTypeOf<Params<{ id: string; org: string }>>()
			},
		})
		expectTypeOf(ws(org, "/rooms/:id").handler({})).toEqualTypeOf(org)
		expectTypeOf(ws(org, "/rooms/:id")).toEqualTypeOf<
			WSRouteBuilder<HoneyContext<{}>, "/org/:org/rooms/:id", typeof org>
		>()
	})
})

describe("the socket, the handler and the adapter", () => {
	// v0: 3277130810
	it("WSContext sends text, bytes or a JSON value, never a bare number", () => {
		const socket = {} as WSContext
		expectTypeOf(socket.readyState).toEqualTypeOf<WSReadyState>()
		expectTypeOf<WSReadyState>().toEqualTypeOf<0 | 1 | 2 | 3>()
		expectTypeOf(socket.send).toBeCallableWith("text")
		expectTypeOf(socket.send).toBeCallableWith(new ArrayBuffer(1))
		expectTypeOf(socket.send).toBeCallableWith(new Uint8Array(1))
		expectTypeOf(socket.send).toBeCallableWith({ n: 1 })
		// @ts-expect-error a number is not a message
		socket.send(1)
		expectTypeOf(socket.close).toBeCallableWith(1000, "bye")
	})

	it("every WSHandler callback is optional; an adapter upgrades with one", () => {
		expectTypeOf<{}>().toExtend<WSHandler>()
		expectTypeOf<WSAdapter["upgrade"]>().parameters.toEqualTypeOf<[Request, unknown, WSHandler<unknown>]>()
		expectTypeOf<WSAdapter["runtime"]>().toEqualTypeOf<"bun" | "node" | "workers" | undefined>()
	})

	it("wsAdapter() takes an adapter value and keeps the app", () => {
		const app = honey<{}>()
		expectTypeOf(app.wsAdapter(nodeWebSocket())).toEqualTypeOf(app)
		// @ts-expect-error an adapter needs upgrade()
		app.wsAdapter({})
	})
})

describe("realtime(app, path, opts)", () => {
	it("identify and handler get the route's ctx; handler gets a ConnContext; the publisher comes back", () => {
		const app = honey<{}>().use(withUser)
		const publisher = realtime(app, "/rooms/:room", {
			handler: (ctx, conn) => {
				expectTypeOf(ctx.params.room).toEqualTypeOf<string>()
				expectTypeOf(ctx.user).toEqualTypeOf<"ada">()
				expectTypeOf(conn).toEqualTypeOf<ConnContext>()
			},
			identify: (ctx) => ctx.params.room,
		})
		expectTypeOf(publisher).toEqualTypeOf<RealtimePublisher>()
		expectTypeOf(publisher.namespace("chat").publish).toEqualTypeOf<(topic: string, data: unknown) => void>()
	})

	it("ConnContext: message payloads are unknown, a close reason is a string", () => {
		const conn = {} as ConnContext
		conn.on("message", (payload) => {
			expectTypeOf(payload).toEqualTypeOf<unknown>()
		})
		conn.on("close", (reason) => {
			expectTypeOf(reason).toEqualTypeOf<string>()
		})
		expectTypeOf(conn.userId).toEqualTypeOf<string | null>()
		expectTypeOf(conn.transport).toEqualTypeOf<"ws">()
		// @ts-expect-error only message and close
		conn.on("open", () => {})
	})

	it("refuses options it does not ship and an identify that is not a user id", () => {
		const app = honey<{}>()
		expectTypeOf(realtime).toBeCallableWith(app, "/d", { handler: () => {}, limits: { slowConsumer: "drop" } })
		// @ts-expect-error resume does not ship: reconnectBuffer is not an option
		realtime(app, "/a", { handler: () => {}, reconnectBuffer: 10 })
		// @ts-expect-error identify answers a user id, null or undefined
		realtime(app, "/b", { handler: () => {}, identify: () => 1 })
		// @ts-expect-error slowConsumer is "close" or "drop"
		realtime(app, "/c", { handler: () => {}, limits: { slowConsumer: "wait" } })
	})
})

describe("ws(app, path).meta(): only the meta a WebSocket route reads (bit 19 g, carry-in #13)", () => {
	it("takes the builtins a WebSocket route reads and the route's own keys", () => {
		const app = honey()
		ws(app, "/live").meta({
			area: "chat",
			description: "the live feed",
			extensions: { "x-realtime": true },
			internal: false,
			operationId: "live.feed",
			summary: "live",
			tags: ["ws"],
		})
		expectTypeOf<{ area: string; operationId: string; summary: string }>().toExtend<WsMeta>()
	})

	it("refuses the four builtins the build drops from a WebSocket route", () => {
		const app = honey()
		// @ts-expect-error a WebSocket route is never marked deprecated
		ws(app, "/a").meta({ deprecated: true })
		// @ts-expect-error a WebSocket route declares no security requirement
		ws(app, "/b").meta({ security: ["bearer"] })
		// @ts-expect-error a WebSocket route invalidates no read
		ws(app, "/c").meta({ invalidate: [] })
		// @ts-expect-error a WebSocket route is no MCP tool
		ws(app, "/d").meta({ mcp: true })
		expectTypeOf<{ deprecated: true }>().not.toExtend<WsMeta>()
	})

	it("holds a WebSocket route to the app's meta type, as an HTTP route", () => {
		const app = honey().meta<{ team: string }>()
		ws(app, "/e").meta({ team: "core" })
		// @ts-expect-error the app's meta key keeps its type
		ws(app, "/f").meta({ team: 1 })
		expectTypeOf<{ team: number }>().not.toExtend<WsMeta<{ team: string }>>()
	})
})
