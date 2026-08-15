import { defineErrors, honey } from "honey"
import "honey/openapi"
import * as z from "zod"

export const app = honey()
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

app.openapi({ docs: "scalar", title: "Honey CF", version: "0.0.1" })
app.manifest()
