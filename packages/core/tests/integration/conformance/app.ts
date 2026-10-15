/**
 * The conformance reference app (bit 11): the live target every generated client is measured
 * against. gen's harness spawns this file on bun; it serves one app on two loopback listeners (the
 * alt one is another origin) and prints `{"url","alt"}` once both listen. Everything crosses HTTP:
 * the routes, the document at `/v1/openapi.json`, and the wire log at `/v1/__conformance/*`.
 *
 * Every public route names an `operationId`, the key the matrix joins targets on. A root
 * middleware records each non-internal request in arrival order; `mark` and `wire?since=` read it.
 */
import { createHash } from "node:crypto"
import * as z from "zod"
import { serve, type ServeHandle } from "../../../src/adapters/serve.ts"
import { defineErrors } from "../../../src/errors/errors.ts"
import { errorI18n } from "../../../src/i18n/error-i18n.ts"
import type { NextFn } from "../../../src/middleware/middleware.ts"
import { requestId } from "../../../src/middleware/request-id.ts"
import { serveOpenApi } from "../../../src/openapi/serve.ts"
import { honey } from "../../../src/routing/app.ts"
import { createReferenceServer } from "./reference-server.ts"
import { secureRoutes } from "./app-secure.ts"

/** The app's two origins, known once both listeners are up. */
export type Origins = { readonly alt: string; readonly url: string }

/** One request the app received, as `GET /v1/__conformance/wire` answers it. */
export type WireHop = {
	readonly body: {
		readonly contentType: string | null
		readonly json?: unknown
		readonly sha256: string
		readonly size: number
	}
	readonly headers: Readonly<Record<string, string>>
	readonly method: string
	readonly origin: "alt" | "primary"
	readonly url: string
}

export const errors = defineErrors({
	api_error: "internal_server_error",
	bad_request: "bad_request",
	email_taken: "conflict",
	invalid_input: "bad_request",
	item_exists: "conflict",
	item_not_found: "not_found",
	limit_reached: "forbidden",
	not_found: "not_found",
	unauthorized: "unauthorized",
})

const en: Record<string, string> = {
	api_error: "An unexpected error occurred",
	bad_request: "Bad request",
	email_taken: "Email is already taken",
	invalid_input: "Invalid input",
	item_exists: "Item already exists",
	item_not_found: "Item not found",
	limit_reached: "Limit reached",
	not_found: "Not found",
	unauthorized: "Authentication required",
}

const de: Record<string, string> = {
	api_error: "Ein unerwarteter Fehler ist aufgetreten",
	bad_request: "Ungültige Anfrage",
	email_taken: "E-Mail ist bereits vergeben",
	invalid_input: "Ungültige Eingabe",
	item_exists: "Eintrag existiert bereits",
	item_not_found: "Eintrag nicht gefunden",
	limit_reached: "Limit erreicht",
	not_found: "Nicht gefunden",
	unauthorized: "Nicht autorisiert",
}

const Item = z.object({ id: z.string(), name: z.string() })
const Patched = z.object({ id: z.string(), n: z.number().int().optional(), name: z.string() })
/** A query boolean: `true` or `false` as text, documented as a boolean. */
const QueryBool = z.preprocess((value) => (value === "true" ? true : value === "false" ? false : value), z.boolean())
const Digest = z.object({ contentType: z.string(), sha256: z.string(), size: z.number().int() })
const CATALOG = [
	{ id: "a1", name: "apple" },
	{ id: "b2", name: "banana" },
	{ id: "c3", name: "cherry" },
] as const

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const item = (id: string) => ({ id, name: `item ${id}` })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The media type essence of a content-type header: lower case, parameters dropped. */
function essence(contentType: string | null): string | null {
	return contentType === null ? null : (contentType.split(";")[0] as string).trim().toLowerCase()
}

/** A request body as the wire log keeps it: size, digest, media type, and the JSON when it is JSON. */
async function bodyOf(request: Request): Promise<WireHop["body"]> {
	const bytes = new Uint8Array(await request.arrayBuffer().catch(() => new ArrayBuffer(0)))
	const contentType = essence(request.headers.get("content-type"))
	const body = { contentType, sha256: sha256(bytes), size: bytes.byteLength }
	if (contentType === null || !/^application\/(.+\+)?json$/.test(contentType)) return body
	try {
		return { ...body, json: JSON.parse(new TextDecoder().decode(bytes)) as unknown }
	} catch {
		return body
	}
}

