import { describe, expect, it } from "vitest"
import { csrf } from "../../../src/csrf.ts"
import { honey } from "../../../src/index.ts"

function makeApp(csrfOpts?: Parameters<typeof csrf>[0]) {
	const app = honey<{}>().use(csrf(csrfOpts))
	app.post("/action").handler((ctx) => ctx.res.json("ok", { done: true }))
	app.get("/read").handler((ctx) => ctx.res.text("ok", "ok"))
	return app
}

function formPost(url: string, headers: Record<string, string> = {}) {
	return new Request(url, {
		body: "key=value",
		headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
		method: "POST",
	})
}

describe("csrf middleware — internal", () => {
	it("POST with Sec-Fetch-Site: cross-site + form content-type → 403", async () => {
		const app = makeApp()
		const res = await app.fetch(
			formPost("http://localhost/action", { "sec-fetch-site": "cross-site" }),
			{},
		)
		expect(res.status).toBe(403)
	})

	it("POST with Sec-Fetch-Site: same-origin → allowed", async () => {
		const app = makeApp()
		const res = await app.fetch(
			formPost("http://localhost/action", { "sec-fetch-site": "same-origin" }),
			{},
		)
		expect(res.status).toBe(200)
	})

	it("POST with no Sec-Fetch-Site but matching Origin → allowed", async () => {
		const app = makeApp({ origin: "http://localhost" })
		const res = await app.fetch(
			formPost("http://localhost/action", { origin: "http://localhost" }),
			{},
		)
		expect(res.status).toBe(200)
	})

	it("POST with no Sec-Fetch-Site and wrong Origin → 403", async () => {
		const app = makeApp({ origin: "http://localhost" })
		const res = await app.fetch(
			formPost("http://localhost/action", { origin: "http://evil.com" }),
			{},
		)
		expect(res.status).toBe(403)
	})

	it("POST with Content-Type: application/json → allowed (skipped)", async () => {
		const app = makeApp()
		const res = await app.fetch(
			new Request("http://localhost/action", {
				body: "{}",
				headers: {
					"content-type": "application/json",
					"sec-fetch-site": "cross-site",
				},
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
	})

	it("GET → always allowed regardless of origin", async () => {
		const app = makeApp()
		const res = await app.fetch(
			new Request("http://localhost/read", {
				headers: { "sec-fetch-site": "cross-site" },
			}),
			{},
		)
		expect(res.status).toBe(200)
	})

	it("HEAD → always allowed", async () => {
		const app = makeApp()
		app.head("/read").handler((ctx) => ctx.res.noContent())
		const res = await app.fetch(
			new Request("http://localhost/read", {
				headers: { "sec-fetch-site": "cross-site" },
				method: "HEAD",
			}),
			{},
		)
		expect(res.status).toBe(204)
	})

	it("OPTIONS → always allowed", async () => {
		const app = makeApp()
		app.options("/action").handler((ctx) => ctx.res.noContent())
		const res = await app.fetch(
			new Request("http://localhost/action", {
				headers: { "sec-fetch-site": "cross-site" },
				method: "OPTIONS",
			}),
			{},
		)
		expect(res.status).toBe(204)
	})

	it("POST with text/plain from cross-origin → 403", async () => {
		const app = makeApp()
		const res = await app.fetch(
			new Request("http://localhost/action", {
				body: "plain",
				headers: {
					"content-type": "text/plain",
					"sec-fetch-site": "cross-site",
				},
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(403)
	})

	it("multipart/form-data from cross-origin → 403", async () => {
		const app = makeApp()
		const formData = new FormData()
		formData.set("key", "val")
		const req = new Request("http://localhost/action", {
			body: formData,
			method: "POST",
		})
		req.headers.set("sec-fetch-site", "cross-site")
		const res = await app.fetch(req, {})
		expect(res.status).toBe(403)
	})

	it("origin as string array → matching any allowed", async () => {
		const app = makeApp({ origin: ["http://a.com", "http://b.com"] })
		const res = await app.fetch(formPost("http://localhost/action", { origin: "http://b.com" }), {})
		expect(res.status).toBe(200)
	})

	it("origin as function → called with origin string", async () => {
		const app = makeApp({ origin: (o) => o.endsWith(".myapp.com") })
		const res = await app.fetch(
			formPost("http://localhost/action", { origin: "http://admin.myapp.com" }),
			{},
		)
		expect(res.status).toBe(200)
	})

	it("no Origin header, no Sec-Fetch-Site → 403", async () => {
		const app = makeApp()
		const res = await app.fetch(formPost("http://localhost/action"), {})
		expect(res.status).toBe(403)
	})
})

describe("csrf middleware — consumer", () => {
	it("cross-origin form POST → 403 with forbidden error_key", async () => {
		const app = makeApp()
		const res = await app.fetch(
			formPost("http://localhost/action", { "sec-fetch-site": "cross-site" }),
			{},
		)
		expect(res.status).toBe(403)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("forbidden")
	})

	it("same-origin form POST → allowed", async () => {
		const app = makeApp()
		const res = await app.fetch(
			formPost("http://localhost/action", { "sec-fetch-site": "same-origin" }),
			{},
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.done).toBe(true)
	})

	it("JSON API POST from any origin → allowed", async () => {
		const app = makeApp()
		const res = await app.fetch(
			new Request("http://localhost/action", {
				body: "{}",
				headers: {
					"content-type": "application/json",
					origin: "http://evil.com",
					"sec-fetch-site": "cross-site",
				},
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
	})
})
