import { afterEach, describe, expect, it, vi } from "vitest"
import { honey } from "../../routing/app.ts"
import { serve } from "./serve.ts"

type BunOptions = {
	error?: (error: unknown) => Response
	fetch(req: Request, server: unknown): Response | Promise<Response>
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
	it("the hostname, the port and the body cap; Bun's own error page unless onError is set", () => {
		const { calls } = fakeBun()
		const listener = serve({ fetch: () => new Response() }, options)
		const { hostname, maxRequestBodySize, port, error } = calls.options as BunOptions
		expect([hostname, maxRequestBodySize, port, error, listener.port]).toEqual(["127.0.0.1", 1024, 0, undefined, 4321])
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
		const first = await (await fetch(new Request("http://h/who"), server)).json()
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
