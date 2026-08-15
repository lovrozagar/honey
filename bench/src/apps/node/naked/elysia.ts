import { node } from "@elysia/node"
import { Elysia } from "elysia"

const app = new Elysia({ adapter: node() })

app.get("/json", () => ({ message: "Hello, World!" }))

app.get("/params/:id", ({ params }) => ({ id: params.id }))

app.derive(() => ({ startedAt: performance.now() }))
app.get("/middleware", ({ startedAt }) => ({
	elapsed: performance.now() - startedAt,
}))

const port = Number(process.env.PORT ?? 3102)
app.listen({ hostname: "0.0.0.0", port })
console.log(`elysia on :${port}`)
