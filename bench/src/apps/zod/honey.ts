import { createMiddleware, honey } from "honey"
import * as z from "zod"

const body = z.object({ age: z.number(), name: z.string() })

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

	.post("/validate")
	.input({ json: body })
	.handler((ctx) => ctx.res.json("ok", { age: ctx.input.json.age, name: ctx.input.json.name }))

	.use(withTiming)
	.get("/middleware")
	.handler((ctx) => ctx.res.json("ok", { elapsed: performance.now() - ctx.startedAt }))

const port = Number(process.env.PORT ?? 3100)
Bun.serve({
	fetch: (req) => app.fetch(req, {}),
	hostname: "0.0.0.0",
	port,
})
console.log(`honey on :${port}`)
