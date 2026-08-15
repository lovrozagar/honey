import express from "express"
import * as z from "zod"

const body = z.object({ age: z.number(), name: z.string() })

const app = express()
app.use(express.json())

app.get("/json", (_req, res) => {
	res.json({ message: "Hello, World!" })
})

app.get("/params/:id", (req, res) => {
	res.json({ id: req.params.id })
})

app.post("/validate", (req, res) => {
	const parsed = body.parse(req.body)
	res.json({ age: parsed.age, name: parsed.name })
})

app.use("/middleware", (req, _res, next) => {
	;(req as express.Request & { startedAt: number }).startedAt = performance.now()
	next()
})
app.get("/middleware", (req, res) => {
	const start = (req as express.Request & { startedAt: number }).startedAt
	res.json({ elapsed: performance.now() - start })
})

const port = Number(process.env.PORT ?? 3103)
app.listen(port, "0.0.0.0", () => {
	console.log(`express on :${port}`)
})
