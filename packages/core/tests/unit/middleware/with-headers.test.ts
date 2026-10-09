import http from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { cors } from "../../../src/cors.ts"
import { createHoneyResponse } from "../../../src/honey-response.ts"
import { honey } from "../../../src/index.ts"
import { type HoneyServer, serve } from "../../../src/node.ts"
import { poweredBy } from "../../../src/powered-by.ts"
import { requestId } from "../../../src/request-id.ts"
import { secureHeaders } from "../../../src/secure-headers.ts"
import { serverTiming } from "../../../src/server-timing.ts"
import { withHeaders } from "../../../src/with-headers.ts"

function fake101(): Response {
	const response = new Response(null)
	Object.defineProperty(response, "status", { value: 101 })
	return response
}

describe("withHeaders", () => {
	it("edits a mutable Response in place", () => {
		const response = new Response("ok", { headers: { "x-a": "1" } })
		const out = withHeaders(response, (h) => h.set("x-b", "2"))
		expect(out).toBe(response)
		expect(out.headers.get("x-b")).toBe("2")
	})

	it("copies a redirect (immutable headers) and keeps status, status text and body", async () => {
		const response = Response.redirect("http://example.com/next", 302)
		const out = withHeaders(response, (h) => h.set("x-b", "2"))
		expect(out.status).toBe(302)
		expect(out.headers.get("location")).toBe("http://example.com/next")
		expect(out.headers.get("x-b")).toBe("2")
	})

	it("copies a fetch() response and keeps every Set-Cookie", async () => {
		const server = http.createServer((_req, res) => {
			res.setHeader("set-cookie", ["a=1", "b=2"])
			res.statusMessage = "Fine"
			res.end("upstream")
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		try {
			const { port } = server.address() as { port: number }
			const upstream = await fetch(`http://127.0.0.1:${port}/`)
			const out = withHeaders(upstream, (h) => h.set("x-b", "2"))
			expect(out.headers.get("x-b")).toBe("2")
			expect(out.headers.getSetCookie()).toEqual(["a=1", "b=2"])
			expect(out.statusText).toBe("Fine")
			expect(await out.text()).toBe("upstream")
		} finally {
			server.close()
		}
	})

	it("passes 101 upgrades through untouched", () => {
		const response = fake101()
		let called = false
		const out = withHeaders(response, () => {
			called = true
		})
		expect(out).toBe(response)
		expect(called).toBe(false)
	})

	it("edits a HoneyResponse in place", () => {
		const response = createHoneyResponse({ raw: "ok", headers: { "content-type": "text/plain" }, status: 200 })
		const out = withHeaders(response, (h) => h.set("x-b", "2"))
		expect(out).toBe(response)
		expect(out.headers.get("x-b")).toBe("2")
	})
})

/* H26: header middleware over a response with immutable headers used to throw
 * (500 on Node). H29: cors rebuilt 101 upgrade sentinels (RangeError). */
describe("header middleware over immutable and upgrade responses", () => {
	const all = [
		["requestId", requestId()],
		["poweredBy", poweredBy()],
		["secureHeaders", secureHeaders()],
		["serverTiming", serverTiming()],
		["cors", cors({ origin: "http://app.test" })],
	] as const

	for (const [name, mw] of all) {
		it(`${name} on Response.redirect() → 302 with its header`, async () => {
			const app = honey<{}>().use(mw as never)
			app.get("/go").handler(() => Response.redirect("http://example.com/next", 302))
			const res = await app.fetch(new Request("http://localhost/go", { headers: { origin: "http://app.test" } }), {})
			expect(res.status).toBe(302)
			expect(res.headers.get("location")).toBe("http://example.com/next")
		})

		it(`${name} passes a 101 upgrade through unchanged`, async () => {
			const upgrade = fake101()
			const out = await (mw as (ctx: unknown, next: () => Promise<Response>) => Promise<Response>)(
				{
					path: "/ws",
					req: new Request("http://localhost/ws", { headers: { origin: "http://app.test" } }),
				},
				async () => upgrade,
			)
			expect(out).toBe(upgrade)
			expect(out.status).toBe(101)
		})
	}

	let server: HoneyServer | undefined
	afterEach(async () => {
		await server?.shutdown(1000)
		server = undefined
	})

	it("on Node, every header middleware over an immutable upstream response → 200", async () => {
		const upstream = http.createServer((_req, res) => res.end("from upstream"))
		await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
		try {
			const { port: upstreamPort } = upstream.address() as { port: number }
			const app = honey<{}>()
				.use(requestId())
				.use(poweredBy())
				.use(secureHeaders())
				.use(serverTiming())
				.use(cors({ origin: "http://app.test" }))
			app.get("/p").handler(() => fetch(`http://127.0.0.1:${upstreamPort}/`))
			server = serve(app, { env: {}, port: 0 })
			const { port } = server.address() as { port: number }
			const res = await fetch(`http://127.0.0.1:${port}/p`, { headers: { origin: "http://app.test" } })
			expect(res.status).toBe(200)
			expect(await res.text()).toBe("from upstream")
			expect(res.headers.get("x-request-id")).not.toBeNull()
			expect(res.headers.get("x-powered-by")).toBe("Honey")
			expect(res.headers.get("x-content-type-options")).toBe("nosniff")
			expect(res.headers.get("server-timing")).toContain("total;dur=")
			expect(res.headers.get("access-control-allow-origin")).toBe("http://app.test")
		} finally {
			upstream.close()
		}
	})
})
