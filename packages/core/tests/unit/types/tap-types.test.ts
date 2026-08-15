import { describe, expectTypeOf, it } from "vitest"
import * as z from "zod"
import { createMiddleware, defineErrors, honey } from "../../../src/index.ts"
import type { TapContext } from "../../../src/types.ts"

type AppTaps = {
	audit: { action: string; actor_id: string }
	webhook: { event: string }
}

/* ──────────────────────────────────────────────
 * c.tap() key + payload constraint
 * ────────────────────────────────────────────── */

describe("tap types: c.tap() key + payload constraint", () => {
	it("c.tap() key autocompletes to registered tap keys", () => {
		const app = honey<{}>().taps<AppTaps>()

		app.get("/test").handler((c) => {
			c.tap("audit", { action: "create", actor_id: "usr_1" })
			c.tap("webhook", { event: "created" })

			/* @ts-expect-error — invalid key */
			c.tap("nonexistent", {})

			return c.res.json("ok", {})
		})
	})

	it("c.tap() payload is typed per key", () => {
		const app = honey<{}>().taps<AppTaps>()

		app.get("/test").handler((c) => {
			/* @ts-expect-error — wrong payload shape for audit */
			c.tap("audit", { wrong: true })

			/* @ts-expect-error — missing required fields */
			c.tap("audit", { action: "create" })

			/* @ts-expect-error — wrong payload shape for webhook */
			c.tap("webhook", { action: "nope" })

			return c.res.json("ok", {})
		})
	})

	it("c.tap() payload extra keys rejected for exact shape", () => {
		const app = honey<{}>().taps<AppTaps>()

		app.get("/test").handler((c) => {
			/* valid */
			c.tap("audit", { action: "create", actor_id: "usr_1" })

			/* @ts-expect-error — extra key not in audit shape */
			c.tap("audit", { action: "create", actor_id: "usr_1", extra: true })

			return c.res.json("ok", {})
		})
	})

	it("without .taps(), c.tap() accepts any string key and unknown payload", () => {
		const app = honey<{}>()

		app.get("/test").handler((c) => {
			c.tap("anything", { any: "payload" })
			c.tap("other", 42)
			c.tap("more", null)
			return c.res.json("ok", {})
		})
	})

	it("c.tap() return type is void", () => {
		const app = honey<{}>().taps<AppTaps>()

		app.get("/test").handler((c) => {
			const result = c.tap("audit", { action: "x", actor_id: "y" })
			expectTypeOf(result).toBeVoid()
			return c.res.json("ok", {})
		})
	})
})

/* ──────────────────────────────────────────────
 * app.tap() handler typing
 * ────────────────────────────────────────────── */

describe("tap types: app.tap() handler", () => {
	it("handler payload is typed per key", () => {
		const app = honey<{}>().taps<AppTaps>()

		app.tap("audit", async (_ctx, payload) => {
			expectTypeOf(payload).toEqualTypeOf<{ action: string; actor_id: string }>()
		})

		app.tap("webhook", async (_ctx, payload) => {
			expectTypeOf(payload).toEqualTypeOf<{ event: string }>()
		})
	})

	it("handler ctx is TapContext<TEnv>", () => {
		type Env = { SECRET: string; DB_URL: string }
		const app = honey<Env>().taps<AppTaps>()

		app.tap("audit", async (ctx) => {
			expectTypeOf(ctx).toMatchTypeOf<TapContext<Env>>()
			expectTypeOf(ctx.env.SECRET).toEqualTypeOf<string>()
			expectTypeOf(ctx.env.DB_URL).toEqualTypeOf<string>()
			expectTypeOf(ctx.params).toEqualTypeOf<Record<string, string>>()
			expectTypeOf(ctx.headers).toEqualTypeOf<Record<string, string>>()
			expectTypeOf(ctx.meta).toEqualTypeOf<Record<string, unknown>>()
			expectTypeOf(ctx.path).toEqualTypeOf<string>()
			expectTypeOf(ctx.req).toEqualTypeOf<Request>()
			expectTypeOf(ctx.routePattern).toEqualTypeOf<string>()
			expectTypeOf(ctx.search).toEqualTypeOf<Record<string, string>>()
			expectTypeOf(ctx.background).toBeFunction()
		})
	})

	it("handler ctx does NOT have res or tap (no recursive emission)", () => {
		const app = honey<{}>().taps<AppTaps>()

		app.tap("audit", async (ctx) => {
			expectTypeOf(ctx).not.toHaveProperty("res")
			expectTypeOf(ctx).not.toHaveProperty("tap")
		})
	})

	it("handler return type accepts void and Promise<void>", () => {
		const app = honey<{}>().taps<AppTaps>()

		/* sync void */
		app.tap("audit", (_ctx, _payload) => {})

		/* async void */
		app.tap("webhook", async (_ctx, _payload) => {})
	})

	it(".tap() is chainable — returns this", () => {
		const app = honey<{}>().taps<AppTaps>()
		const result = app.tap("audit", async () => {})
		expectTypeOf(result).toEqualTypeOf(app)
	})
})

