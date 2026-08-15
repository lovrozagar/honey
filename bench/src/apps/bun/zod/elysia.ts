import { Elysia } from "elysia"
import * as z from "zod"

const body = z.object({ age: z.number(), name: z.string() })

const app = new Elysia()
	.get("/json", () => ({ message: "Hello, World!" }))
	.get("/params/:id", ({ params }) => ({ id: params.id }))
	.post("/validate", ({ body: parsed }) => ({ age: parsed.age, name: parsed.name }), { body })
	.derive(() => ({ startedAt: performance.now() }))
	.get("/middleware", ({ startedAt }) => ({
		elapsed: performance.now() - startedAt,
	}))

const port = Number(process.env.PORT ?? 3102)
app.listen({ hostname: "0.0.0.0", port })
console.log(`elysia on :${port}`)
