import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"
import { inlineJson } from "../../../src/openapi/docs-page.ts"
import { scalar } from "../../../src/openapi/scalar.ts"
import { swagger } from "../../../src/openapi/swagger.ts"

async function page(handler: unknown): Promise<Response> {
	const app = honey<{}>()
	app.get("/docs").handler(handler as never)
	return app.fetch(new Request("http://x/docs"), {})
}

describe("docs UI pages", () => {
	for (const [name, make] of [
		["swagger", swagger],
		["scalar", scalar],
	] as const) {
		it(`${name}: CSP allows only its own nonce'd inline script and the pinned CDN`, async () => {
			const res = await page(make({ url: "/openapi.json" }))
			const csp = res.headers.get("content-security-policy") ?? ""
			expect(csp).toContain("default-src 'none'")
			expect(csp).toContain("object-src 'none'")
			const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src")) ?? ""
			expect(scriptSrc).not.toContain("unsafe-inline")
			const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1]
			expect(nonce).toBeTruthy()
			const html = await res.text()
			expect(html).toContain(`<script nonce="${nonce}">`)
			expect(res.headers.get("x-content-type-options")).toBe("nosniff")
			/* every external script carries an integrity hash */
			for (const tag of html.match(/<script src=[^>]*>/g) ?? []) expect(tag).toMatch(/integrity="sha384-/)
		})

		it(`${name}: a fresh nonce per response`, async () => {
			const app = honey<{}>()
			app.get("/docs").handler(make({ url: "/openapi.json" }) as never)
			const a = (await app.fetch(new Request("http://x/docs"), {})).headers.get("content-security-policy")
			const b = (await app.fetch(new Request("http://x/docs"), {})).headers.get("content-security-policy")
			expect(a).not.toBe(b)
		})

		it(`${name}: config cannot break out of the inline script`, async () => {
			const res = await page(make({ oauth2RedirectUrl: "</script><script>alert(1)</script>", url: "/x" }))
			const html = await res.text()
			expect(html).not.toContain("</script><script>alert(1)")
			expect(html).toContain("\\u003c/script\\u003e")
		})
	}

	it("inlineJson escapes line and paragraph separators", () => {
		expect(inlineJson({ a: `x${String.fromCharCode(0x2028)}y${String.fromCharCode(0x2029)}` })).toBe(
			'{"a":"x\\u2028y\\u2029"}',
		)
	})
})
