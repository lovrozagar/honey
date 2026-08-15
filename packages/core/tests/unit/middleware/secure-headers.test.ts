import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"
import { secureHeaders } from "../../../src/secure-headers.ts"

function makeApp(opts?: Parameters<typeof secureHeaders>[0]) {
	const app = honey<{}>().use(secureHeaders(opts))
	app.get("/test").handler((ctx) => ctx.res.json("ok", { ok: true }))
	return app
}

describe("secure-headers middleware — internal", () => {
	it("default config → X-Content-Type-Options: nosniff", async () => {
		const app = makeApp()
		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.headers.get("x-content-type-options")).toBe("nosniff")
	})

	it("default config → X-Frame-Options: SAMEORIGIN", async () => {
		const app = makeApp()
		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN")
	})

	it("default config → Referrer-Policy", async () => {
		const app = makeApp()
		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin")
	})

	it("default config → X-XSS-Protection: 0", async () => {
		const app = makeApp()
		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.headers.get("x-xss-protection")).toBe("0")
	})

	it("custom xFrameOptions overrides default", async () => {
		const app = makeApp({ xFrameOptions: "DENY" })
		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.headers.get("x-frame-options")).toBe("DENY")
	})

	it("CSP only set if configured", async () => {
		const noCSP = makeApp()
		const res1 = await noCSP.fetch(new Request("http://localhost/test"), {})
		expect(res1.headers.get("content-security-policy")).toBeNull()

		const withCSP = makeApp({ contentSecurityPolicy: "default-src 'self'" })
		const res2 = await withCSP.fetch(new Request("http://localhost/test"), {})
		expect(res2.headers.get("content-security-policy")).toBe("default-src 'self'")
	})

	it("HSTS only set if configured", async () => {
		const noHSTS = makeApp()
		const res1 = await noHSTS.fetch(new Request("http://localhost/test"), {})
		expect(res1.headers.get("strict-transport-security")).toBeNull()

		const withHSTS = makeApp({ strictTransportSecurity: "max-age=31536000" })
		const res2 = await withHSTS.fetch(new Request("http://localhost/test"), {})
		expect(res2.headers.get("strict-transport-security")).toBe("max-age=31536000")
	})

	it("handler-set headers preserved", async () => {
		const app = honey<{}>().use(secureHeaders())
		app.get("/test").handler((ctx) => ctx.res.json("ok", {}, { headers: { "x-custom": "mine" } }))
		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.headers.get("x-custom")).toBe("mine")
		expect(res.headers.get("x-content-type-options")).toBe("nosniff")
	})

	it("false value opts out of a default header", async () => {
		const app = makeApp({ xFrameOptions: false })
		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.headers.get("x-frame-options")).toBeNull()
		/* other defaults still present */
		expect(res.headers.get("x-content-type-options")).toBe("nosniff")
	})
})

describe("secure-headers middleware — consumer", () => {
	it("all default security headers on every response", async () => {
		const app = makeApp()
		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("x-content-type-options")).toBeTruthy()
		expect(res.headers.get("x-frame-options")).toBeTruthy()
		expect(res.headers.get("referrer-policy")).toBeTruthy()
	})
})
