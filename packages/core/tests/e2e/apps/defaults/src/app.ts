import type { WSAdapter } from "@lovrozagar/honey"
import type { RouteTree } from "@lovrozagar/honey/tree"
import { honey } from "@lovrozagar/honey"
import { serveManifest, serveOpenApi } from "@lovrozagar/honey/openapi"
import * as z from "zod"

/** `routeTree`: boot from a generated route tree (`src/_gen/routes.gen.ts`) instead of building the trie. */
export type AppOptions = { routeTree?: RouteTree }

/** No basePath, no CORS, no i18n, default trailingSlash ("ignore"). */
export function createApp(wsAdapter?: WSAdapter, options?: AppOptions) {
	const app = honey()
	if (options?.routeTree) app.routeTree(options.routeTree)
	if (wsAdapter) app.wsAdapter(wsAdapter)

	const routed = app
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
	return serveManifest(serveOpenApi(routed, { docs: "scalar", title: "Honey Defaults", version: "0.0.1" }))
}
