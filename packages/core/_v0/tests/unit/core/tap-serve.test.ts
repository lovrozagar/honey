import { describe, expect, it } from "vitest"
import { defineErrors, honey } from "../../../src/index.ts"

describe("tap over a real listen", () => {
	it("HTTP 200 fires meta + ctx.tap; error path does not", async () => {
		const seen: Array<{ key: string; payload: unknown }> = []
		const app = honey()
			.errorFactory(
				defineErrors({
					nope: "bad_request",
				}),
			)
			.meta<{ audit?: { action: string } }>()
			.tap("audit", (_ctx, payload) => {
				seen.push({ key: "audit", payload })
			})
			.get("/ok")
			.meta({ audit: { action: "list" } })
			.handler((ctx) => {
				ctx.tap("audit", { action: "dynamic" })
				return ctx.res.json("ok", { ok: true })
			})
			.get("/boom")
			.handler((ctx) => {
				ctx.tap("audit", { action: "should-not-fire" })
				throw ctx.errors.nope()
			})

		const handle = await app.serve({ hostname: "127.0.0.1", port: 0, runtime: "node" })
		try {
			const ok = await fetch(`${handle.url}/ok`)
			expect(ok.status).toBe(200)
			expect(await ok.json()).toEqual({ ok: true })

			const boom = await fetch(`${handle.url}/boom`)
			expect(boom.status).toBe(400)

			await new Promise((r) => setTimeout(r, 20))
			expect(seen).toEqual([
				{ key: "audit", payload: { action: "list" } },
				{ key: "audit", payload: { action: "dynamic" } },
			])
		} finally {
			await handle.close()
		}
	})
})
