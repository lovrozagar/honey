import { node } from "@elysia/node"
import { Elysia } from "elysia"
import * as z from "zod"

const body = z.object({ age: z.number(), name: z.string() })

const app = new Elysia({ adapter: node() })

app.get("/json", () => ({ message: "Hello, World!" }))

app.get("/params/:id", ({ params }) => ({ id: params.id }))

app.post("/validate", ({ body: parsed }) => ({ age: parsed.age, name: parsed.name }), { body })

app.derive(() => ({ startedAt: performance.now() }))
app.get("/middleware", ({ startedAt }) => ({
	elapsed: performance.now() - startedAt,
}))

const port = Number(process.env.PORT ?? 3102)
app.listen({ hostname: "0.0.0.0", port })
console.log(`elysia on :${port}`)
