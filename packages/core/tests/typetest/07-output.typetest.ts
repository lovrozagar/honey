import * as z from "zod"
import { createMiddleware, honey } from "../../src/index.ts"
import type { InferCtx } from "../../src/index.ts"
import type { Expect, Extends } from "./_assert.ts"

const withDb = createMiddleware(async (_ctx, next) =>
	next({ db: { query: (_sql: string) => [] as unknown[] } }),
)

/* ── declared JSON: status key + body shape enforced ── */

honey()
	.post("/json")
	.output({ "application/json": { created: z.object({ id: z.string() }) } })
	.handler((ctx) => {
		const ok = ctx.res.json("created", { id: "abc" })
		void ok

		// @ts-expect-error — wrong status key
		ctx.res.json("ok", { id: "abc" })
		// @ts-expect-error — wrong data shape
		ctx.res.json("created", { wrong: true })
		// @ts-expect-error — text not declared
		ctx.res.text("ok", "nope")
		// @ts-expect-error — html not declared
		ctx.res.html("ok", "<p>nope</p>")

		ctx.res.noContent()
		ctx.res.redirect("/x")
		return ctx.res.json("created", { id: "x" })
	})

/* ── declared text ── */

honey()
	.post("/text")
	.output({ "text/plain": { ok: z.string() } })
	.handler((ctx) => {
		ctx.res.text("ok", "hello")
		// @ts-expect-error — wrong text status
		ctx.res.text("created", "nope")
		// @ts-expect-error — json not declared
		ctx.res.json("ok", {})
		return ctx.res.text("ok", "done")
	})

/* ── mixed json + text ── */

honey()
	.post("/mixed")
	.output({
		"application/json": { ok: z.object({ count: z.number() }) },
		"text/plain": { accepted: z.string(), ok: z.string() },
	})
	.handler((ctx) => {
		ctx.res.json("ok", { count: 42 })
		ctx.res.text("ok", "hi")
		ctx.res.text("accepted", "queued")
		// @ts-expect-error — json has no created
		ctx.res.json("created", { count: 1 })
		// @ts-expect-error — text has no created
		ctx.res.text("created", "nope")
		return ctx.res.json("ok", { count: 0 })
	})

/* ── SSE ── */

honey()
	.get("/events")
	.output({ "text/event-stream": { ok: z.object({ data: z.string() }) } })
	.handler((ctx) => {
		type _Sse = Expect<Extends<typeof ctx.res.sse, Function>>
		// @ts-expect-error — json not declared on SSE route
		ctx.res.json("ok", {})
		return ctx.res.sse(async () => {})
	})

/* ── no output: all methods stay ── */

honey()
	.get("/free")
	.handler((ctx) => {
		ctx.res.json("ok", { anything: true })
		ctx.res.json("created", {})
		ctx.res.text("created", "hi")
		ctx.res.html("ok", "<h1>hi</h1>")
		ctx.res.noContent()
		return ctx.res.json("ok", {})
	})

/* ── handler ctx is assignable to InferCtx (services) ── */

const base = honey().use(withDb)
type AppCtx = InferCtx<typeof base>

function listOrgs(ctx: AppCtx) {
	return ctx.db.query("SELECT * FROM orgs")
}

base
	.get("/orgs")
	.output({ "application/json": { ok: z.object({ items: z.string().array() }) } })
	.handler((ctx) => {
		const items = listOrgs(ctx)
		return ctx.res.json("ok", { items: items as string[] })
	})
