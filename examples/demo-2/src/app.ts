import { createMiddleware, defineErrors, honey } from "@ecomet/honey"
import { readableStream } from "@ecomet/honey/input"
import * as z from "zod"

/**
 * demo-2: exhaustive app — every input source, output content-type,
 * HTTP method, status key, transport (REST/SSE/WS), and combo thereof
 */

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

export const app = honey<Env>()
	.errorFactory(errors)
	.defaultErrors("unauthorized", "validation_error")
	.defaultBoundary("validation_error")
	.meta<Meta>()
	.use(withLogger)
	.use(withAuth)

	/* ================================================================
	   INPUT: every source solo
	   ================================================================ */

	/* json body only */
	.post("/in/json")
	.meta({ operationId: "input.createJson", tags: ["input"] })
	.input({ json: z.object({ email: z.string(), name: z.string() }) })
	.output({ "application/json": { created: z.object({ id: z.string() }) } })
	.handler((ctx) => ctx.res.json("created", { id: "1" }))

	/* form body only */
	.post("/in/form")
	.meta({ operationId: "input.createForm", tags: ["input"] })
	.input({ form: z.object({ password: z.string(), username: z.string() }) })
	.output({ "application/json": { ok: z.object({ token: z.string() }) } })
	.handler((ctx) => ctx.res.json("ok", { token: `t-${ctx.input.form.username}` }))

	/* search only */
	.get("/in/search")
	.meta({ operationId: "input.search", tags: ["input"] })
	.input({ search: z.object({ limit: z.number(), page: z.number(), q: z.string().optional() }) })
	.output({ "application/json": { ok: z.object({ results: z.string().array() }) } })
	.handler((ctx) => ctx.res.json("ok", { results: [] }))

	/* headers only */
	.get("/in/headers")
	.input({ headers: z.object({ "x-api-key": z.string(), "x-request-id": z.string() }) })
	.output({ "application/json": { ok: z.object({ accepted: z.boolean() }) } })
	.handler((ctx) => ctx.res.json("ok", { accepted: true }))

	/* cookies only */
	.get("/in/cookies")
	.input({ cookies: z.object({ locale: z.string(), sid: z.string() }) })
	.output({ "application/json": { ok: z.object({ locale: z.string(), valid: z.boolean() }) } })
	.handler((ctx) => ctx.res.json("ok", { locale: ctx.input.cookies.locale, valid: true }))

	/* path params with validation */
	.get("/in/params/:orgId/members/:memberId")
	.input({ params: z.object({ memberId: z.string().min(1), orgId: z.string().min(1) }) })
	.output({ "application/json": { ok: z.object({ memberId: z.string(), orgId: z.string() }) } })
	.handler((ctx) =>
		ctx.res.json("ok", { memberId: ctx.input.params.memberId, orgId: ctx.input.params.orgId }),
	)

	/* no input at all */
	.get("/in/none")
	.meta({ operationId: "input.none", tags: ["input"] })
	.output({ "application/json": { ok: z.object({ ping: z.literal("pong") }) } })
	.handler((ctx) => ctx.res.json("ok", { ping: "pong" as const }))

	/* ================================================================
	   INPUT: combos
	   ================================================================ */

	/* json + search */
	.post("/in/json-search")
	.input({
		json: z.object({ name: z.string() }),
		search: z.object({ dryRun: z.boolean().optional() }),
	})
	.output({ "application/json": { created: z.object({ dryRun: z.boolean(), id: z.string() }) } })
	.handler((ctx) => ctx.res.json("created", { dryRun: false, id: "1" }))

	/* json + headers */
	.post("/in/json-headers")
	.input({
		headers: z.object({ "x-idempotency-key": z.string() }),
		json: z.object({ amount: z.number() }),
	})
	.output({ "application/json": { ok: z.object({ paymentId: z.string() }) } })
	.handler((ctx) => ctx.res.json("ok", { paymentId: "pay-1" }))

	/* json + cookies */
	.post("/in/json-cookies")
	.input({
		cookies: z.object({ csrf: z.string() }),
		json: z.object({ message: z.string() }),
	})
	.output({ "application/json": { created: z.object({ id: z.string() }) } })
	.handler((ctx) => ctx.res.json("created", { id: "msg-1" }))

	/* form + headers + cookies */
	.post("/in/form-headers-cookies")
	.input({
		cookies: z.object({ device: z.string() }),
		form: z.object({ code: z.string() }),
		headers: z.object({ "x-fingerprint": z.string() }),
	})
	.output({ "application/json": { ok: z.object({ verified: z.boolean() }) } })
	.handler((ctx) => ctx.res.json("ok", { verified: true }))

	/* search + cookies + headers */
	.get("/in/search-cookies-headers")
	.input({
		cookies: z.object({ timezone: z.string() }),
		headers: z.object({ "accept-language": z.string() }),
		search: z.object({ date: z.string() }),
	})
	.output({ "application/json": { ok: z.object({ events: z.string().array() }) } })
	.handler((ctx) => ctx.res.json("ok", { events: [] }))

	/* json + search + headers + params (the full monty) */
	.put("/in/all/:resourceId")
	.input({
		headers: z.object({ "if-match": z.string() }),
		json: z.object({ data: z.record(z.string(), z.unknown()) }),
		search: z.object({ force: z.boolean().optional(), version: z.number() }),
	})
	.output({ "application/json": { ok: z.object({ etag: z.string(), version: z.number() }) } })
	.handler((ctx) => ctx.res.json("ok", { etag: 'W/"abc"', version: 2 }))

	/* ================================================================
	   OUTPUT: every content-type solo
	   ================================================================ */

	/* application/json — already covered above */

	/* text/plain */
	.get("/out/text")
	.output({ "text/plain": { ok: z.string() } })
	.handler((ctx) => ctx.res.text("ok", "hello world"))

	/* text/html */
	.get("/out/html")
	.output({ "text/html": { ok: z.string() } })
	.handler((ctx) => ctx.res.html("ok", "<h1>Hello</h1>"))

	/* text/csv */
	.get("/out/csv")
	.output({ "text/csv": { ok: z.string() } })
	.handler((ctx) => ctx.res.csv("ok", "id,name\n1,Alice"))

	/* application/xml */
	.get("/out/xml")
	.output({ "application/xml": { ok: z.string() } })
	.handler((ctx) => ctx.res.xml("ok", "<user><id>1</id></user>"))

	/* application/octet-stream (binary) */
	.get("/out/binary")
	.output({ "application/octet-stream": { ok: z.instanceof(Uint8Array) } })
	.handler((ctx) => ctx.res.binary("ok", new Uint8Array([0x48, 0x49])))

	/* text/event-stream (SSE) */
	.get("/out/sse")
	.output({ "text/event-stream": { ok: z.string() } })
	.handler((ctx) =>
		ctx.res.sse(async (stream) => {
			await stream.send({ data: "tick", event: "heartbeat", id: "1" })
			await stream.send({ data: JSON.stringify({ n: 42 }), event: "data", id: "2" })
			stream.close()
		}),
	)

	/* ================================================================
	   OUTPUT: multi-status keys
	   ================================================================ */

	/* created | conflict */
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

	/* ok | accepted (async processing) */
	.post("/out/ok-or-accepted")
	.input({ json: z.object({ payload: z.string() }) })
	.output({
		"application/json": {
			accepted: z.object({ eta: z.number(), jobId: z.string() }),
			ok: z.object({ result: z.string() }),
		},
	})
	.handler((ctx) => ctx.res.json("accepted", { eta: 30, jobId: "j-1" }))

	/* ================================================================
	   OUTPUT: no output (204 / noContent)
	   ================================================================ */

	.delete("/out/no-content/:id")
	.errors("not_found")
	.handler((ctx) => ctx.res.noContent())

	/* ================================================================
	   METHODS: every HTTP method
	   ================================================================ */

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

	/* ================================================================
	   STATUS KEYS: variety
	   ================================================================ */

	/* ok (200) */
	.get("/status/ok")
	.output({ "application/json": { ok: z.object({ v: z.number() }) } })
	.handler((ctx) => ctx.res.json("ok", { v: 1 }))

	/* created (201) */
	.post("/status/created")
	.input({ json: z.object({ x: z.string() }) })
	.output({ "application/json": { created: z.object({ id: z.string() }) } })
	.handler((ctx) => ctx.res.json("created", { id: "1" }))

	/* accepted (202) */
	.post("/status/accepted")
	.input({ json: z.object({ task: z.string() }) })
	.output({ "application/json": { accepted: z.object({ jobId: z.string() }) } })
	.handler((ctx) => ctx.res.json("accepted", { jobId: "j-1" }))

	/* no_content (204) */
	.delete("/status/no-content")
	.handler((ctx) => ctx.res.noContent())

	/* ================================================================
	   SSE: streaming
	   ================================================================ */

	/* basic SSE */
	.get("/stream/events")
	.output({ "text/event-stream": { ok: z.string() } })
	.handler((ctx) =>
		ctx.res.sse(async (stream) => {
			await stream.send({ data: "connected", event: "open" })
			await stream.send({ data: JSON.stringify({ count: 1 }), event: "update", id: "u-1" })
			await stream.send({ data: JSON.stringify({ count: 2 }), event: "update", id: "u-2" })
			stream.close()
		}),
	)

	/* SSE with search input */
	.get("/stream/filtered")
	.input({ search: z.object({ channel: z.string(), since: z.string().optional() }) })
	.output({ "text/event-stream": { ok: z.string() } })
	.handler((ctx) =>
		ctx.res.sse(async (stream) => {
			await stream.send({ data: ctx.input.search.channel, event: "subscribed" })
			stream.close()
		}),
	)

	/* ================================================================
	   readableStream(): skip validation buffering, types still inferred
	   ================================================================ */

	/* readableStream json — handler gets raw stream, client sends same shape */
	.post("/rs/upload")
	.input({ json: readableStream(z.object({ chunks: z.number(), fileName: z.string() })) })
	.output({ "application/json": { accepted: z.object({ uploadId: z.string() }) } })
	.handler((ctx) => ctx.res.json("accepted", { uploadId: "up-1" }))

	/* readableStream form */
	.post("/rs/form-upload")
	.input({ form: readableStream(z.object({ file: z.string(), name: z.string() })) })
	.output({ "application/json": { ok: z.object({ size: z.number() }) } })
	.handler((ctx) => ctx.res.json("ok", { size: 1024 }))

	/* readableStream json + regular search + regular headers */
	.post("/rs/ingest")
	.input({
		headers: z.object({ "x-pipeline-id": z.string() }),
		json: readableStream(z.object({ records: z.number() })),
		search: z.object({ batch: z.boolean().optional() }),
	})
	.output({
		"application/json": { accepted: z.object({ eta: z.number(), pipelineId: z.string() }) },
	})
	.handler((ctx) =>
		ctx.res.json("accepted", { eta: 60, pipelineId: ctx.input.headers["x-pipeline-id"] }),
	)

	/* ================================================================
	   WS: WebSocket routes
	   ================================================================ */

	/* basic echo WS */
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

	/* WS with search input */
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

	/* WS with reconnection */
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

	/* WS with path params */
	.ws("/ws/chat/:channelId")
	.meta({ operationId: "ws.chat", tags: ["websocket"] })
	.handler({
		onMessage(_ctx, ws, data) {
			ws.send(data)
		},
	})
