import type { WSAdapter } from "honey"
import { createMiddleware, defineErrors, honey } from "honey"
import { readableStream } from "honey/input"
import "honey/openapi"
import * as z from "zod"

type Env = { API_KEY: string; DATABASE_URL: string }

type Meta = {
	auth?: "public" | "required"
	rateLimit?: "default" | "strict"
}

const errors = defineErrors({
	conflict: "conflict",
	forbidden: "forbidden",
	gone: "gone",
	not_found: "not_found",
	rate_limited: "too_many_requests",
	unauthorized: "unauthorized",
	unprocessable: "unprocessable_entity",
	validation_error: "bad_request",
})

const withLogger = createMiddleware(async (_ctx, next) =>
	next({ logger: { info: (_msg: string) => {} } }),
)

const withAuth = createMiddleware(async (_ctx, next) =>
	next({ user: { id: "u-1", role: "admin" as "admin" | "member" } }),
)

/** Exhaustive consumer surface: every input source, output type, method, SSE, WS. */
export function createApp(wsAdapter?: WSAdapter) {
	const app = honey<Env>()
	if (wsAdapter) app.wsAdapter(wsAdapter)

	return app
		.errorFactory(errors)
		.defaultErrors("unauthorized", "validation_error")
		.defaultBoundary("validation_error")
		.meta<Meta>()
		.use(withLogger)
		.use(withAuth)

		.post("/in/json")
		.meta({ operationId: "input.createJson", tags: ["input"] })
		.input({ json: z.object({ email: z.string(), name: z.string() }) })
		.output({ "application/json": { created: z.object({ id: z.string() }) } })
		.handler((ctx) => ctx.res.json("created", { id: "1" }))

		.post("/in/form")
		.meta({ operationId: "input.createForm", tags: ["input"] })
		.input({ form: z.object({ password: z.string(), username: z.string() }) })
		.output({ "application/json": { ok: z.object({ token: z.string() }) } })
		.handler((ctx) => ctx.res.json("ok", { token: `t-${ctx.input.form.username}` }))

		.get("/in/search")
		.meta({ operationId: "input.search", tags: ["input"] })
		.input({
			search: z.object({
				limit: z.coerce.number(),
				page: z.coerce.number(),
				q: z.string().optional(),
			}),
		})
		.output({ "application/json": { ok: z.object({ results: z.string().array() }) } })
		.handler((ctx) => ctx.res.json("ok", { results: [] }))

		.get("/in/headers")
		.input({ headers: z.object({ "x-api-key": z.string(), "x-request-id": z.string() }) })
		.output({ "application/json": { ok: z.object({ accepted: z.boolean() }) } })
		.handler((ctx) => ctx.res.json("ok", { accepted: true }))

		.get("/in/cookies")
		.input({ cookies: z.object({ locale: z.string(), sid: z.string() }) })
		.output({ "application/json": { ok: z.object({ locale: z.string(), valid: z.boolean() }) } })
		.handler((ctx) =>
			ctx.res.json("ok", { locale: ctx.input.cookies.locale, valid: true }),
		)

		.get("/in/params/:orgId/members/:memberId")
		.input({ params: z.object({ memberId: z.string().min(1), orgId: z.string().min(1) }) })
		.output({ "application/json": { ok: z.object({ memberId: z.string(), orgId: z.string() }) } })
		.handler((ctx) =>
			ctx.res.json("ok", { memberId: ctx.input.params.memberId, orgId: ctx.input.params.orgId }),
		)

		.get("/in/none")
		.meta({ operationId: "input.none", tags: ["input"] })
		.output({ "application/json": { ok: z.object({ ping: z.literal("pong") }) } })
		.handler((ctx) => ctx.res.json("ok", { ping: "pong" as const }))

		.post("/in/file")
		.input({ form: z.object({ title: z.string(), upload: z.file() }) })
		.output({ "application/json": { ok: z.object({ name: z.string(), title: z.string() }) } })
		.handler((ctx) =>
			ctx.res.json("ok", { name: ctx.input.form.upload.name, title: ctx.input.form.title }),
		)

		.put("/in/all/:resourceId")
		.input({
			headers: z.object({ "if-match": z.string() }),
			json: z.object({ data: z.record(z.string(), z.unknown()) }),
			search: z.object({ force: z.coerce.boolean().optional(), version: z.coerce.number() }),
		})
		.output({ "application/json": { ok: z.object({ etag: z.string(), version: z.number() }) } })
		.handler((ctx) => ctx.res.json("ok", { etag: 'W/"abc"', version: ctx.input.search.version }))

		.get("/out/text")
		.output({ "text/plain": { ok: z.string() } })
		.handler((ctx) => ctx.res.text("ok", "hello world"))

		.get("/out/html")
		.output({ "text/html": { ok: z.string() } })
		.handler((ctx) => ctx.res.html("ok", "<h1>Hello</h1>"))

		.get("/out/csv")
		.output({ "text/csv": { ok: z.string() } })
		.handler((ctx) => ctx.res.csv("ok", "id,name\n1,Alice"))

		.get("/out/xml")
		.output({ "application/xml": { ok: z.string() } })
		.handler((ctx) => ctx.res.xml("ok", "<user><id>1</id></user>"))

		.get("/out/binary")
		.output({ "application/octet-stream": { ok: z.instanceof(Uint8Array) } })
		.handler((ctx) => ctx.res.binary("ok", new Uint8Array([0x48, 0x49])))

		.get("/out/sse")
		.output({ "text/event-stream": { ok: z.string() } })
		.handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({ data: "tick", event: "heartbeat", id: "1" })
				await stream.send({ data: JSON.stringify({ n: 42 }), event: "data", id: "2" })
				stream.close()
			}),
		)

		.post("/out/multi-status")
		.input({ json: z.object({ slug: z.string() }) })
		.output({
			"application/json": {
				conflict: z.object({ existing: z.string(), message: z.string() }),
				created: z.object({ id: z.string(), slug: z.string() }),
			},
		})
		.errors("conflict")
		.handler((ctx) => ctx.res.json("created", { id: "1", slug: ctx.input.json.slug }))

		.delete("/out/no-content/:id")
		.errors("not_found")
		.handler((ctx) => ctx.res.noContent())

		.get("/methods/resource")
		.meta({ operationId: "resources.list", tags: ["methods"] })
		.output({ "application/json": { ok: z.object({ items: z.string().array() }) } })
		.handler((ctx) => ctx.res.json("ok", { items: [] }))

		.post("/methods/resource")
		.meta({ operationId: "resources.create", tags: ["methods"] })
		.input({ json: z.object({ name: z.string() }) })
		.output({ "application/json": { created: z.object({ id: z.string() }) } })
		.handler((ctx) => ctx.res.json("created", { id: "1" }))

		.put("/methods/resource/:id")
		.meta({ operationId: "resources.update", tags: ["methods"] })
		.input({ json: z.object({ name: z.string() }), params: z.object({ id: z.string().min(1) }) })
		.output({ "application/json": { ok: z.object({ id: z.string(), name: z.string() }) } })
		.handler((ctx) => ctx.res.json("ok", { id: ctx.input.params.id, name: ctx.input.json.name }))

		.patch("/methods/resource/:id")
		.meta({ operationId: "resources.patch", tags: ["methods"] })
		.input({
			json: z.object({ name: z.string().optional() }),
			params: z.object({ id: z.string().min(1) }),
		})
		.output({ "application/json": { ok: z.object({ id: z.string() }) } })
		.handler((ctx) => ctx.res.json("ok", { id: ctx.input.params.id }))

		.delete("/methods/resource/:id")
		.meta({ operationId: "resources.delete", tags: ["methods"] })
		.handler((ctx) => ctx.res.noContent())

		.get("/status/ok")
		.output({ "application/json": { ok: z.object({ v: z.number() }) } })
		.handler((ctx) => ctx.res.json("ok", { v: 1 }))

		.post("/status/created")
		.input({ json: z.object({ x: z.string() }) })
		.output({ "application/json": { created: z.object({ id: z.string() }) } })
		.handler((ctx) => ctx.res.json("created", { id: "1" }))

		.post("/status/accepted")
		.input({ json: z.object({ task: z.string() }) })
		.output({ "application/json": { accepted: z.object({ jobId: z.string() }) } })
		.handler((ctx) => ctx.res.json("accepted", { jobId: "j-1" }))

		.delete("/status/no-content")
		.handler((ctx) => ctx.res.noContent())

		.get("/stream/filtered")
		.input({ search: z.object({ channel: z.string(), since: z.string().optional() }) })
		.output({ "text/event-stream": { ok: z.string() } })
		.handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({ data: ctx.input.search.channel, event: "subscribed" })
				stream.close()
			}),
		)

		.post("/rs/upload")
		.input({ json: readableStream(z.object({ chunks: z.number(), fileName: z.string() })) })
		.output({ "application/json": { accepted: z.object({ uploadId: z.string() }) } })
		.handler((ctx) => ctx.res.json("accepted", { uploadId: "up-1" }))

		.ws("/ws/echo")
		.meta({ operationId: "ws.echo", tags: ["websocket"] })
		.handler({
			onMessage(_ctx, ws, data) {
				ws.send(data)
			},
			onOpen(_ctx, ws) {
				ws.send("connected")
			},
		})

		.ws("/ws/room")
		.meta({ operationId: "ws.joinRoom", tags: ["websocket"] })
		.input({ search: z.object({ roomId: z.string() }) })
		.handler({
			onMessage(_ctx, ws, data) {
				ws.send(`room: ${data}`)
			},
			onOpen(_ctx, ws) {
				ws.send("joined")
			},
		})

		.ws("/ws/reconnect")
		.meta({ operationId: "ws.reconnect", tags: ["websocket"] })
		.handler({
			onOpen(_ctx, ws) {
				ws.send(JSON.stringify({ event: "open", token: "reconnect-token-abc" }))
			},
			onReconnect(_ctx, ws, token) {
				ws.send(JSON.stringify({ event: "resumed", token }))
			},
		})

		.ws("/ws/chat/:channelId")
		.meta({ operationId: "ws.chat", tags: ["websocket"] })
		.handler({
			onMessage(_ctx, ws, data) {
				ws.send(data)
			},
		})

		.openapi({ docs: "scalar", title: "Honey Surface", version: "1.0.0" })
		.manifest()
}