/* ──────────────────────────────────────────────
 * .taps<T>() meta extension
 * ────────────────────────────────────────────── */

describe("tap types: .taps() meta extension", () => {
	it("auto-extends meta with Partial<TTaps> — tap keys optional in .meta()", () => {
		const app = honey<{}>().taps<AppTaps>()

		/* valid — audit present */
		app
			.get("/a")
			.meta({ audit: { action: "create", actor_id: "usr_1" } })
			.handler((c) => c.res.json("ok", {}))

		/* valid — no tap keys in meta */
		app
			.get("/b")
			.handler((c) => c.res.json("ok", {}))

		/* valid — webhook only */
		app
			.get("/c")
			.meta({ webhook: { event: "created" } })
			.handler((c) => c.res.json("ok", {}))
	})

	it("meta tap keys are type-checked against TTaps payload shape", () => {
		const app = honey<{}>().taps<AppTaps>()

		app
			.get("/test")
			/* @ts-expect-error — wrong shape for audit in meta */
			.meta({ audit: { wrong: true } })
			.handler((c) => c.res.json("ok", {}))
	})

	it("combines with existing .meta<T>() declaration", () => {
		type RouteMeta = {
			operationId: string
			tags: string
		}

		const app = honey<{}>().meta<RouteMeta>().taps<AppTaps>()

		app
			.get("/test")
			.meta({
				operationId: "test.create",
				tags: "test",
				audit: { action: "create", actor_id: "usr_1" },
			})
			.handler((c) => {
				c.tap("audit", { action: "update", actor_id: "usr_2" })
				return c.res.json("ok", {})
			})
	})

	it("meta type includes both RouteMeta and Partial<TTaps>", () => {
		type RouteMeta = {
			operationId: string
			security: string
		}

		const app = honey<{}>().meta<RouteMeta>().taps<AppTaps>()

		app
			.get("/test")
			.meta({
				operationId: "test",
				security: "jwt",
				webhook: { event: "test" },
			})
			.handler((c) => {
				/* meta has both RouteMeta fields and tap keys */
				expectTypeOf(c.meta).toMatchTypeOf<
					Readonly<{
						operationId: string
						security: string
						webhook: { event: string }
					}>
				>()
				return c.res.json("ok", {})
			})
	})

	it(".taps() before .meta() also works", () => {
		type RouteMeta = { operationId: string }

		const app = honey<{}>().taps<AppTaps>().meta<RouteMeta>()

		app
			.get("/test")
			.meta({
				operationId: "test",
				audit: { action: "create", actor_id: "sys" },
			})
			.handler((c) => {
				c.tap("webhook", { event: "done" })
				return c.res.json("ok", {})
			})
	})
})

/* ──────────────────────────────────────────────
 * c.tap() coexists with all other handler ctx features
 * ────────────────────────────────────────────── */