type Captured = { readonly meta: Readonly<Record<string, unknown>>; readonly req: Request }

/** The wire log: a capturing middleware, the cursor, and the hops after a cursor in arrival order. */
function createWire(originOf: (request: Request) => WireHop["origin"]) {
	const hops: { hop: WireHop; seq: number }[] = []
	let seq = 0
	/* the copy is read before the handler answers: bun 1.3 never delivers a body still unread when the
	   response goes out (a 401 before the handler), and the hop is logged even if the client gives up */
	const capture = async (ctx: Captured, next: NextFn) => {
		if (ctx.meta.internal === true) return next()
		const at = ++seq
		const { headers, method, url } = ctx.req
		const target = new URL(url)
		const body = await bodyOf(ctx.req.clone())
		const hop = {
			body,
			headers: Object.fromEntries(headers),
			method,
			origin: originOf(ctx.req),
			url: target.pathname + target.search,
		}
		hops.push({ hop, seq: at })
		return next()
	}
	const since = (cursor: number): WireHop[] =>
		hops
			.filter((entry) => entry.seq > cursor)
			.sort((a, b) => a.seq - b.seq)
			.map((entry) => entry.hop)
	return { capture, mark: () => seq, since }
}

/** The app with its settings, the wire capture and request ids: what every route group hangs off. */
function configured(wire: ReturnType<typeof createWire>) {
	return honey<{}>()
		.encodedSlashes("allow")
		.errorFactory(errors)
		.defaultBoundary("api_error")
		.defaultErrorFormatter((_error, shape) => ({ ...shape, request_id: "conformance" }))
		.errorI18n(
			errorI18n({
				errors: { de, en },
				resolveLocale: (ctx) => (ctx.req.headers.get("accept-language")?.startsWith("de") ? "de" : "en"),
			}),
		)
		.basePath("/v1")
		.use(wire.capture)
}

/** The handle the route groups register on: request ids on top of the capture. */
function withRequestIds(base: ReturnType<typeof configured>) {
	return base.use(requestId({ trustInbound: true }))
}

export type ConformanceApp = ReturnType<typeof withRequestIds>

/** `items.*`: the verbs, JSON statuses, typed errors and response headers. */
function itemRoutes(app: ConformanceApp): void {
	app
		.get("/items")
		.meta({ operationId: "items.list" })
		.input({ search: z.object({ limit: z.coerce.number().int().optional(), q: z.string().optional() }) })
		.output({ "application/json": { ok: z.array(Item) } })
		.handler((ctx) => {
			const { limit, q } = ctx.input.search
			const found = CATALOG.filter((entry) => q === undefined || entry.name.includes(q))
			return ctx.res.json("ok", found.slice(0, limit ?? found.length))
		})
	app
		.get("/items/:id")
		.meta({ operationId: "items.get" })
		.errors("item_not_found")
		.output({ "application/json": { ok: Item }, headers: { ok: z.object({ "x-item-version": z.string() }) } })
		.handler((ctx) => {
			if (ctx.params.id === "missing") throw errors.item_not_found()
			return ctx.res.json("ok", item(ctx.params.id), { headers: { "x-internal": "1", "x-item-version": "3" } })
		})
	app
		.post("/items")
		.meta({ operationId: "items.create" })
		.errors("item_exists")
		.input({ json: z.object({ n: z.number().int().optional(), name: z.string().min(3) }) })
		.output({ "application/json": { created: Item } })
		.handler((ctx) => {
			if (ctx.input.json.name === "taken") throw errors.item_exists()
			return ctx.res.json("created", { id: "item-new", name: ctx.input.json.name })
		})
	app
		.put("/items/:id")
		.meta({ operationId: "items.update" })
		.input({
			headers: z.object({ "x-trace": z.string().optional() }),
			json: z.object({ n: z.number().int(), name: z.string() }),
			search: z.object({
				flag: QueryBool.optional(),
				limit: z.coerce.number().int().optional(),
				q: z.string().optional(),
				ratio: z.coerce.number().optional(),
				tags: z.array(z.string()).optional(),
			}),
		})
		.output({ "application/json": { ok: z.object({ id: z.string(), n: z.number().int(), name: z.string() }) } })
		.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id, n: ctx.input.json.n, name: ctx.input.json.name }))
	app
		.patch("/items/:id")
		.meta({ operationId: "items.patch" })
		.input({ json: z.object({ n: z.number().int().optional(), name: z.string().optional() }) })
		.output({ "application/json": { ok: Patched } })
		.handler((ctx) => ctx.res.json("ok", { ...item(ctx.params.id), ...ctx.input.json }))
	app
		.delete("/items/:id")
		.meta({ operationId: "items.delete" })
		.output({ headers: { no_content: z.object({}) } })
		.handler((ctx) => ctx.res.noContent())
}

