/**
 * Fixture for stream-lifecycle.test.ts: one app with endless producers, served by `serve()` on
 * whatever runtime runs this file (Node, Bun, Deno). Prints `PORT <n>` once listening.
 * `GET /state` reports which producers started and finished, and how many intervals are live.
 */
import { honey } from "../../../src/index.ts"
import "../../../src/serve-register.ts"
import { timeout } from "../../../src/timeout.ts"

/* count live intervals: a keepalive timer that outlives its stream shows up here */
const live = new Set<unknown>()
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
globalThis.setInterval = ((fn: () => void, ms?: number) => {
	const id = realSetInterval(fn, ms)
	live.add(id)
	return id
}) as typeof setInterval
globalThis.clearInterval = ((id: Parameters<typeof clearInterval>[0]) => {
	live.delete(id)
	realClearInterval(id)
}) as typeof clearInterval

const state = {
	finished: {} as Record<string, number>,
	signal: {} as Record<string, number>,
	started: {} as Record<string, number>,
}
const bump = (map: Record<string, number>, key: string): void => {
	map[key] = (map[key] ?? 0) + 1
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const app = honey<{}>()

app.get("/sse").handler((ctx) =>
	ctx.res.sse(
		async (stream) => {
			bump(state.started, "sse")
			try {
				for (let i = 0; ; i++) {
					await stream.send({ data: { i }, event: "tick" })
					await sleep(10)
				}
			} finally {
				bump(state.finished, "sse")
			}
		},
		{ keepalive: 20 },
	),
)

app.get("/gen").handler((ctx) => {
	async function* ticks() {
		bump(state.started, "gen")
		try {
			for (let i = 0; ; i++) {
				yield `${i}\n`
				await sleep(10)
			}
		} finally {
			bump(state.finished, "gen")
		}
	}
	return ctx.res.generate(ticks(), { contentType: "text/plain" })
})

app.get("/stream").handler((ctx) =>
	ctx.res.stream(async (writable, signal) => {
		bump(state.started, "stream")
		const writer = writable.getWriter()
		try {
			while (!signal.aborted) {
				await writer.write("x\n")
				await sleep(10)
			}
		} finally {
			bump(state.finished, "stream")
		}
	}),
)

/* the request signal: aborted by the disconnect while the handler is still working */
app.get("/wait").handler(async (ctx) => {
	bump(state.started, "wait")
	ctx.signal.addEventListener("abort", () => bump(state.signal, "wait"))
	await sleep(60_000).catch(() => {})
	return ctx.res.text("ok", "late")
})

app
	.get("/slow")
	.use(timeout({ duration: 100 }))
	.handler(async (ctx) => {
		bump(state.started, "slow")
		await new Promise<void>((resolve) => {
			if (ctx.signal.aborted) resolve()
			ctx.signal.addEventListener("abort", () => resolve(), { once: true })
		})
		bump(state.signal, "slow")
		return ctx.res.text("ok", "too late")
	})

app.get("/state").handler((ctx) => ctx.res.json("ok", { ...state, intervals: live.size }))

const handle = await app.serve({ hostname: "127.0.0.1", port: 0 })
console.log(`PORT ${handle.port}`)
