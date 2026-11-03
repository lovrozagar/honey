import { Server } from "node:http"
import { connect } from "node:net"
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest"
import { honey } from "../../routing/app.ts"
import { bunWebSocket } from "../../ws/bun.ts"
import type { ServeHandle } from "../serve-handle.ts"
import { serve } from "./serve.ts"

const handles: ServeHandle<Server>[] = []

afterEach(async () => {
	await Promise.all(handles.splice(0).map((handle) => handle.close(0)))
	vi.restoreAllMocks()
})

/** An app whose / answers with its env's `db`, and whose /hang never answers. */
function app() {
	const a = honey<{ db?: string }>()
	a.get("/").handler((ctx) => ctx.res.json("ok", { db: ctx.env.db ?? null }))
	a.get("/hang").handler(() => new Promise<never>(() => {}))
	return a
}

async function started(...args: Parameters<typeof serve<{ db?: string }>>): Promise<ServeHandle<Server>> {
	const handle = await serve(...args)
	handles.push(handle)
	return handle
}

describe("serve(app) from @lovrozagar/honey/node", () => {
	// v0: 5eda2d7e11
	// v0: 5b31c80894
	it("listens with node:http and hands back the bound port, its URL and Node's own server", async () => {
		const handle = await started(app(), { env: { db: "primary" }, hostname: "127.0.0.1", port: 0 })
		const res = await fetch(handle.url)
		expect([handle.url, handle.server instanceof Server, await res.json()]).toEqual([
			`http://127.0.0.1:${handle.port}`,
			true,
			{ db: "primary" },
		])
		expect(handle.port).toBeGreaterThan(0)
	})

	it("by default binds every interface on port 3000 with an empty env", async () => {
		/* the defaults are what listen() is handed; the test binds a free loopback port instead */
		const listen = Server.prototype.listen as (this: Server, ...args: unknown[]) => Server
		const asked: unknown[][] = []
		vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server, ...args: unknown[]) {
			asked.push(args)
			return listen.call(this, 0, "127.0.0.1")
		})
		const handle = await started(app())
		expect([asked, handle.url, await (await fetch(`http://127.0.0.1:${handle.port}/`)).json()]).toEqual([
			[[3000, "0.0.0.0"]],
			`http://127.0.0.1:${handle.port}`,
			{ db: null },
		])
	})

	it("is typed for Node alone: Node's own server on the handle", async () => {
		const handle = await started(app(), { hostname: "127.0.0.1", port: 0 })
		expectTypeOf(handle.server).toEqualTypeOf<Server>()
	})

	it("passes Node's own options through: keepAliveTimeout ends an idle connection", async () => {
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

	it("rejects an app whose WebSocket adapter is another runtime's", async () => {
		await expect(serve(app().wsAdapter(bunWebSocket()), { hostname: "127.0.0.1", port: 0 })).rejects.toThrow(
			"serve() on Node needs a nodeWebSocket() adapter, but app.wsAdapter() was given another",
		)
	})
})

describe("serve(app) from @lovrozagar/honey/node: close(timeout)", () => {
	it("drains, and the server stops answering", async () => {
		const handle = await serve(app(), { hostname: "127.0.0.1", port: 0 })
		await handle.close()
		await expect(fetch(handle.url)).rejects.toThrow()
	})

	it("cuts what is still running after a second by default", async () => {
		const handle = await started(app(), { hostname: "127.0.0.1", port: 0 })
		const hanging = fetch(`${handle.url}/hang`).catch((error: unknown) => error)
		await vi.waitFor(() => expect(handle.server.listening).toBe(true))
		/* the request is in flight once the server holds its connection */
		await vi.waitFor(async () => {
			const count = await new Promise<number>((resolve) => handle.server.getConnections((_e, n) => resolve(n)))
			expect(count).toBe(1)
		})
		const closingAt = Date.now()
		await handle.close()
		const took = Date.now() - closingAt
		expect([took >= 900, took < 3000, (await hanging) instanceof Error]).toEqual([true, true, true])
	})
})
