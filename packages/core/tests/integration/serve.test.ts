/**
 * serve(app) as an app module uses it: on Node in this process, on Bun in a spawned `bun`, and
 * Cloudflare Workers through the exported app itself. The handle it returns, a server that
 * survives a client leaving, a graceful drain, and a port free again after close().
 */
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type ServeHandle, serve } from "../../src/adapters/serve.ts"
import { honey } from "../../src/routing/app.ts"

const handles: ServeHandle[] = []

afterEach(async () => {
	await Promise.all(handles.splice(0).map((handle) => handle.close(0)))
	aborts.length = 0
	slowStarted.length = 0
	vi.unstubAllGlobals()
})

/** Reasons /hang saw its signal abort with. */
const aborts: unknown[] = []
/** One entry per /slow request the server began handling. */
const slowStarted: true[] = []

/** /who answers with ctx.ip; /hang answers only once its signal aborts; /slow after 50 ms. */
function app() {
	const a = honey<{}>()
	a.get("/who").handler((ctx) => ctx.res.json("ok", { ip: ctx.ip }))
	a.get("/hang").handler(
		(ctx) =>
			new Promise((resolve) =>
				ctx.signal.addEventListener("abort", () => {
					aborts.push(ctx.signal.reason)
					resolve(ctx.res.text("ok", "aborted"))
				}),
			),
	)
	a.get("/slow").handler(async (ctx) => {
		slowStarted.push(true)
		await new Promise((resolve) => setTimeout(resolve, 50))
		return ctx.res.text("ok", "slow done")
	})
	return a
}

async function started(port = 0): Promise<ServeHandle> {
	const handle = await serve(app(), { hostname: "127.0.0.1", port })
	handles.push(handle)
	return handle
}

describe("serve(app) on Node", () => {
	// v0: c4e26ac120
	it("binds, survives a client leaving mid-request, closes, and the port binds again", async () => {
		const first = await started()
		const leaving = new AbortController()
		const hanging = fetch(`${first.url}/hang`, { signal: leaving.signal }).catch((error: unknown) => error)
		await new Promise((resolve) => setTimeout(resolve, 20))
		leaving.abort()
		await vi.waitFor(() => expect(aborts).toHaveLength(1))
		expect([((await hanging) as Error).name, (aborts[0] as DOMException).message]).toEqual([
			"AbortError",
			"The client disconnected",
		])
		expect(await (await fetch(`${first.url}/who`)).json()).toEqual({ ip: "127.0.0.1" })
		await first.close()
		const again = await started(first.port)
		expect([again.port, (await fetch(`${again.url}/who`)).status]).toEqual([first.port, 200])
	})

	// v0: f939b64bc5
	it("close() lets an in-flight request finish before the server stops", async () => {
		const handle = await started()
		const slow = fetch(`${handle.url}/slow`)
		/* in flight means the handler began: a fixed sleep loses that race under load */
		await vi.waitFor(() => expect(slowStarted).toHaveLength(1))
		await handle.close()
		const res = await slow
		expect([res.status, await res.text()]).toEqual([200, "slow done"])
		await expect(fetch(`${handle.url}/who`)).rejects.toThrow()
	})
})

const SRC = fileURLToPath(new URL("../../src/", import.meta.url))

/** A `bun` process serving the app on a free port; it prints its handle, and closes it on any stdin input. */
const BUN_APP = `
const { serve } = await import(${JSON.stringify(`${SRC}adapters/serve.ts`)})
const { honey } = await import(${JSON.stringify(`${SRC}routing/app.ts`)})
const app = honey()
app.get("/who").handler((ctx) => ctx.res.json("ok", { ip: ctx.ip, server: typeof ctx.env.server }))
const handle = await serve(app, { hostname: "127.0.0.1", port: 0 })
console.log(JSON.stringify({ port: handle.port, runtime: handle.runtime, url: handle.url }))
process.stdin.once("data", async () => {
	await handle.close()
	console.log("closed")
})
`

describe("serve(app) on Bun", () => {
	// v0: 5e67afde03
	it("serves through Bun.serve, with ctx.ip from the server, and closes on request", async () => {
		const child = spawn("bun", ["-e", BUN_APP], { stdio: ["pipe", "pipe", "inherit"] })
		const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
		try {
			const handle = JSON.parse((await lines.next()).value as string) as { port: number; runtime: string; url: string }
			const who = await (await fetch(`${handle.url}/who`)).json()
			expect([handle.runtime, handle.url, who]).toEqual([
				"bun",
				`http://127.0.0.1:${handle.port}`,
				{ ip: "127.0.0.1", server: "object" },
			])
			child.stdin.write("close\n")
			expect((await lines.next()).value).toBe("closed")
		} finally {
			child.kill()
		}
	}, 20_000)
})

describe("Cloudflare Workers: the exported app is the Worker", () => {
	// v0: 4545e7ea27
	// v0: 481a9a3cb7
	it("`export default app` answers fetch(request, env, ctx), and serve() points there instead of listening", async () => {
		vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" })
		const worker = app()
		const ctx = { passThroughOnException: () => {}, waitUntil: () => {} }
		const req = new Request("http://h/who", { headers: { "cf-connecting-ip": "203.0.113.9" } })
		expect(await (await worker.fetch(req, {}, ctx)).json()).toEqual({ ip: "203.0.113.9" })
		await expect(serve(worker)).rejects.toThrow("export the app instead (`export default app`)")
	})
})
