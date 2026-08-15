import { Hono } from "hono"

const app = new Hono<{ Variables: { startedAt: number } }>()

app.get("/json", (c) => c.json({ message: "Hello, World!" }))

app.get("/params/:id", (c) => c.json({ id: c.req.param("id") }))

app.use("/middleware", async (c, next) => {
	const start = performance.now()
	c.set("startedAt", start)
	await next()
})
app.get("/middleware", (c) => {
	const start = c.get("startedAt")
	return c.json({ elapsed: performance.now() - start })
})

const port = Number(process.env.PORT ?? 3101)
Bun.serve({
	fetch: app.fetch,
	hostname: "0.0.0.0",
	port,
})
console.log(`hono on :${port}`)
