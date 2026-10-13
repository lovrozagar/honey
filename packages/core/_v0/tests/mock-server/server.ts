import { createHash } from "node:crypto"
import { honey } from "@lovrozagar/honey"
import { nodeWebSocket } from "../../src/ws/node.ts"

type User = {
	id: string
	name: string
	email: string
}

const HTTP_STATUS_TEXT: Record<number, string> = {
	400: "Bad Request",
	401: "Unauthorized",
	403: "Forbidden",
	404: "Not Found",
	405: "Method Not Allowed",
	408: "Request Timeout",
	409: "Conflict",
	410: "Gone",
	422: "Unprocessable Entity",
	429: "Too Many Requests",
	500: "Internal Server Error",
	501: "Not Implemented",
	502: "Bad Gateway",
	503: "Service Unavailable",
	504: "Gateway Timeout",
}

export function createMockServer() {
	const users = new Map<string, User>()
	let nextId = 1

	const wsAdapter = nodeWebSocket()
	const h = honey<Record<string, unknown>>().wsAdapter(wsAdapter)

	/* auth middleware — returns 401 on bad/missing token */
	const authMiddleware = h.use((ctx, next) => {
		const auth = ctx.req.headers.get("authorization")
		if (!auth || auth === "Bearer expired-token" || !auth.startsWith("Bearer ")) {
			return ctx.res.json("unauthorized", { message: "Unauthorized", status: 401 })
		}
		if (auth !== "Bearer valid-token") {
			return ctx.res.json("unauthorized", { message: "Unauthorized", status: 401 })
		}
		return next({})
	})

	/* GET /users */
	authMiddleware.get("/users").handler((ctx) => {
		const items = Array.from(users.values())
		return ctx.res.json("ok", { items, total: items.length })
	})

	/* POST /users */
	authMiddleware
		.post("/users")
		.meta({ mcp: true })
		.handler(async (ctx) => {
			const body = (await ctx.req.json()) as { email?: string; name?: string }
			if (!body.name || !body.email) {
				return ctx.res.json("unprocessable_entity", { message: "Missing name or email", status: 422 })
			}
			const id = `user-${nextId++}`
			const user: User = { email: body.email, id, name: body.name }
			users.set(id, user)
			const response = ctx.res.json("created", user)
			response.headers.set("x-invalidate", "GET /users")
			return response
		})

	/* GET /users/:id */
	authMiddleware.get("/users/:id").handler((ctx) => {
		const user = users.get(ctx.params.id)
		if (!user) {
			return ctx.res.json("not_found", { message: "Not found", status: 404 })
		}
		return ctx.res.json("ok", user)
	})

	/* PUT /users/:id */
	authMiddleware.put("/users/:id").handler(async (ctx) => {
		const user = users.get(ctx.params.id)
		if (!user) {
			return ctx.res.json("not_found", { message: "Not found", status: 404 })
		}
		const body = (await ctx.req.json()) as { email?: string; name?: string }
		if (body.name !== undefined) user.name = body.name
		if (body.email !== undefined) user.email = body.email
		users.set(ctx.params.id, user)
		const response = ctx.res.json("ok", user)
		response.headers.set("x-invalidate", "GET /users,GET /users/:id")
		return response
	})

	/* DELETE /users/:id */
	authMiddleware.delete("/users/:id").handler((ctx) => {
		if (!users.has(ctx.params.id)) {
			return ctx.res.json("not_found", { message: "Not found", status: 404 })
		}
		users.delete(ctx.params.id)
		const response = ctx.res.noContent()
		response.headers.set("x-invalidate", "GET /users,GET /users/:id")
		return response
	})

	/* POST /upload — read body, hash sha256, return { size, hash } */
	authMiddleware.post("/upload").handler(async (ctx) => {
		const buf = new Uint8Array(await ctx.req.arrayBuffer())
		const hash = createHash("sha256").update(buf).digest("hex")
		return ctx.res.json("ok", { hash, size: buf.byteLength })
	})

	/* POST /auth/refresh */
	h.post("/auth/refresh").handler(async (ctx) => {
		const body = (await ctx.req.json()) as { refresh_token?: string }
		if (body.refresh_token !== "refresh-valid") {
			return ctx.res.json("unauthorized", { message: "Unauthorized", status: 401 })
		}
		return ctx.res.json("ok", { access_token: "valid-token", expires_in: 3600 })
	})

	/* GET /stream — SSE */
	authMiddleware.get("/stream").handler((ctx) => {
		const lastEventIdHeader = ctx.req.headers.get("last-event-id") ?? ctx.req.headers.get("Last-Event-ID")
		let startIndex = 0
		if (lastEventIdHeader !== null) {
			const parsed = parseInt(lastEventIdHeader, 10)
			if (Number.isFinite(parsed)) startIndex = parsed + 1
		}

		return ctx.res.sse(async (stream) => {
			for (let i = startIndex; i <= 2; i++) {
				await stream.send({ data: `event-${i}`, event: "message", id: String(i) })
			}
			stream.close()
		})
	})

	/* GET /ws — WebSocket echo. Supports optional ?token= query for auth handshake
	 * tests: if token param present, it must equal "valid-token"; mismatch closes
	 * immediately with 4401 (app-level policy violation). Absent token = no auth
	 * (backwards-compat with pre-10.a.1 harness). Message "__close__" triggers
	 * server-initiated close (1000) for close-frame parity tests. */
	h.ws("/ws").handler({
		onMessage(_ctx, ws, data) {
			const str = typeof data === "string" ? data : ""
			/* accept both raw `__close__` and JSON-encoded `"__close__"` — Rust
			 * client JSON-encodes all serde_json::Value sends so the quoted form
			 * arrives over the wire. Everything else echoes verbatim. */
			if (str === "__close__" || str === '"__close__"') {
				ws.close(1000, "server-initiated")
				return
			}
			ws.send(data)
		},
		onOpen(ctx, ws) {
			const url = new URL(ctx.req.url)
			const token = url.searchParams.get("token")
			if (token !== null && token !== "valid-token") {
				ws.close(4401, "unauthorized")
			}
		},
	})

	/* GET /slow — sleeps `ms` then 200 (used by per-call timeout tests) */
	h.get("/slow").handler(async (ctx) => {
		const url = new URL(ctx.req.url)
		const ms = parseInt(url.searchParams.get("ms") ?? "0", 10)
		await new Promise((resolve) => setTimeout(resolve, Number.isFinite(ms) ? ms : 0))
		return new Response(JSON.stringify({ ok: true }), {
			headers: { "content-type": "application/json" },
			status: 200,
		})
	})

	/* GET /errors/:status */
	h.get("/errors/:status").handler((ctx) => {
		const statusCode = parseInt(ctx.params.status, 10)
		const message = HTTP_STATUS_TEXT[statusCode] ?? "Unknown"
		return new Response(JSON.stringify({ message, status: statusCode }), {
			headers: { "content-type": "application/json" },
			status: statusCode,
		})
	})

	/* POST /idempotent-create — echoes Idempotency-Key header (auto-UUID test) */
	h.post("/idempotent-create").handler((ctx) => {
		const key = ctx.req.headers.get("idempotency-key") ?? ""
		return ctx.res.json("ok", { idempotencyKey: key })
	})

	/* GET /declared-errors/:status — body conforms to declared Error schema */
	h.get("/declared-errors/:status").handler((ctx) => {
		const statusCode = parseInt(ctx.params.status, 10)
		const message = HTTP_STATUS_TEXT[statusCode] ?? "Unknown"
		return new Response(JSON.stringify({ message, status: statusCode }), {
			headers: { "content-type": "application/json" },
			status: statusCode,
		})
	})

	return h
}
