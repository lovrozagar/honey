import type { WSAdapter } from "@lovrozagar/honey"
import { honey } from "@lovrozagar/honey"
import "@lovrozagar/honey/openapi"

/**
 * Reverse-proxy style: public prefix /app is stripped, trailing slashes are required,
 * docs are Swagger (kitchen/defaults use Scalar).
 */
export function createApp(wsAdapter?: WSAdapter) {
	const app = honey().stripPrefix("/app").trailingSlash("enforce")
	if (wsAdapter) app.wsAdapter(wsAdapter)

	return app
		.get("/ping/")
		.handler((ctx) => ctx.res.text("ok", "pong"))
		.openapi({ docs: "swagger", title: "Honey Gateway", version: "0.0.1" })
		.manifest()
}
