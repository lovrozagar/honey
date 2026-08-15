import { honey } from "honey"
import "honey/openapi"
import * as z from "zod"

/** demo-1: minimal — no env, no middleware, no errors, no meta */
export const app = honey()
	.get("/health")
	.handler((ctx) => ctx.res.text("ok", "ok"))
	.get("/users/:id")
	.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))
	.post("/echo")
	.output({ "application/json": { created: z.string() } })
	.handler(async (ctx) => {
		const body = await ctx.req.text()
		return ctx.res.json("created", body)
	})
	.openapi({ docs: "scalar", title: "Demo 1", version: "0.0.1" })
	.manifest()
