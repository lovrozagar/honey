/**
 * Node fixture for the WS4–WS8 regression suite (see docs/regression-matrix/ws4-8.md).
 *
 * One app served by the real Node adapter (`serve()` from node.ts) under plain `node`. Every route
 * reproduces a review finding's exact scenario; `GET /state` reports what the app observed. It uses
 * only API that existed before the review fixes (3ab88ce), so the same file runs against that tree
 * to prove each test fails there. Prints `PORT <n>` once listening.
 *
 * Env: `UPSTREAM` — base URL of the test's upstream server for the proxy routes.
 */
import * as z from "zod"
import { bodyLimit } from "../../../src/body-limit.ts"
import { cors } from "../../../src/cors.ts"
import { curlLogger } from "../../../src/curl-logger.ts"
import { createMiddleware, honey } from "../../../src/index.ts"
import { serve } from "../../../src/node.ts"
import { nodeWebSocket } from "../../../src/ws/node.ts"
import "../../../src/proxy.ts"

/* features that moved behind an import after 3ab88ce; the old tree has them built in */
await import("../../../src/realtime/register.ts").catch(() => {})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const state = {
	curlLogs: [] as string[],
	maxMessageBytes: 0,
	postAborted: 0,
	rtGhostId: "",
	sseFinally: 0,
}

const upstream = process.env.UPSTREAM ?? "http://127.0.0.1:9"

const slowAuth = createMiddleware(async (_ctx, next) => {
	await sleep(80)
	return next()
})

const app = honey()

app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
app.get("/state").handler((ctx) => ctx.res.json("ok", state))

/* C2: an async handler on the upgrade path; the client resets the socket while it awaits */
app.get("/slow").handler(async (ctx) => {
	await sleep(80)
	return ctx.res.text("ok", "slow")
})

/* H3: the README SSE shape — `finally { s.close() }` — with a client that disconnects */
app.get("/sse-finally").handler((ctx) =>
	ctx.res.sse(async (s) => {
		try {
			for (let i = 0; i < 1000; i++) {
				await s.send({ data: `tick ${i}` })
				await sleep(10)
			}
		} finally {
			state.sseFinally++
			s.close()
		}
	}),
)

/* H5: an SSE route reached with `Upgrade: x` */
app.get("/events").handler((ctx) =>
	ctx.res.sse(async (s) => {
		for (let i = 0; i < 100; i++) {
			await s.send({ data: `event ${i}` })
			await sleep(50)
		}
	}),
)

/* H6 + NEW (L) HEAD content-length: a plain route with its own headers */
app.get("/plain").handler((ctx) => ctx.res.text("ok", "hello world", { headers: { "x-custom": "1" } }))

/* H9: README `generate(gen, { contentType: "text/plain" })` with a slow second chunk */
app.get("/gen-text").handler((ctx) => {
	async function* gen(): AsyncGenerator<string> {
		yield "first\n"
		await sleep(1500)
		yield "second\n"
	}
	return ctx.res.generate(gen(), { contentType: "text/plain" })
})

/* M node-request signal: body read first, then a disconnect must abort the request signal */
app.post("/sse-post").handler(async (ctx) => {
	await ctx.req.text()
	const signal = ctx.req.signal
	return ctx.res.sse(async (s) => {
		await s.send({ data: "started" })
		await new Promise<void>((resolve) => {
			if (signal.aborted) resolve()
			signal.addEventListener("abort", () => resolve(), { once: true })
			setTimeout(resolve, 3000)
		})
		if (signal.aborted) state.postAborted++
	})
})

/* M NodeRequest contract: Fetch semantics for repeated and empty body reads, and clone() */
app.post("/req-contract").handler(async (ctx) => {
	const out: Record<string, string> = {}
	const req = ctx.req
	const twin = req.clone()
	out.cloneText = await twin.text()
	/* `req.body` after `clone()` must still be readable (it was locked) */
	try {
		out.first = await new Response(req.body).text()
	} catch (error) {
		out.first = `threw:${(error as Error).name}`
	}
	try {
		const second = await req.text()
		out.second = `returned:${JSON.stringify(second)}`
	} catch (error) {
		out.second = `threw:${(error as Error).name}`
	}
	return ctx.res.json("ok", out)
})
app.post("/req-twice").handler(async (ctx) => {
	const first = await ctx.req.text()
	try {
		const second = await ctx.req.text()
		return ctx.res.json("ok", { first, second: `returned:${JSON.stringify(second)}` })
	} catch (error) {
		return ctx.res.json("ok", { first, second: `threw:${(error as Error).name}` })
	}
})
app.get("/req-dup-header").handler((ctx) => {
	const before = ctx.req.headers.get("authorization")
	const seen: string[] = []
	for (const [name, value] of ctx.req.headers) if (name === "authorization") seen.push(value)
	const after = ctx.req.headers.get("authorization")
	return ctx.res.json("ok", { after, before, seen })
})
app.post("/req-empty-json").handler(async (ctx) => {
	try {
		const value = await ctx.req.json()
		return ctx.res.json("ok", { result: `returned:${JSON.stringify(value)}` })
	} catch (error) {
		return ctx.res.json("ok", { result: `threw:${(error as Error).name}` })
	}
})

