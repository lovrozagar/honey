import type { InferCtx, MiddlewareFn, WSAdapter } from "@ecomet/honey"
import { defineErrors, HoneyError, honey } from "@ecomet/honey"
import { generateManifest, generateOpenApi } from "@ecomet/honey/codegen"
import { cors } from "@ecomet/honey/cors"
import { createLogger, logger } from "@ecomet/honey/logger"
import { generateFromApp } from "@ecomet/honey/plugin"
import { requestId } from "@ecomet/honey/request-id"
import * as z from "zod"

/* ---- types ---- */
type Env = Record<string, unknown>

/* ---- errors ---- */
const errors = defineErrors({
	api_error: "internal_server_error",
	email_taken: "conflict",
	invalid_input: "bad_request",
	not_found: "not_found",
	org_limit_reached: "forbidden",
	org_slug_taken: "conflict",
	unauthorized: "unauthorized",
})

/* ---- i18n ---- */
const enErrors: Record<string, string> = {
	api_error: "An unexpected error occurred",
	org_slug_taken: "Organization slug {slug} is already taken",
	unauthorized: "Authentication required",
}
const deErrors: Record<string, string> = {
	api_error: "Ein unerwarteter Fehler ist aufgetreten",
	org_slug_taken: "Organisationsname {slug} ist bereits vergeben",
	unauthorized: "Authentifizierung erforderlich",
}

/* ---- mock in-memory DB ---- */
type Org = { id: string; name: string; slug: string }
const orgs: Org[] = [{ id: "org-1", name: "Acme Corp", slug: "acme" }]

/* ---- middleware ---- */
type DbCtx = { db: { orgs: Org[] } }
const withDb: MiddlewareFn<{}, DbCtx> = (_ctx, next) => {
	return next({ db: { orgs } })
}

type AuthCtx = { user: { id: string; locale: string; name: string } }
const withAuth: MiddlewareFn<DbCtx & { req: Request }, AuthCtx> = (ctx, next) => {
	const token = ctx.req.headers.get("authorization")?.replace("Bearer ", "")
	if (!token) throw errors.unauthorized()
	return next({ user: { id: "u1", locale: "en", name: "Test User" } })
}