/** `files.*` and `ticks.stream`: bytes both ways and a typed event stream. */
function streamRoutes(app: ConformanceApp): void {
	app
		.get("/files/:name")
		.meta({ operationId: "files.get" })
		.output({ "application/octet-stream": { ok: true } })
		.handler((ctx) =>
			ctx.res.binary(
				"ok",
				Uint8Array.from({ length: 256 }, (_, i) => i & 0xff),
			),
		)
	app
		.put("/files/:name")
		.meta({ operationId: "files.put" })
		.input({ binary: ["application/octet-stream"] })
		.output({ "application/json": { ok: Digest } })
		.handler((ctx) => {
			const { bytes, type } = ctx.input.binary
			return ctx.res.json("ok", { contentType: type, sha256: sha256(bytes), size: bytes.byteLength })
		})
	app
		.get("/ticks")
		.meta({ operationId: "ticks.stream" })
		.output({ "text/event-stream": { ok: z.object({ n: z.number().int() }) } })
		.handler((ctx) =>
			ctx.res.sse(async (stream) => {
				for (let n = 1; n <= 3; n++) await stream.send({ data: { n }, event: "tick", id: String(n) })
				stream.close()
			}),
		)
}

/** `timing.slow`, `echo.get` and `redirect.crossOrigin`: per-call overrides, request ids and auth hops. */
function hopRoutes(app: ConformanceApp, origins: () => Origins | null): void {
	app
		.get("/slow")
		.meta({ operationId: "timing.slow" })
		.input({ search: z.object({ ms: z.coerce.number().int().min(0).max(10_000) }) })
		.output({ "application/json": { ok: z.object({ ok: z.boolean() }) } })
		.handler(async (ctx) => {
			await sleep(ctx.input.search.ms)
			return ctx.res.json("ok", { ok: true })
		})
	app
		.get("/echo")
		.meta({ operationId: "echo.get" })
		.output({
			"application/json": { ok: z.object({ method: z.string(), requestId: z.string() }) },
			headers: { ok: z.object({ "x-request-id": z.string() }) },
		})
		.handler((ctx) =>
			ctx.res.json(
				"ok",
				{ method: ctx.req.method, requestId: ctx.requestId },
				{ headers: { "x-request-id": ctx.requestId } },
			),
		)
	app
		.get("/redirect/cross-origin")
		.meta({ operationId: "redirect.crossOrigin" })
		.output({ redirect: { temporary_redirect: true } })
		.handler((ctx) => ctx.res.redirect(`${origins()?.alt ?? ""}/v1/echo`, { status: 307 }))
}

