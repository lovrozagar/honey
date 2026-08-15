import { createMiddleware, honey } from "honey"
import * as z from "zod"

const withTiming = createMiddleware(async ({ next }) => {
	const start = performance.now()
	const result = await next({ startedAt: start })
	return result
})

const app = honey()
	/* plain JSON */
	.get("/json")
	.handler((ctx) => ctx.res.json("ok", { message: "Hello, World!" }))

	/* path params */
	.get("/params/:id")
	.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

	/* zod validation */
	.post("/validate")
	.input({ json: z.object({ age: z.number(), name: z.string() }) })
	.handler((ctx) => ctx.res.json("ok", { age: ctx.input.json.age, name: ctx.input.json.name }))

	/* middleware chain */
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
