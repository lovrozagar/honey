export type ConnContext = {
	readonly id: string
	readonly userId: string | null
	readonly transport: "ws" | "sse" | "longpoll"
	readonly state: Record<string, unknown>
	join(topic: string): void
	leave(topic: string): void
	send(payload: unknown): void
	publish(topic: string, payload: unknown): void
	close(reason?: string): void
	on(event: "message", handler: (payload: unknown) => void): void
	on(event: "close", handler: (reason: string) => void): void
	readonly _handlers: { message: ((payload: unknown) => void) | null; close: ((reason: string) => void) | null }
}

export type RealtimeRouteOpts = {
	use?: Array<(ctx: unknown, next: () => Promise<Response>) => Promise<Response>>
	reconnectBuffer?: number
	handler: (c: unknown, conn: ConnContext) => void | Promise<void>
}

export type RealtimeRouteHandler = {
	handler: RealtimeRouteOpts["handler"]
	middlewares: RealtimeRouteOpts["use"]
	reconnectBuffer: number
	path: string
}

export function createConnContext(opts: {
	id: string
	userId: string | null
	transport: "ws" | "sse" | "longpoll"
	bus: {
		subscribe(connId: string, topic: string): void
		unsubscribe(connId: string, topic: string): void
		unsubscribeAll(connId: string): void
		publish(topic: string, data: unknown): void
	}
	sendFn: (payload: unknown) => void
	closeFn: (reason?: string) => void
}): ConnContext {
	const state: Record<string, unknown> = {}
	const handlers: { message: ((payload: unknown) => void) | null; close: ((reason: string) => void) | null } = {
		close: null,
		message: null,
	}

	const conn: ConnContext = Object.create(null)

	Object.defineProperty(conn, "id", { enumerable: true, value: opts.id, writable: false })
	Object.defineProperty(conn, "userId", { enumerable: true, value: opts.userId, writable: false })
	Object.defineProperty(conn, "transport", { enumerable: true, value: opts.transport, writable: false })
	Object.defineProperty(conn, "state", { enumerable: true, get: () => state })
	Object.defineProperty(conn, "_handlers", { enumerable: false, get: () => handlers })

	Object.defineProperty(conn, "join", {
		enumerable: true,
		value(topic: string) {
			opts.bus.subscribe(opts.id, topic)
		},
	})

	Object.defineProperty(conn, "leave", {
		enumerable: true,
		value(topic: string) {
			opts.bus.unsubscribe(opts.id, topic)
		},
	})

	Object.defineProperty(conn, "send", {
		enumerable: true,
		value(payload: unknown) {
			opts.sendFn(payload)
		},
	})

	Object.defineProperty(conn, "publish", {
		enumerable: true,
		value(topic: string, payload: unknown) {
			opts.bus.publish(topic, payload)
		},
	})

	Object.defineProperty(conn, "close", {
		enumerable: true,
		value(reason?: string) {
			opts.bus.unsubscribeAll(opts.id)
			opts.closeFn(reason)
		},
	})

	Object.defineProperty(conn, "on", {
		enumerable: true,
		value(event: "message" | "close", handler: ((...args: unknown[]) => void)) {
			if (event === "message") {
				handlers.message = handler as (payload: unknown) => void
			} else {
				handlers.close = handler as (reason: string) => void
			}
		},
	})

	return conn
}
