/**
 * Fixture for request-target.test.ts: one app, served by `serve()` on whatever runtime runs
 * this file (Node, Bun, Deno). Prints `PORT <n>` once listening.
 */
import { honey } from "../../../src/index.ts"
import "../../../src/serve-register.ts"

const app = honey<{}>()
/* the scope guard sees the same path the router does: it marks every response under /admin */
app.use("/admin", async (_ctx, next) => {
	const res = await next()
	res.headers.set("x-scope", "admin")
	return res
})
const echo = (ctx: { path: string; routePattern: string; params: Record<string, string> }) => ({
	params: ctx.params,
	path: ctx.path,
	pattern: ctx.routePattern,
})
app.get("/admin/secret").handler((ctx) => ctx.res.json("ok", echo(ctx)))
app.get("/users/:id").handler((ctx) => ctx.res.json("ok", echo(ctx)))
app.get("/files/*rest").handler((ctx) => ctx.res.json("ok", echo(ctx)))
app.get("/").handler((ctx) => ctx.res.json("ok", echo(ctx)))

const handle = await app.serve({ hostname: "127.0.0.1", port: 0 })
console.log(`PORT ${handle.port}`)
