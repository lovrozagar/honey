import { describe, expect, it } from "vitest"
import { honey } from "../routing/app.ts"
import { inlineJson } from "./docs-page.ts"
import { scalar } from "./scalar.ts"
import { swagger } from "./swagger.ts"

const PAGES = [
	["scalar", scalar],
	["swagger", swagger],
] as const

/** The page `handler` answers at /docs, and a second answer to check it is fresh. */
async function served(handler: unknown): Promise<[Response, Response]> {
	const app = honey<{}>()
	app.get("/docs").handler(handler as never)
	const get = () => app.fetch(new Request("http://x/docs"), {})
	return [await get(), await get()]
}

describe("docs pages: what the browser may run", () => {
	// v0: 42d0262239
	// v0: f2e6ad8d9d
	it.each(PAGES)(
		"%s: a CSP that runs only its own nonce'd inline script and the pinned CDN, a fresh nonce per answer, nosniff",
		async (_name, page) => {
			const [res, again] = await served(page({ url: "/openapi.json" }))
			const csp = res.headers.get("content-security-policy") ?? ""
			const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src")) ?? ""
			const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1]
			const html = await res.text()
			expect([
				csp.includes("default-src 'none'"),
				csp.includes("object-src 'none'"),
				scriptSrc.includes("unsafe-inline"),
				html.includes(`<script nonce="${nonce}">`),
				res.headers.get("x-content-type-options"),
				(html.match(/<script src=[^>]*>/g) ?? []).every((tag) => /integrity="sha384-/.test(tag)),
				again.headers.get("content-security-policy") === csp,
			]).toEqual([true, true, false, true, "nosniff", true, false])
		},
	)
})

describe("docs pages: what a config can write into the page", () => {
	// v0: af72a0547a
	it.each(PAGES)("%s: a config value cannot end the inline script", async (_name, page) => {
		const [res] = await served(page({ oauth2RedirectUrl: "</script><script>alert(1)</script>", url: "/x" }))
		const html = await res.text()
		expect([html.includes("</script><script>alert(1)"), html.includes("\\u003c/script\\u003e")]).toEqual([false, true])
	})

	// v0: d865faf677
	it("inlines JSON with <, >, & and the line and paragraph separators escaped", () => {
		expect(inlineJson({ a: `<b>&x${String.fromCharCode(0x2028)}y${String.fromCharCode(0x2029)}` })).toBe(
			'{"a":"\\u003cb\\u003e\\u0026x\\u2028y\\u2029"}',
		)
	})
})
