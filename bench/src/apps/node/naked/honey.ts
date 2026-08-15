import { createMiddleware, honey } from "@lovrozagar/honey"
import "@lovrozagar/honey/serve"

const withTiming = createMiddleware(async (_ctx, next) => {
	const start = performance.now()
	const result = await next({ startedAt: start })
	return result
})

const app = honey()
	.get("/json")
	.handler((ctx) => ctx.res.json("ok", { message: "Hello, World!" }))

	.get("/params/:id")
	.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

	.use(withTiming)
	.get("/middleware")
	.handler((ctx) => ctx.res.json("ok", { elapsed: performance.now() - ctx.startedAt }))

const port = Number(process.env.PORT ?? 3100)
await app.serve({ hostname: "0.0.0.0", port, runtime: "node" })
console.log(`honey on :${port}`)
