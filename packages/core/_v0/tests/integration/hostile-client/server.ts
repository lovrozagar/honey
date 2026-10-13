/**
 * Fixture for hostile-client.test.ts: one app served by `serve()` on whatever runtime runs this
 * file (Node, Bun, Deno). Prints `PORT <n>` once listening. Every route is something a hostile or
 * broken client can poke at; `GET /state` reports what the app saw.
 */
import { createMiddleware, honey } from "../../../src/index.ts"
import "../../../src/serve-register.ts"

const state = {
	closed: 0,
	errors: 0,
	opened: 0,
	sseFinished: 0,
	sseStarted: 0,
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/* async middleware in front of a websocket route: a reset while it awaits must not crash anything */
const slowAuth = createMiddleware(async (_ctx, next) => {
	await sleep(50)
	return next()
})

/* every callback misbehaves on request; none of it may reach the runtime */
const app = honey<{}>()
	.ws("/ws")
	.use(slowAuth)
	.handler({
		onClose(_ctx, _ws, code) {
			state.closed++
			if (code === 4000) throw new Error("close handler throws")
		},
		onError() {
			state.errors++
			throw new Error("onError throws too")
		},
		async onMessage(_ctx, ws, data) {
			const text = typeof data === "string" ? data : `binary:${data.byteLength}`
			if (text === "reject") throw new Error("message handler rejects")
			if (text === "sync-throw") {
				/* a sync throw from an async handler is a rejection; this is the plain-function shape */
				return Promise.reject(new Error("sync"))
			}
			if (text === "close-long") {
				ws.close(1000, "x".repeat(300))
				return
			}
			ws.send(`echo:${text}`)
		},
		onOpen(ctx, ws) {
			state.opened++
			const mode = new URL(ctx.req.url).searchParams.get("throw")
			if (mode === "open") throw new Error("onOpen throws")
			ws.send("ready")
		},
	})

app.ws("/cross").handler({
	onOpen() {
		state.opened++
	},
})

app
	.ws("/partner")
	.origins(["https://partner.example"])
	.handler({
		onOpen(_ctx, ws) {
			ws.send("ready")
		},
	})

app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

app.get("/slow").handler(async (ctx) => {
	await sleep(30)
	return ctx.res.text("ok", "slow")
})

app.post("/echo").handler(async (ctx) => ctx.res.text("ok", await ctx.req.text()))

app.get("/events").handler((ctx) =>
	ctx.res.sse(async (stream) => {
		state.sseStarted++
		try {
			for (let i = 0; ; i++) {
				await stream.send({ data: { i }, event: "tick" })
				await sleep(10)
			}
		} finally {
			state.sseFinished++
		}
	}),
)

app.get("/state").handler((ctx) => ctx.res.json("ok", state))

const handle = await app.serve({ hostname: "127.0.0.1", port: 0 })
console.log(`PORT ${handle.port}`)