/* M curlLogger({ body: true }) before bodyLimit; NEW (M) curlLogger with a malformed Host */
const logged = app
	.use(
		curlLogger({
			body: true,
			log: (data: { curl: string }) => {
				state.curlLogs.push(data.curl)
			},
		} as never),
	)
	.use(bodyLimit({ maxSize: 100_000 }))
logged.post("/curl-echo").handler(async (ctx) => ctx.res.text("ok", await ctx.req.text()))
logged.get("/curl-get").handler((ctx) => ctx.res.text("ok", "logged"))

/* H27 / H28: proxy to a real upstream (gzip, chunked + hop-by-hop headers) */
app.all("/up/*").proxy({
	destination: (_c, url, init) => fetch(`${upstream}${url}`, init),
} as never)

/* H2: WS callbacks that reject or throw */
app.ws("/ws-open-reject").handler({
	async onOpen() {
		throw new Error("onOpen rejects")
	},
})
app.ws("/ws-close-throw").handler({
	onClose() {
		throw new Error("onClose throws")
	},
	onOpen(_ctx, ws) {
		ws.send("ready")
	},
})
/* NEW (M): a sync throw in onOpen */
app.ws("/ws-open-sync").handler({
	onOpen() {
		throw new Error("onOpen sync throw")
	},
})
/* C2 variant: async middleware in front of a websocket route */
app
	.ws("/ws-slow")
	.use(slowAuth)
	.handler({
		onOpen(_ctx, ws) {
			ws.send("ready")
		},
	})
/* M: `.input()` on a WS route must be validated before the upgrade */
;(app.ws("/ws-input") as unknown as { input(s: unknown): { handler(h: unknown): unknown } })
	.input({ search: z.object({ token: z.string() }) })
	.handler({
		onOpen(_ctx: unknown, ws: { send(d: string): void }) {
			ws.send("opened")
		},
	})
/* M maxPayload, H Origin: an echo that records the largest message it got */
app.ws("/ws-echo").handler({
	onMessage(_ctx, ws, data) {
		const size = typeof data === "string" ? data.length : data.byteLength
		state.maxMessageBytes = Math.max(state.maxMessageBytes, size)
		ws.send(`got:${size}`)
	},
	onOpen(_ctx, ws) {
		ws.send("ready")
	},
})
/* H29: cors() in front of a websocket route */
app
	.ws("/ws-cors")
	.use(cors() as never)
	.handler({
		onMessage(_ctx, ws, data) {
			ws.send(`echo:${String(data)}`)
		},
		onOpen(_ctx, ws) {
			ws.send("ready")
		},
	})

/* H1: realtime callbacks that reject (the TODO's exact handler) */
app.realtime("/rt-reject", {
	handler: (_c: unknown, conn: { on(e: "message", h: (p: { text: string }) => unknown): void }) => {
		conn.on("message", async (p) => p.text.trim())
	},
} as never)
/* M wire format: echo whatever payload the client sent */
app.realtime("/rt-echo", {
	handler: (_c: unknown, conn: { on(e: "message", h: (p: unknown) => void): void; send(p: unknown): void }) => {
		conn.on("message", (p) => conn.send({ echo: p }))
	},
} as never)
/* M ghost subscriber: a close handler that throws after the connection joined a topic */
app.realtime("/rt-ghost", {
	handler: (
		_c: unknown,
		conn: { id: string; join(t: string): void; on(e: "close", h: () => void): void; send(p: unknown): void },
	) => {
		conn.join("room")
		state.rtGhostId = conn.id
		conn.on("close", () => {
			throw new Error("close handler throws")
		})
		conn.send({ joined: true })
	},
} as never)

/* realtime presence, read from the bus the app owns (old: raw topic; new: namespaced topic) */
app.get("/rt-presence").handler(async (ctx) => {
	const bus = (app as unknown as { _realtimeBus: { presence(t: string): string[] } | null })._realtimeBus
	const keys = ["room"]
	const server = (await import("../../../src/realtime/server.ts").catch(() => null)) as {
		topicKey?: (ns: string, t: string) => string
	} | null
	if (server?.topicKey) keys.push(server.topicKey("/rt-ghost", "room"))
	const members = bus ? keys.flatMap((k) => bus.presence(k)) : []
	return ctx.res.json("ok", { members })
})

app.wsAdapter(nodeWebSocket())

const server = serve(app as never, { env: {}, port: 0 } as never)
server.on("listening", () => {
	const address = server.address()
	const port = typeof address === "object" && address !== null ? address.port : 0
	process.stdout.write(`PORT ${port}\n`)
})
