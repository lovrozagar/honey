import { defineErrors, honey } from "@ecomet/honey"
import * as z from "zod"

const app = honey()
	.errorFactory(
		defineErrors({
			a: "bad_request",
		}),
	)
	.meta()

app
	.get("/product/:id")
	.input({
		form: z.file(),
		params: z.object({ id: z.string() }),
	})
	.output({ "application/json": { ok: z.object({ name: z.string() }) } })
	.handler((ctx) => {
		return ctx.res.json("ok", { name: "" })
	})
