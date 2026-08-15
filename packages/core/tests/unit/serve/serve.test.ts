import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"

describe("Honey.serve()", () => {
	it("throws on runtime: cloudflare with an export-fetch message", async () => {
		const app = honey()
		await expect(app.serve({ runtime: "cloudflare" })).rejects.toThrow(/export default/)
		await expect(app.serve({ runtime: "cloudflare" })).rejects.toThrow(/app\.fetch/)
	})

	it("listens on node and serves routes", async () => {
		const app = honey()
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		const handle = await app.serve({ hostname: "127.0.0.1", port: 0, runtime: "node" })
		try {
			expect(handle.runtime).toBe("node")
			expect(handle.port).toBeGreaterThan(0)
			const res = await fetch(`${handle.url}/health`)
			expect(res.status).toBe(200)
			expect(await res.text()).toBe("ok")
		} finally {
			await handle.close()
		}
	})

	it("detects node when runtime is omitted", async () => {
		const app = honey()
		app.get("/ping").handler((ctx) => ctx.res.text("ok", "pong"))
		const handle = await app.serve({ hostname: "127.0.0.1", port: 0 })
		try {
			expect(handle.runtime).toBe("node")
			const res = await fetch(`${handle.url}/ping`)
			expect(await res.text()).toBe("pong")
		} finally {
			await handle.close()
		}
	})

	it("cors: true answers preflight on the listen instance", async () => {
		const app = honey()
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		const handle = await app.serve({
			cors: true,
			hostname: "127.0.0.1",
			port: 0,
			runtime: "node",
		})
		try {
			const pre = await fetch(`${handle.url}/health`, {
				headers: {
					"access-control-request-method": "GET",
					origin: "http://app.example",
				},
				method: "OPTIONS",
			})
			expect(pre.status).toBe(204)
			expect(pre.headers.get("access-control-allow-origin")).toBeTruthy()
			const get = await fetch(`${handle.url}/health`, {
				headers: { origin: "http://app.example" },
			})
			expect(get.status).toBe(200)
			expect(get.headers.get("access-control-allow-origin")).toBeTruthy()
		} finally {
			await handle.close()
		}
	})
})
