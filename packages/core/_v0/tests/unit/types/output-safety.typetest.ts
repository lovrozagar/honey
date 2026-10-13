/**
 * Type-level tests for output safety.
 *
 * Declared content types → status keys + data shape constrained at compile time.
 * Undeclared content types → methods remain available (runtime validation catches misuse).
 * This tradeoff preserves ctx passthrough to services.
 */

import * as z from "zod"
import { honey } from "../../../src/index.ts"

void honey()
	/* JSON output: status key + data shape enforced */
	.post("/json-route")
	.output({ "application/json": { created: z.object({ id: z.string() }) } })
	.handler((ctx) => {
		ctx.res.json("created", { id: "abc" })

		/* @ts-expect-error — wrong status key */
		ctx.res.json("ok", { id: "abc" })

		/* @ts-expect-error — wrong data shape */
		ctx.res.json("created", { wrong: true })

		/* @ts-expect-error — text not declared in output */
		ctx.res.text("ok", "unavailable")
		ctx.res.noContent()
		ctx.res.redirect("/foo")

		return ctx.res.json("created", { id: "x" })
	})

	/* Text output: status key enforced */
	.post("/text-route")
	.output({ "text/plain": { ok: z.string() } })
	.handler((ctx) => {
		ctx.res.text("ok", "hello")

		/* @ts-expect-error — wrong status key for text */
		ctx.res.text("created", "nope")

		return ctx.res.text("ok", "done")
	})

	/* Mixed: both constrained */
	.post("/mixed-route")
	.output({
		"application/json": { ok: z.object({ count: z.number() }) },
		"text/plain": { accepted: z.string(), ok: z.string() },
	})
	.handler((ctx) => {
		ctx.res.json("ok", { count: 42 })
		ctx.res.text("ok", "hi")
		ctx.res.text("accepted", "queued")

		/* @ts-expect-error — wrong json key */
		ctx.res.json("created", { count: 1 })

		/* @ts-expect-error — wrong text key */
		ctx.res.text("created", "nope")

		return ctx.res.json("ok", { count: 0 })
	})

	/* No output: everything unconstrained */
	.get("/free-route")
	.handler((ctx) => {
		ctx.res.json("ok", { anything: true })
		ctx.res.json("created", {})
		ctx.res.text("created", "hi")
		ctx.res.html("ok", "<h1>hi</h1>")
		ctx.res.noContent()
		return ctx.res.json("ok", {})
	})
