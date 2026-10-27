import { afterEach, describe, expect, it, vi } from "vitest"
import { createMiddleware } from "../../middleware/middleware.ts"
import { honey } from "../../routing/app.ts"
import { createLogger } from "../../telemetry/logger.ts"
import { cfWebSocket } from "../../ws/cloudflare.ts"
import { bunWebSocket } from "../../ws/bun.ts"
import { serve } from "./serve.ts"
import { ws } from "../../ws/route.ts"

type BunOptions = {
	error?: (error: unknown) => Response
	fetch(req: Request, server: unknown): Response | Promise<Response | undefined> | undefined
	websocket?: unknown
	hostname: string
	maxRequestBodySize: number
	port: number
}

/** A stand-in for Bun.serve that records what it was given; `stop(false)` settles when `drained` does. */
function fakeBun(drained: Promise<void> = Promise.resolve()) {
	const calls: { options?: BunOptions; stops: boolean[]; idleCloses: number } = { idleCloses: 0, stops: [] }
	const server = {
		closeIdleConnections: () => {
			calls.idleCloses++
		},
		port: 4321,
		requestIP: () => ({ address: "::ffff:192.0.2.1" }),
		upgrade: () => true,
		stop: (force: boolean) => {
			calls.stops.push(force)
			return force ? Promise.resolve() : drained
		},
	}
	vi.stubGlobal("Bun", {
		serve: (options: BunOptions) => {
			calls.options = options
			return server
		},
	})
	return { calls, server }
}

const options = { env: { db: "x" }, hostname: "127.0.0.1", maxRequestBodySize: 1024, port: 0 }

afterEach(() => {
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

describe("serve on Bun: what Bun.serve is given", () => {
	it("the hostname, the port and the body cap", () => {
		const { calls } = fakeBun()
		const listener = serve({ fetch: () => new Response() }, options)
		const { hostname, maxRequestBodySize, port } = calls.options as BunOptions
		expect([hostname, maxRequestBodySize, port, listener.port]).toEqual(["127.0.0.1", 1024, 0, 4321])
	})

	/* bit 07 (H17): the same sink and the same 500 as Node, never Bun's own error page with its stack */
	it("with no onError, a failure goes to the app's logger and answers a plain 500", async () => {
		const { calls } = fakeBun()
		const lines: Record<string, unknown>[] = []
		const app = honey<{}>().logger(
			createLogger({
				format: "json",
				level: "info",
				write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
			}),
		)
		app.get("/").handler((ctx) => ctx.res.text("ok", "x"))
		serve(app, options)
		const res = (calls.options as BunOptions).error?.("plain") as Response
		expect([
			res.status,
			await res.text(),
			lines.map((line) => [line.msg, (line.err as { message: string }).message]),
		]).toEqual([500, "Internal Server Error", [["serve failed", "plain"]]])
	})

	it("a fetch that hands the app the env with the server, built once, so ctx.ip resolves", async () => {
		const { calls, server } = fakeBun()
		const envs: unknown[] = []
		const app = honey<{ db: string }>()
		app.get("/who").handler((ctx) => {
			envs.push(ctx.env)
			return ctx.res.json("ok", { db: ctx.env.db, ip: ctx.ip })
		})
		serve(app, options)
		const { fetch } = calls.options as BunOptions
		const first = await ((await fetch(new Request("http://h/who"), server)) as Response).json()
		await fetch(new Request("http://h/who"), server)
		expect([first, envs[0], envs[0] === envs[1]]).toEqual([{ db: "x", ip: "192.0.2.1" }, { db: "x", server }, true])
	})

	it("an error handler that reports to onError and answers 500", async () => {
		const { calls } = fakeBun()
		const onError = vi.fn()
		serve({ fetch: () => new Response() }, { ...options, onError })
		const boom = new Error("boom")
		const res = (calls.options as BunOptions).error?.(boom) as Response
		expect([res.status, await res.text(), onError.mock.calls]).toEqual([500, "Internal Server Error", [[boom]]])
	})
})

describe("serve on Bun: close(timeout)", () => {
	it("stops gracefully and closes idle keep-alive connections, before and after the drain", async () => {
		const { calls } = fakeBun()
		await serve({ fetch: () => new Response() }, options).close(1000)
		expect([calls.stops, calls.idleCloses]).toEqual([[false], 2])
	})

	it("cuts every connection when the drain outlasts the timeout", async () => {
		const { calls } = fakeBun(new Promise(() => {}))
		await serve({ fetch: () => new Response() }, options).close(10)
		expect(calls.stops).toEqual([false, true])
	})
})

/** A WebSocket handshake for `path`. */
const handshake = (path: string) =>
	new Request(`http://127.0.0.1${path}`, { headers: { connection: "Upgrade", upgrade: "websocket" } })

describe("serve on Bun: WebSockets", () => {
	it("an app without an adapter gets bunWebSocket(), set on the app, its handlers given to Bun.serve", () => {
		const { calls } = fakeBun()
		const app = honey<{}>()
		serve(app, options)
		const set = (app as unknown as { settings: { wsAdapter: { websocket: unknown } } }).settings.wsAdapter
		expect([set !== null, calls.options?.websocket === set.websocket]).toEqual([true, true])
	})

	it("keeps a bunWebSocket() the app was given, and refuses another runtime's adapter", () => {
		const { calls } = fakeBun()
		const own = bunWebSocket({ maxPayload: 10 })
		serve(honey<{}>().wsAdapter(own), options)
		expect(calls.options?.websocket).toBe(own.websocket)
		expect(() => serve(honey<{}>().wsAdapter(cfWebSocket()), options)).toThrow(
			"serve() on Bun needs a bunWebSocket() adapter, but app.wsAdapter() was given another",
		)
	})

	it("a plain fetch handler, not a honey app, is served without WebSocket handlers", () => {
		const { calls } = fakeBun()
		serve({ fetch: () => new Response("ok") }, options)
		expect(calls.options?.websocket).toBeUndefined()
	})

	it("answers Bun nothing once a request was upgraded, as Bun expects; other answers pass through", async () => {
		const { calls, server } = fakeBun()
		const app = honey<{}>()
		ws(app, "/live").handler({})
		app.get("/page").handler((ctx) => ctx.res.text("ok", "page"))
		app
			.use(createMiddleware(async (_ctx, next) => next()))
			.get("/async")
			.handler(async (ctx) => ctx.res.text("ok", "later"))
		serve(app, options)
		const { fetch } = calls.options as BunOptions
		const [live, page, later] = await Promise.all([
			fetch(handshake("/live"), server),
			fetch(new Request("http://127.0.0.1/page"), server),
			fetch(new Request("http://127.0.0.1/async"), server),
		])
		expect([live, await page?.text(), await later?.text()]).toEqual([undefined, "page", "later"])
	})

	it("an adapter swapped after serve() cannot reach Bun: the upgrade fails loudly, naming the fix", async () => {
		const { calls, server } = fakeBun()
		const app = honey<{}>()
		ws(app, "/live").handler({})
		serve(app, options)
		app.wsAdapter(bunWebSocket())
		const { fetch } = calls.options as BunOptions
		expect(() => fetch(handshake("/live"), server)).toThrow(
			"honey: app.wsAdapter() changed after serve(app) on Bun, where Bun.serve took the first adapter's handlers: set app.wsAdapter() before serve()",
		)
		expect(await (fetch(new Request("http://127.0.0.1/live"), server) as Response).text()).toBe("Upgrade Required")
	})
})
