import { Elysia } from "elysia"
import * as z from "zod"

/**
 * Elysia natively uses TypeBox, not zod.
 * For fair comparison we use zod with manual parsing,
 * same as honey and hono do under the hood.
 */
const validateSchema = z.object({ age: z.number(), name: z.string() })

const app = new Elysia()

/* plain JSON */
app.get("/json", () => ({ message: "Hello, World!" }))

/* path params */
app.get("/params/:id", ({ params }) => ({ id: params.id }))

/* zod validation — manual parse to match honey/hono behavior */
app.post("/validate", async ({ request }) => {
	const raw = await request.json()
	const parsed = validateSchema.parse(raw)
	return { age: parsed.age, name: parsed.name }
})

/* middleware chain */
app.derive(() => ({ startedAt: performance.now() }))
app.get("/middleware", ({ startedAt }) => ({
	elapsed: performance.now() - startedAt,
}))

const port = Number(process.env.PORT ?? 3102)
app.listen({ hostname: "0.0.0.0", port })
console.log(`elysia on :${port}`)