/** The routes the TS harness cases call beside the matrix: raw statuses, boundaries, health, WS echo. */
function harnessRoutes(app: ConformanceApp): void {
	app
		.get("/errors/:status")
		.meta({ operationId: "errors.status" })
		.input({ params: z.object({ status: z.coerce.number().int().min(200).max(599) }) })
		.handler((ctx) => {
			const { status } = ctx.input.params
			return ctx.res.raw(Response.json({ message: `status ${status}`, status }, { status }))
		})
	app
		.get("/declared-errors/:status")
		.meta({ operationId: "errors.declared" })
		.errors("bad_request", "not_found")
		.output({ "application/json": { ok: z.object({ ok: z.boolean() }) } })
		.handler((ctx) => {
			if (ctx.params.status === "400") throw errors.bad_request()
			if (ctx.params.status === "404") throw errors.not_found()
			return ctx.res.json("ok", { ok: true })
		})
	app
		.post("/idempotent")
		.meta({ extensions: { "x-idempotency-key": true }, operationId: "idempotent.create" })
		.output({ "application/json": { ok: z.object({ idempotencyKey: z.string().nullable() }) } })
		.handler((ctx) => ctx.res.json("ok", { idempotencyKey: ctx.req.headers.get("idempotency-key") }))
	app
		.get("/health")
		.meta({ operationId: "health" })
		.output({ "text/plain": { ok: z.string() } })
		.handler((ctx) => ctx.res.text("ok", "ok"))
	app
		.get("/ping")
		.meta({ operationId: "ping" })
		.output({ "application/json": { ok: z.object({ ping: z.literal("pong") }) } })
		.handler((ctx) => ctx.res.json("ok", { ping: "pong" as const }))
	app
		.get("/boundary/default")
		.meta({ operationId: "boundary.default" })
		.handler(() => {
			throw new Error("unexpected crash")
		})
	app
		.get("/boundary/custom")
		.meta({ operationId: "boundary.custom" })
		.boundary("limit_reached")
		.handler(() => {
			throw new Error("something broke")
		})
	app
		.post("/validated")
		.meta({ operationId: "validated.create" })
		.input({ json: z.object({ name: z.string().min(3) }) })
		.output({ "application/json": { ok: z.object({ name: z.string() }) } })
		.handler((ctx) => ctx.res.json("ok", { name: ctx.input.json.name }))
}

/** `ws.echo`: echoes each frame; `__close__` closes 1000, a `token` other than `valid-token` closes 4401. */
function socketRoutes(app: ConformanceApp): void {
	app
		.ws("/ws/echo")
		.meta({ operationId: "ws.echo" })
		.input({ search: z.object({ token: z.string().optional() }) })
		.handler({
			onMessage: (_ctx, ws, data) => (data === "__close__" ? ws.close(1000, "server-initiated") : ws.send(data)),
			onOpen: (ctx, ws) => {
				const { token } = ctx.input.search
				if (token !== undefined && token !== "valid-token") ws.close(4401, "unauthorized")
			},
		})
}

/** The conformance app; `origins` names its two listeners once they are up (none in process). */
export function createConformanceApp(origins: () => Origins | null = () => null) {
	const originOf = (request: Request): WireHop["origin"] => {
		const alt = origins()?.alt
		return alt !== undefined && new URL(request.url).host === new URL(alt).host ? "alt" : "primary"
	}
	const wire = createWire(originOf)
	const captured = configured(wire)
	const ref = createReferenceServer()
	for (let n = 1; n <= 5; n++) ref.append({ n })
	/* the reference server's ctx has no request id: it mounts under the capture alone */
	captured.route("/resume", ref.app)
	const app = withRequestIds(captured)
	itemRoutes(app)
	streamRoutes(app)
	hopRoutes(app, origins)
	harnessRoutes(app)
	socketRoutes(app)
	secureRoutes(app, errors)
	app
		.post("/__conformance/mark")
		.meta({ internal: true })
		.handler((ctx) => ctx.res.json("ok", { since: wire.mark() }))
	app
		.get("/__conformance/wire")
		.meta({ internal: true })
		.handler(async (ctx) => ctx.res.json("ok", wire.since(Number(new URL(ctx.req.url).searchParams.get("since") ?? 0))))
	return serveOpenApi(app, { title: "Conformance", version: "1.0.0" })
}

/** Serve on two loopback listeners, print the readiness line, and stop on a signal or a closed stdin. */
async function main(): Promise<void> {
	let origins: Origins | null = null
	const app = createConformanceApp(() => origins)
	const listeners: ServeHandle[] = await Promise.all([0, 1].map(() => serve(app, { hostname: "127.0.0.1", port: 0 })))
	const [primary, alt] = listeners as [ServeHandle, ServeHandle]
	origins = { alt: alt.url, url: primary.url }
	process.stdout.write(`${JSON.stringify({ url: primary.url, alt: alt.url })}\n`)
	let stopping = false
	const stop = () => {
		if (stopping) return
		stopping = true
		void Promise.all(listeners.map((listener) => listener.close(100))).finally(() => process.exit(0))
	}
	process.once("SIGTERM", stop)
	process.once("SIGINT", stop)
	process.stdin.once("end", stop)
	process.stdin.resume()
}

if (import.meta.main) void main()
