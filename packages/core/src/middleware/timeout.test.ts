import { describe, expect, it } from "vitest"
import { createMiddleware } from "./middleware.ts"
import { honey } from "../routing/app.ts"
import { timeout } from "./timeout.ts"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** GET /t behind timeout({ duration }), answered by `handler`. */
function app(duration: number, handler: (ctx: { signal: AbortSignal }) => Promise<Response> | Response) {
	const a = honey<{}>()
	a.use(timeout({ duration }))
		.get("/t")
		.handler((ctx) => handler(ctx) as never)
	return a
}

async function send(a: ReturnType<typeof app>) {
	const res = await a.fetch(new Request("https://app.example.com/t"), {})
	const body = (await res.json().catch(() => null)) as { error_key?: string } | null
	return [res.status, body?.error_key ?? null]
}

describe("timeout(): a slow chain answers 504", () => {
	// v0: 560f54fe72
	// v0: f530b0f927
	// v0: 70b43e9291
	// v0: 32db07cd29
	// v0: 3e9e27db41
	// v0: 21e26a674a
	it.each([
		["a handler slower than the duration", () => wait(60).then(() => Response.json({ late: true }))],
		["a handler that never resolves", () => new Promise<Response>(() => {})],
	])("%s: 504 request_timeout", async (_name, handler) => {
		expect(await send(app(10, handler))).toEqual([504, "request_timeout"])
	})

	// v0: 940f3b0637
	// v0: 094ef36e38
	it("aborts ctx.signal with a TimeoutError, so the handler's work can stop", async () => {
		let signal!: AbortSignal
		await send(
			app(10, (ctx) => {
				signal = ctx.signal
				return new Promise(() => {})
			}),
		)
		expect([signal.aborted, (signal.reason as DOMException).name]).toEqual([true, "TimeoutError"])
	})

	// v0: 0c96eb1578
	it("covers the middleware below it too", async () => {
		const a = honey<{}>()
		a.use(timeout({ duration: 10 }))
			.use(
				createMiddleware(async (_ctx, next) => {
					await wait(60)
					return next()
				}),
			)
			.get("/t")
			.handler((ctx) => ctx.res.text("ok", "x"))
		expect(await send(a)).toEqual([504, "request_timeout"])
	})
})

describe("timeout(): what finishes in time is untouched", () => {
	// v0: a5809c0a44
	// v0: ce3fa6ca33
	// v0: 29c0305a24
	// v0: d872f6ac9e
	// v0: df3499d3e6
	it("a fast answer comes through, and nothing is aborted after it", async () => {
		let signal!: AbortSignal
		const a = app(30, async (ctx) => {
			signal = ctx.signal
			await wait(5)
			return Response.json({ ok: true })
		})
		const answer = await send(a)
		await wait(50)
		expect([answer, signal.aborted]).toEqual([[200, null], false])
	})

	// v0: f67ba377a0
	// v0: a96b4839d8
	// v0: ea49e8f362
	// v0: 64109a453f
	it("a handler error before the duration is that error, not a timeout", async () => {
		const a = app(50, async () => {
			await wait(5)
			throw new Error("db down")
		})
		expect(await send(a)).toEqual([500, "internal_server_error"])
	})

	// v0: 96a0a612ac
	// v0: 60cd24340c
	it("a zero duration: a handler that answers at once wins, one that waits a turn does not", async () => {
		const sync = await send(app(0, () => Response.json({ ok: true })))
		const waiting = await send(app(0, () => wait(5).then(() => Response.json({ ok: true }))))
		expect([sync, waiting]).toEqual([
			[200, null],
			[504, "request_timeout"],
		])
	})
})

describe("timeout(): construction", () => {
	it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("refuses a duration of %s", (duration) => {
		expect(() => timeout({ duration })).toThrow("timeout: duration must be a finite number of ms, 0 or more")
	})

	it("declares the error it answers with", () => {
		expect(timeout({ duration: 1 }).errors).toEqual(["request_timeout"])
	})
})
