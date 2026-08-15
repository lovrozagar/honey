import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import * as z from "zod"

const app = new Hono()

/* plain JSON */
app.get("/json", (c) => c.json({ message: "Hello, World!" }))

/* path params */
app.get("/params/:id", (c) => c.json({ id: c.req.param("id") }))

/* zod validation */
app.post("/validate", zValidator("json", z.object({ age: z.number(), name: z.string() })), (c) => {
	const body = c.req.valid("json")
	return c.json({ age: body.age, name: body.name })
})

/* middleware chain */
app.use("/middleware", async (c, next) => {
	const start = performance.now()
	c.set("startedAt", start)
	await next()
})
app.get("/middleware", (c) => {
	const start = c.get("startedAt") as number
	return c.json({ elapsed: performance.now() - start })
})

const port = Number(process.env.PORT ?? 3101)
Bun.serve({
	fetch: app.fetch,
	hostname: "0.0.0.0",
	port,
})
console.log(`hono on :${port}`)
