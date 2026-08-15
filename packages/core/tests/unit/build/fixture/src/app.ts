import { honey } from "honey"

export const app = honey()
	.get("/health")
	.handler((ctx) => ctx.res.text("ok", "ok"))
	.openapi({ title: "Build Fixture", version: "1.0.0" })
