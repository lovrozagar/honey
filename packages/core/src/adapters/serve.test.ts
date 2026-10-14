import { connect } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { honey } from "../routing/app.ts"
import { DEFAULT_MAX_REQUEST_BODY, type ServeHandle, serve } from "./serve.ts"

const handles: ServeHandle[] = []

afterEach(async () => {
	await Promise.all(handles.splice(0).map((handle) => handle.close(0)))
	vi.unstubAllGlobals()
})

/** An app whose / answers with its env's `db`. */
function app() {
	const a = honey<{ db?: string }>()
	a.get("/").handler((ctx) => ctx.res.json("ok", { db: ctx.env.db ?? null }))
	return a
}

async function started(...args: Parameters<typeof serve>): Promise<ServeHandle> {
	const handle = await serve(...args)
	handles.push(handle)
	return handle
}

/** Bun.serve stubbed: what it was given, and a server bound to `port`. */
function stubBun(port = 3000) {
	const given: Record<string, unknown>[] = []
	const stop = vi.fn(() => Promise.resolve())
	vi.stubGlobal("Bun", {
		serve: (options: Record<string, unknown>) => {
			given.push(options)
			return { closeIdleConnections: () => {}, port, stop }
		},
	})
	return { given, stop }
}

describe("serve(app): the runtime it runs on picks the adapter", () => {
	// v0: 5eda2d7e11
	// v0: 5b31c80894
	it("on Node, listens with node:http and hands back the bound address", async () => {
		const handle = await started(app(), { env: { db: "primary" }, hostname: "127.0.0.1", port: 0 })
		const res = await fetch(handle.url)
		expect([handle.runtime, handle.hostname, handle.url, await res.json()]).toEqual([
			"node",
			"127.0.0.1",
			`http://127.0.0.1:${handle.port}`,
			{ db: "primary" },
		])
		expect(handle.port).toBeGreaterThan(0)
	})

	it("on Bun, serves with Bun.serve", async () => {
		const { given } = stubBun(4321)
		const handle = await started(app(), { hostname: "127.0.0.1", port: 0 })
		expect([handle.runtime, handle.port, handle.url, given.length]).toEqual(["bun", 4321, "http://127.0.0.1:4321", 1])
	})

	// v0: 6ae8560697
	// v0: ba9b2a20f0
	it("on Cloudflare Workers, refuses: the exported app is the Worker", async () => {
		vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" })
		await expect(serve(app())).rejects.toThrow("serve() does not run on Cloudflare Workers: export the app instead")
	})
})

describe("serve(app): defaults", () => {
	it("binds every interface on port 3000 with the 128 MiB body cap and an empty env, reachable at 127.0.0.1", async () => {
		const { given } = stubBun()
		const handle = await started(app())
		const { fetch, hostname, maxRequestBodySize, port } = given[0] as {
			fetch(req: Request, server: unknown): Promise<Response>
			hostname: string
			maxRequestBodySize: number
			port: number
		}
		const body = await (await fetch(new Request("http://h/"), {})).json()
		expect([hostname, port, maxRequestBodySize, body, handle.url]).toEqual([
			"0.0.0.0",
			3000,
			DEFAULT_MAX_REQUEST_BODY,
			{ db: null },
			"http://127.0.0.1:3000",
		])
	})

	it.each([
		["::", "http://127.0.0.1:3000"],
		["::1", "http://[::1]:3000"],
		["app.internal", "http://app.internal:3000"],
	])("hostname %j is reachable at %s", async (hostname, url) => {
		stubBun()
		expect((await started(app(), { hostname })).url).toBe(url)
	})

	it("close() waits up to a second by default", async () => {
		const { stop } = stubBun()
		vi.useFakeTimers()
		stop.mockImplementationOnce(() => new Promise(() => {}))
		const closing = (await serve(app())).close()
		await vi.advanceTimersByTimeAsync(999)
		expect(stop.mock.calls).toEqual([[false]])
		await vi.advanceTimersByTimeAsync(1)
		await closing
		expect(stop.mock.calls).toEqual([[false], [true]])
		vi.useRealTimers()
	})
})

describe("serve(app): Node options and failures", () => {
	it("passes the Node options through: keepAliveTimeout ends an idle connection", async () => {
		const handle = await started(app(), { hostname: "127.0.0.1", keepAliveTimeout: 50, port: 0 })
		const socket = connect(handle.port, "127.0.0.1")
		socket.resume()
		socket.write("GET / HTTP/1.1\r\nHost: h\r\n\r\n")
		const sentAt = Date.now()
		await new Promise((resolve) => socket.on("close", resolve))
		expect(Date.now() - sentAt).toBeLessThan(2000)
	})

	it("rejects when the port is taken", async () => {
		const first = await started(app(), { hostname: "127.0.0.1", port: 0 })
		await expect(serve(app(), { hostname: "127.0.0.1", port: first.port })).rejects.toThrow("EADDRINUSE")
	})

	it("close() drains the Node server", async () => {
		const handle = await serve(app(), { hostname: "127.0.0.1", port: 0 })
		await handle.close()
		await expect(fetch(handle.url)).rejects.toThrow()
	})
})
