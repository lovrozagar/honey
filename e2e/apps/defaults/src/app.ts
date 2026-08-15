import type { WSAdapter } from "@lovrozagar/honey"
import { honey } from "@lovrozagar/honey"
import "@lovrozagar/honey/openapi"
import * as z from "zod"

/** No basePath, no CORS, no i18n, default trailingSlash ("ignore"). */
export function createApp(wsAdapter?: WSAdapter) {
	const app = honey()
	if (wsAdapter) app.wsAdapter(wsAdapter)

	return app
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
		.openapi({ docs: "scalar", title: "Honey Defaults", version: "0.0.1" })
		.manifest()
}
