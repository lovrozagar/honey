import { describe, expect, it } from "vitest"
import { honey } from "../routing/app.ts"
import { secureHeaders, type SecureHeadersOptions } from "./secure-headers.ts"

const SECURITY = [
	"x-content-type-options",
	"x-frame-options",
	"referrer-policy",
	"x-xss-protection",
	"content-security-policy",
	"strict-transport-security",
	"permissions-policy",
	"cross-origin-opener-policy",
	"cross-origin-resource-policy",
	"cross-origin-embedder-policy",
]

/** The security headers an answer carries, by name, only those present. */
const security = (res: Response) =>
	Object.fromEntries(SECURITY.flatMap((name) => (res.headers.has(name) ? [[name, res.headers.get(name)]] : [])))

async function answer(options?: SecureHeadersOptions, path = "/json") {
	const app = honey<{}>()
	const guarded = app.use(secureHeaders(options))
	guarded.get("/json").handler((ctx) => ctx.res.json("ok", { ok: true }))
	guarded.get("/strict").handler((ctx) =>
		ctx.res.text("ok", "x", {
			headers: { "content-security-policy": "default-src 'none'", "x-frame-options": "DENY" },
		}),
	)
	guarded.get("/stream").handler((ctx) =>
		ctx.res.stream(async (writable) => {
			await writable.getWriter().close()
		}),
	)
	guarded.get("/moved").handler(() => Response.redirect("https://elsewhere.example/", 302) as never)
	guarded.get("/empty").handler(() => new Response(null, { status: 204 }) as never)
	return app.fetch(new Request(`https://app.example.com${path}`), {})
}

const DEFAULTS = {
	"referrer-policy": "strict-origin-when-cross-origin",
	"x-content-type-options": "nosniff",
	"x-frame-options": "SAMEORIGIN",
	"x-xss-protection": "0",
}

describe("secureHeaders(): the defaults", () => {
	// v0: 4b8bbde3d6
	// v0: dd9ba136da
	// v0: 6cb421e867
	// v0: 22e8d2ffbe
	// v0: 7acebafc0f
	// v0: 2235ef111a
	// v0: a7d03a9411
	// v0: c273ed7794
	it("nosniff, SAMEORIGIN, a strict referrer policy and the XSS auditor off; no CSP or HSTS unless configured", async () => {
		expect(security(await answer())).toEqual(DEFAULTS)
	})

	// v0: ef78c9cb54
	// v0: 87c015322b
	// v0: be0e1c780e
	// v0: 0b0d0aa1d3
	it.each([
		["a JSON answer", "/json"],
		["a streamed answer", "/stream"],
		["a redirect with immutable headers", "/moved"],
		["a 204 with no body", "/empty"],
	])("on %s", async (_name, path) => {
		expect(security(await answer(undefined, path))).toEqual(DEFAULTS)
	})
})

describe("secureHeaders(): options", () => {
	// v0: 0b0590c49e
	// v0: 65747455ba
	// v0: ffa371345d
	// v0: e86a5603f0
	// v0: f0afa6c32f
	// v0: 3134d9fbf6
	it.each([
		[
			"a custom X-Frame-Options replaces the default",
			{ xFrameOptions: "DENY" },
			{ ...DEFAULTS, "x-frame-options": "DENY" },
		],
		[
			"false opts out of each default",
			{ referrerPolicy: false, xContentTypeOptions: false, xFrameOptions: false, xXssProtection: false },
			{},
		],
	] as const)("%s", async (_name, options, headers) => {
		expect(security(await answer(options))).toEqual(headers)
	})

	// v0: 56f9c49aac
	// v0: 5f7f9d5052
	it("CSP, HSTS, permissions and the cross-origin policies are set when configured", async () => {
		const configured = {
			contentSecurityPolicy: "default-src 'self'",
			crossOriginEmbedderPolicy: "require-corp",
			crossOriginOpenerPolicy: "same-origin",
			crossOriginResourcePolicy: "same-site",
			permissionsPolicy: "camera=()",
			strictTransportSecurity: "max-age=63072000; includeSubDomains",
		}
		expect(security(await answer(configured))).toEqual({
			...DEFAULTS,
			"content-security-policy": "default-src 'self'",
			"cross-origin-embedder-policy": "require-corp",
			"cross-origin-opener-policy": "same-origin",
			"cross-origin-resource-policy": "same-site",
			"permissions-policy": "camera=()",
			"strict-transport-security": "max-age=63072000; includeSubDomains",
		})
	})
})

describe("secureHeaders(): a handler's own headers win", () => {
	// v0: d26d351e4c
	// v0: 55168e1be0
	it("never loosens a stricter CSP or X-Frame-Options the handler set", async () => {
		const res = await answer({ contentSecurityPolicy: "default-src *", xFrameOptions: "SAMEORIGIN" }, "/strict")
		expect([res.headers.get("content-security-policy"), res.headers.get("x-frame-options")]).toEqual([
			"default-src 'none'",
			"DENY",
		])
	})
})
