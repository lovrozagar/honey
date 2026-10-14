/**
 * WebSockets and realtime as typed: the app.ws(path) builder and the ctx its callbacks get, the
 * WSContext/WSHandler/WSAdapter shapes, wsAdapter(), and realtime()'s options, ConnContext and
 * publisher. WS `.input()` is typed at bit 08. Checked by typecheck.
 */
import { describe, expectTypeOf, it } from "vitest"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { realtime } from "../../src/realtime/realtime.ts"
import type { ConnContext } from "../../src/realtime/route.ts"
import type { RealtimePublisher } from "../../src/realtime/server.ts"
import { honey } from "../../src/routing/app.ts"
import type { WSAdapter, WSContext, WSHandler, WSReadyState } from "../../src/ws/contract.ts"
import { nodeWebSocket } from "../../src/ws/node.ts"

const withUser = createMiddleware((_ctx, next) => next({ user: "ada" as const }))

describe("app.ws(path): the ctx and the socket its callbacks get", () => {
	it("every callback gets the route's params, env and what middleware added, and a WSContext", () => {
		const app = honey<{ db: string }>()
		app
			.use(withUser)
			.ws("/rooms/:room")
			.handler({
				onClose: (ctx, ws, code, reason) => {
					expectTypeOf(ctx.params.room).toEqualTypeOf<string>()
					expectTypeOf([ws, code, reason]).toEqualTypeOf<(WSContext | number | string)[]>()
				},
				onError: (ctx, _ws, error) => {
					expectTypeOf(ctx.env.db).toEqualTypeOf<string>()
					expectTypeOf(error).toEqualTypeOf<unknown>()
				},
				onMessage: (ctx, _ws, data) => {
					expectTypeOf(ctx.user).toEqualTypeOf<"ada">()
					expectTypeOf(data).toEqualTypeOf<ArrayBuffer | string>()
				},
				onOpen: (_ctx, ws) => {
					expectTypeOf(ws).toEqualTypeOf<WSContext>()
				},
				onReconnect: (_ctx, _ws, token) => {
					expectTypeOf(token).toEqualTypeOf<string>()
				},
			})
	})

	it("a base path joins the params; a route-level use() adds to the ctx", () => {
		honey<{}>()
			.basePath("/org/:org")
			.ws("/feed/:id")
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
		expectTypeOf(app.ws("/a").handler({})).toEqualTypeOf(app)
		const built = app
			.ws("/b")
			.origins("*")
			.origins(["https://app.example.com"])
			.origins((origin) => origin.endsWith(".example.com"))
			.meta({ summary: "live" })
			.errors("forbidden")
		expectTypeOf(built.handler({})).toEqualTypeOf(app)
		// @ts-expect-error an origin policy is "*", a list or a predicate
		app.ws("/c").origins("https://app.example.com")
	})
})

describe("the socket, the handler and the adapter", () => {
	it("WSContext sends text, bytes or a JSON value, never a bare number", () => {
		const ws = {} as WSContext
		expectTypeOf(ws.readyState).toEqualTypeOf<WSReadyState>()
		expectTypeOf(ws.send).toBeCallableWith("text")
		expectTypeOf(ws.send).toBeCallableWith(new ArrayBuffer(1))
		expectTypeOf(ws.send).toBeCallableWith(new Uint8Array(1))
		expectTypeOf(ws.send).toBeCallableWith({ n: 1 })
		// @ts-expect-error a number is not a message
		ws.send(1)
		expectTypeOf(ws.close).toBeCallableWith(1000, "bye")
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