describe("tap types: full handler context composition", () => {
	it("tap + middleware + input + output + params + errors", () => {
		const mw = createMiddleware(async (_ctx, next) => next({ userId: "u-1" }))
		const errs = defineErrors({ not_found: "not_found" })

		honey<{ SECRET: string }>()
			.taps<AppTaps>()
			.use(mw)
			.post("/orgs/:orgId/members")
			.input({ json: z.object({ email: z.string() }) })
			.output({ "application/json": { created: z.object({ id: z.string() }) } })
			.errors(errs, "not_found")
			.meta({ audit: { action: "member.invite", actor_id: "sys" } })
			.handler((c) => {
				/* env */
				expectTypeOf(c.env.SECRET).toEqualTypeOf<string>()

				/* middleware */
				expectTypeOf(c.userId).toEqualTypeOf<string>()

				/* params */
				expectTypeOf(c.params.orgId).toEqualTypeOf<string>()

				/* input */
				expectTypeOf(c.input.json.email).toEqualTypeOf<string>()

				/* errors */
				expectTypeOf(c.errors.not_found).toBeFunction()

				/* route pattern */
				expectTypeOf(c.routePattern).toEqualTypeOf<"/orgs/:orgId/members">()

				/* tap — typed */
				c.tap("audit", { action: "member.invite", actor_id: c.userId })
				c.tap("webhook", { event: "member.invited" })

				/* @ts-expect-error — invalid tap key */
				c.tap("invalid", {})

				/* @ts-expect-error — wrong payload for audit */
				c.tap("audit", { event: "wrong" })

				/* output — only json available */
				expectTypeOf(c.res).not.toHaveProperty("text")

				return c.res.json("created", { id: "mem_1" })
			})
	})

	it("tap survives basePath chain", () => {
		honey<{}>()
			.taps<AppTaps>()
			.basePath("/api/v1")
			.get("/test")
			.handler((c) => {
				c.tap("audit", { action: "test", actor_id: "sys" })
				expectTypeOf(c.routePattern).toEqualTypeOf<"/api/v1/test">()
				return c.res.json("ok", {})
			})
	})

	it("tap preserved through .use() chain", () => {
		const mw1 = createMiddleware(async (_ctx, next) => next({ a: 1 }))
		const mw2 = createMiddleware(async (_ctx, next) => next({ b: "two" }))
		const mw3 = createMiddleware(async (_ctx, next) => next({ c: true }))

		honey<{}>()
			.taps<AppTaps>()
			.use(mw1)
			.use(mw2)
			.use(mw3)
			.get("/test")
			.handler((c) => {
				expectTypeOf(c.a).toEqualTypeOf<number>()
				expectTypeOf(c.b).toEqualTypeOf<string>()
				expectTypeOf(c.c).toEqualTypeOf<boolean>()

				c.tap("audit", { action: "test", actor_id: "sys" })

				/* @ts-expect-error — still constrained after .use() chain */
				c.tap("bad", {})

				return c.res.json("ok", {})
			})
	})

	it("tap preserved through .errorFactory() chain", () => {
		const errs = defineErrors({
			a: "bad_request",
			b: "not_found",
		})

		honey<{}>()
			.taps<AppTaps>()
			.errorFactory(errs)
			.defaultErrors("a")
			.get("/test")
			.errors("b")
			.handler((c) => {
				c.tap("audit", { action: "test", actor_id: "sys" })

				/* @ts-expect-error — constrained after errorFactory chain */
				c.tap("bad", {})

				expectTypeOf(c.errors.a).toBeFunction()
				expectTypeOf(c.errors.b).toBeFunction()
				return c.res.json("ok", {})
			})
	})

	it("tap preserved through .context() chain", () => {
		honey<{}>()
			.taps<AppTaps>()
			.context({ db: { query: () => [] } })
			.get("/test")
			.handler((c) => {
				expectTypeOf(c.db.query).toBeFunction()
				c.tap("audit", { action: "test", actor_id: "sys" })

				/* @ts-expect-error — still constrained */
				c.tap("nope", {})

				return c.res.json("ok", {})
			})
	})
})