/* ---- app factory ---- */
export function createApp(wsAdapter: WSAdapter) {
	const log = createLogger({ level: "debug" })

	const h = honey<Env>()
		.basePath("/api")
		.trailingSlash("strip")
		.wsAdapter(wsAdapter)
		.use(requestId())
		.use(logger({ instance: log }))
		.errorFactory(errors)
		.defaultBoundary("api_error")
		.onError((error, ctx) => {
			if (error instanceof HoneyError && error.errorKey === "db_constraint") {
				return ctx.jsonFromError(errors.org_slug_taken({ vars: { slug: "unknown" } }))
			}
			return undefined
		})
		.defaultErrorFormatter((_error, defaultShape) => ({
			...defaultShape,
			request_id: "e2e-req-001",
		}))
		.errorI18n({
			errors: { de: deErrors, en: enErrors },
			resolveLocale: (ctx) => {
				const accept = ctx.req.headers.get("accept-language")
				if (accept?.startsWith("de")) return "de"
				return "en"
			},
		})

	h.get("/")
		.input({ search: z.object({ id: z.string() }) })
		.output({ "application/json": { ok: z.object({ id: z.string() }) } })
		.errors(errors, "invalid_input")
		.meta({ description: "Test route", openApi: { summary: "Root test route", tags: ["test"] } })
		.handler((ctx) => {
			return ctx.res.json("ok", { id: ctx.input.search.id })
		})

	const corsed = h.use(cors({ credentials: true, origin: "*" }))
	const base = corsed.use(withDb)
	const authed = base.use(withAuth)

	/* ---- type-level assertions: InferCtx works on each branch ---- */
	type PublicCtx = InferCtx<typeof corsed>
	type DbCtx_ = InferCtx<typeof base>
	type AuthedCtx = InferCtx<typeof authed>

	/* compile-time proof: each branch carries its accumulated middleware context */
	const _typeChecks = {
		authedHasUser: null as unknown as AuthedCtx extends { user: { id: string } } ? true : never,
		dbHasOrgs: null as unknown as DbCtx_ extends { db: { orgs: Org[] } } ? true : never,
		publicHasReq: null as unknown as PublicCtx extends { req: Request } ? true : never,
	}
	void _typeChecks

	/* ---- routes ---- */

	/* health — no auth */
	corsed.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

	/* SSE endpoint — basic */
	corsed.get("/events").handler((ctx) =>
		ctx.res.sse(async (stream) => {
			await stream.send({ data: "hello", event: "message", id: "1" })
			await stream.send({ data: "world", event: "message", id: "2" })
			stream.close()
		}),
	)

	/* SSE endpoint — keepalive + retry + lastEventId */
	corsed.get("/events-live").handler((ctx) =>
		ctx.res.sse(
			async (stream) => {
				const resumeFrom = stream.lastEventId
				if (resumeFrom) {
					await stream.send({ data: `resumed from ${resumeFrom}`, event: "resume" })
				}
				await stream.send({ data: "live", event: "tick", id: "t1" })
				/* keep stream open briefly to let keepalive fire */
				await new Promise((r) => setTimeout(r, 250))
				stream.close()
			},
			{ defaultRetry: 3000, keepalive: 100 },
		),
	)

	/* catch-all for testing */
	corsed.all("/echo").handler((ctx) => ctx.res.json("ok", { method: ctx.req.method }))

	/* organizations CRUD */
	authed
		.get("/v1/organizations")
		.handler((ctx) => ctx.res.json("ok", { items: ctx.db.orgs, total: ctx.db.orgs.length }))

	authed
		.post("/v1/organizations")
		.errors(errors, "org_slug_taken", "org_limit_reached", "invalid_input")
		.handler(async (ctx) => {
			const body = (await ctx.req.json()) as { name?: string; slug?: string }
			if (!body.name || !body.slug) {
				throw errors.invalid_input({
					fields: {
						name: body.name
							? []
							: [{ error_key: "required", message: "Name is required", path: "name" }],
						slug: body.slug
							? []
							: [{ error_key: "required", message: "Slug is required", path: "slug" }],
					},
				})
			}
			const existing = ctx.db.orgs.find((o) => o.slug === body.slug)
			if (existing) throw errors.org_slug_taken({ vars: { slug: body.slug } })
			const org = { id: `org-${Date.now()}`, name: body.name, slug: body.slug }
			ctx.db.orgs.push(org)
			return ctx.res.json("created", org)
		})

	authed.get("/v1/organizations/:orgId").handler((ctx) => {
		const org = ctx.db.orgs.find((o) => o.id === ctx.params.orgId)
		if (!org) throw errors.not_found()
		return ctx.res.json("ok", org)
	})

	authed.delete("/v1/organizations/:orgId").handler((ctx) => {
		const idx = ctx.db.orgs.findIndex((o) => o.id === ctx.params.orgId)
		if (idx === -1) throw errors.not_found()
		ctx.db.orgs.splice(idx, 1)
		return ctx.res.noContent()
	})

	/* ---- WebSocket routes ---- */

	/* unauthenticated echo — sends back whatever it receives */
	corsed.ws("/echo-ws").handler({
		onMessage(_ctx, ws, data) {
			ws.send(data)
		},
		onOpen(_ctx, ws) {
			ws.send("connected")
		},
	})

	/* authenticated socket */
	authed.ws("/v1/socket").handler({
		onMessage(ctx, ws, data) {
			ws.send({ from: ctx.user.name, msg: data })
		},
		onOpen(ctx, ws) {
			ws.send({ event: "welcome", user: ctx.user.id })
		},
	})

	/* WS with reconnection protocol */
	corsed.ws("/reconnect-ws").handler({
		onOpen(_ctx, ws) {
			ws.send(JSON.stringify({ event: "open", token: "fresh-token-123" }))
		},
		onReconnect(_ctx, ws, token) {
			ws.send(JSON.stringify({ event: "reconnected", token }))
		},
	})

	/* ---- realtime routes ---- */

	corsed.realtime("/realtime/echo", {
		handler: (_c, conn) => {
			conn.send({ event: "connected", id: conn.id })
			conn.on("message", (payload) => {
				conn.send({ echo: payload })
			})
			conn.on("close", () => {
				/* cleanup */
			})
		},
	})

	corsed.realtime("/realtime/chat/:roomId", {
		handler: (_c, conn) => {
			conn.join("room:default")
			conn.send({ event: "joined", roomId: "default" })
			conn.on("message", (payload) => {
				conn.publish("room:default", payload)
			})
		},
	})

	/* REST endpoint that publishes to realtime subscribers */
	corsed.post("/realtime/broadcast/:topic").handler(async (ctx) => {
		const body = await ctx.req.json()
		ctx.realtime.publish(ctx.params.topic, body)
		return ctx.res.json("ok", { published: true })
	})

	/* ---- boundary test routes ---- */

	/* default boundary: unexpected throw → api_error (from defaultBoundary) */
	corsed.get("/boundary/default").handler(() => {
		throw new Error("unexpected db crash")
	})

	/* per-route boundary overrides default */
	corsed
		.get("/boundary/custom")
		.boundary("org_limit_reached")
		.handler(() => {
			throw new Error("something broke")
		})

	/* ---- codegen endpoints ---- */

	corsed.get("/openapi.json").handler((ctx) => {
		const spec = generateOpenApi(h, {
			info: { description: "Honey E2E Test API", title: "Honey E2E", version: "1.0.0" },
		})
		return ctx.res.json("ok", spec)
	})

	corsed.get("/manifest.json").handler((ctx) => {
		const manifest = generateManifest(h)
		return ctx.res.json("ok", manifest)
	})

	corsed.get("/generated-tree").handler(async (ctx) => {
		const artifacts = await generateFromApp(h)
		return ctx.res.text("ok", artifacts.routeTree)
	})

	return h
}
