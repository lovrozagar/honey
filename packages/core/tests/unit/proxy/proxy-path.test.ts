import { describe, expect, it, vi } from "vitest"
import { Honey } from "../../../src/index.ts"
import "../../../src/proxy.ts"

function rawRequest(path: string): Request {
	/* a runtime that hands the app the raw target (Deno builds request.url from it) */
	const req = new Request("http://localhost/")
	Object.defineProperty(req, "url", { value: `http://localhost${path}` })
	return req
}

describe("proxy() forwards the normalized path, never the raw target", () => {
	function app(destination = vi.fn((_ctx: unknown, url: string) => new Response(url))) {
		const a = new Honey<{}>().all("/up/*rest").proxy({ destination })
		return { a, destination }
	}

	it("dot segments are resolved before routing, so they never reach the upstream", async () => {
		const { a, destination } = app()
		const res = await a.fetch(rawRequest("/up/files/../../admin/secret"), {})
		/* resolved to /admin/secret, which is not under /up */
		expect(res.status).toBe(404)
		expect(destination).not.toHaveBeenCalled()
	})

	it("a doubled slash cannot hand destination a protocol-relative URL", async () => {
		const { a } = app()
		const res = await a.fetch(rawRequest("/up//evil.example/x?q=1"), {})
		expect(await res.text()).toBe("/up/evil.example/x?q=1")
	})

	it("encoded separators are rejected before the proxy runs", async () => {
		const { a, destination } = app()
		for (const p of ["/up/..%2f..%2fadmin", "/up/a%5c..%5cadmin"]) {
			expect((await a.fetch(rawRequest(p), {})).status, p).toBe(400)
		}
		expect(destination).not.toHaveBeenCalled()
	})
})