/* ──────────────────────────────────────────────
 * complex TTaps shapes
 * ────────────────────────────────────────────── */

describe("tap types: complex payload shapes", () => {
	it("nested object payloads", () => {
		type Taps = {
			audit: {
				action: string
				metadata: { ip: string; ua: string }
				resource: { id: string; type: string }
			}
		}

		const app = honey<{}>().taps<Taps>()

		app.get("/test").handler((c) => {
			c.tap("audit", {
				action: "create",
				metadata: { ip: "1.2.3.4", ua: "chrome" },
				resource: { id: "r-1", type: "org" },
			})
			return c.res.json("ok", {})
		})

		app.tap("audit", async (_ctx, payload) => {
			expectTypeOf(payload.metadata.ip).toEqualTypeOf<string>()
			expectTypeOf(payload.resource.type).toEqualTypeOf<string>()
		})
	})

	it("union type payloads", () => {
		type Taps = {
			event: { type: "created"; id: string } | { reason: string; type: "deleted" }
		}

		const app = honey<{}>().taps<Taps>()

		app.get("/test").handler((c) => {
			c.tap("event", { type: "created", id: "1" })
			c.tap("event", { type: "deleted", reason: "cleanup" })
			return c.res.json("ok", {})
		})
	})

	it("array payloads", () => {
		type Taps = {
			batch: { ids: string[]; operation: string }
		}

		const app = honey<{}>().taps<Taps>()

		app.tap("batch", async (_ctx, payload) => {
			expectTypeOf(payload.ids).toEqualTypeOf<string[]>()
			expectTypeOf(payload.operation).toEqualTypeOf<string>()
		})
	})

	it("single key TTaps", () => {
		type Taps = {
			log: { message: string }
		}

		const app = honey<{}>().taps<Taps>()

		app.get("/test").handler((c) => {
			c.tap("log", { message: "hello" })

			/* @ts-expect-error — only "log" is valid */
			c.tap("other", {})

			return c.res.json("ok", {})
		})
	})

	it("many keys TTaps", () => {
		type Taps = {
			a: { x: number }
			b: { y: string }
			c: { z: boolean }
			d: { w: null }
		}

		const app = honey<{}>().taps<Taps>()

		app.get("/test").handler((c) => {
			c.tap("a", { x: 1 })
			c.tap("b", { y: "two" })
			c.tap("c", { z: true })
			c.tap("d", { w: null })

			/* @ts-expect-error — e doesn't exist */
			c.tap("e", {})

			return c.res.json("ok", {})
		})
	})
})

/* ──────────────────────────────────────────────
 * .route() sub-app tap preservation
 * ────────────────────────────────────────────── */

describe("tap types: sub-app route merging", () => {
	it("parent taps available in parent routes after route() merge", () => {
		const child = honey<{}>()
		child.get("/child").handler((c) => c.res.json("ok", {}))

		const parent = honey<{}>().taps<AppTaps>()
		parent.route(child)

		parent.get("/parent").handler((c) => {
			c.tap("audit", { action: "test", actor_id: "sys" })

			/* @ts-expect-error — constrained */
			c.tap("bad", {})

			return c.res.json("ok", {})
		})
	})
})

/* ──────────────────────────────────────────────
 * InferTaps utility (if exported)
 * ────────────────────────────────────────────── */

describe("tap types: $taps phantom type", () => {
	it("$taps phantom carries the TTaps type", () => {
		const app = honey<{}>().taps<AppTaps>()
		type Taps = typeof app["$taps"]
		expectTypeOf<Taps>().toEqualTypeOf<AppTaps>()
	})

	it("$taps is empty object when no .taps() called", () => {
		const app = honey<{}>()
		type Taps = typeof app["$taps"]
		expectTypeOf<Taps>().toEqualTypeOf<{}>()
	})
})
