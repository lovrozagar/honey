import { Elysia } from "elysia"

const app = new Elysia()
	.get("/json", () => ({ message: "Hello, World!" }))
	.get("/params/:id", ({ params }) => ({ id: params.id }))
	.derive(() => ({ startedAt: performance.now() }))
	.get("/middleware", ({ startedAt }) => ({
		elapsed: performance.now() - startedAt,
	}))

const port = Number(process.env.PORT ?? 3102)
app.listen({ hostname: "0.0.0.0", port })
console.log(`elysia on :${port}`)
