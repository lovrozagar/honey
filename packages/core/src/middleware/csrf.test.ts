import { describe, expect, it } from "vitest"
import * as z from "zod"
import { defineErrors } from "../errors/errors.ts"
import { honey } from "../routing/app.ts"
import { cors } from "./cors.ts"
import { createMiddleware } from "./middleware.ts"
import { csrf, type CSRFOptions } from "./csrf.ts"

const SELF = "https://app.example.com"

/** POST/PUT/PATCH/DELETE/GET/HEAD/OPTIONS on /orders behind csrf(options). */
function guarded(options?: CSRFOptions) {
	const app = honey<{}>()
	const protectedRoutes = app.use(csrf(options))
	for (const method of ["get", "post", "put", "patch", "delete", "options"] as const) {
		protectedRoutes[method]("/orders").handler((ctx) => ctx.res.text("ok", method))
	}
	return app
}

async function status(app: ReturnType<typeof guarded>, method: string, headers: Record<string, string> = {}) {
	const res = await app.fetch(new Request(`${SELF}/orders`, { headers, method }), {})
	return res.status
}

describe("csrf(): safe methods and same-origin requests pass", () => {
	// v0: be34283fb1
	// v0: b77973fcef
	// v0: e0ae570358
	// v0: 649fd1ce59
	// v0: 68e85e700f
	// v0: cababb0255
	// v0: cc1cd59615
	it.each(["GET", "HEAD", "OPTIONS"])("%s passes even from a foreign site", async (method) => {
		expect(await status(guarded(), method, { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).toBe(
			200,
		)
	})

	// v0: 903cd0025c
	// v0: 706d3344e4
	// v0: 549054f4c0
	// v0: eebd6a6fb0
	// v0: a6a27d4bd1
	// v0: f2e2b4e97c
	// v0: d5c148ebe0
	// v0: 99f470e4ed
	// v0: abc2dd2484
	// v0: 30903e23a5
	// v0: 4096916f65
	it.each([
		[
			"Sec-Fetch-Site: same-origin, any content type",
			{ "content-type": "text/plain", "sec-fetch-site": "same-origin" },
		],
		["Sec-Fetch-Site: none (user-initiated)", { "sec-fetch-site": "none" }],
		["no Sec-Fetch-Site, an Origin on this host", { origin: SELF }],
		["no Sec-Fetch-Site, no Origin (curl, a server)", { "content-type": "application/json" }],
		// v0: ace43c394c
		["no Content-Type and no browser headers (a webhook)", {}],
	])("a POST with %s passes", async (_name, headers) => {
		expect(await status(guarded(), "POST", headers)).toBe(200)
	})
})

describe("csrf(): a cross-origin unsafe request is refused, whatever its content type", () => {
	// v0: 3d08c0bdf6
	// v0: 8d770286e6
	// v0: ab9860322e
	// v0: 02d8c34d9f
	// v0: abdf57a2ae
	// v0: ee54f68083
	// v0: e020405352
	// v0: f2ff7233e2
	// v0: b2721508b7
	// v0: 358099773a
	// v0: cf90c2000e
	// v0: 3f98d21900
	it.each([
		[
			"cross-site, a form",
			{
				"content-type": "application/x-www-form-urlencoded",
				origin: "https://evil.example",
				"sec-fetch-site": "cross-site",
			},
		],
		[
			"cross-site, JSON",
			{ "content-type": "application/json", origin: "https://evil.example", "sec-fetch-site": "cross-site" },
		],
		[
			"cross-site, text/plain",
			{ "content-type": "text/plain", origin: "https://evil.example", "sec-fetch-site": "cross-site" },
		],
		[
			"cross-site, multipart",
			{
				"content-type": "multipart/form-data; boundary=x",
				origin: "https://evil.example",
				"sec-fetch-site": "cross-site",
			},
		],
		["cross-site, no content type at all", { origin: "https://evil.example", "sec-fetch-site": "cross-site" }],
		["no Sec-Fetch-Site, a foreign Origin", { origin: "https://evil.example" }],
		["no Sec-Fetch-Site, the opaque Origin null", { origin: "null" }],
		["no Sec-Fetch-Site, an Origin that is no URL", { origin: "not a url" }],
	])("%s → 403", async (_name, headers) => {
		expect(await status(guarded(), "POST", headers)).toBe(403)
	})
})

describe("csrf(): every unsafe method, and same-site is not same-origin", () => {
	// v0: c2a5fd6e65
	// v0: f2c7f82951
	// v0: 52a45fddbe
	// v0: 1f1358df72
	it.each(["PUT", "PATCH", "DELETE"])("%s is checked as POST is", async (method) => {
		expect(await status(guarded(), method, { origin: "https://evil.example" })).toBe(403)
	})

	// v0: d11da3c26e
	// v0: c0e33dddf0
	// v0: 745379581d
	it("a sibling subdomain is same-site, not same-origin: refused unless allow-listed", async () => {
		const sibling = { origin: "https://admin.example.com", "sec-fetch-site": "same-site" }
		expect([
			await status(guarded(), "POST", sibling),
			await status(guarded({ origin: "https://admin.example.com" }), "POST", sibling),
		]).toEqual([403, 200])
	})
})

describe("csrf(): the allow-list", () => {
	// v0: e463bd9f5f
	// v0: 3e3e42cc4b
	// v0: 9eaa4a1716
	// v0: 254cd64561
	// v0: a07f6bb890
	// v0: 9cf77717d2
	// v0: bd57e031c4
	// v0: 22c46a4c20
	// v0: a234cfcb6d
	// v0: 6041723a91
	it.each([
		["a string", "https://partner.example", "https://partner.example", 200],
		["a list", ["https://a.example", "https://partner.example"], "https://partner.example", 200],
		["a predicate", (origin: string) => origin.endsWith(".partner.example"), "https://x.partner.example", 200],
		["a string is exact, not a prefix", "https://partner.example", "https://partner.example.evil.net", 403],
		["a list is exact, not a suffix", ["https://partner.example"], "https://evil-partner.example", 403],
	] as const)("%s", async (_name, allow, origin, expected) => {
		const app = guarded({ origin: allow as CSRFOptions["origin"] })
		const [withSite, withoutSite] = [
			await status(app, "POST", { origin, "sec-fetch-site": "cross-site" }),
			await status(app, "POST", { origin }),
		]
		expect([withSite, withoutSite]).toEqual([expected, expected])
	})
})

describe("csrf(): its refusal is a declared 403", () => {
	// v0: 4c0e33dd75
	// v0: 1bda13e2e9
	// v0: d96839e5ee
	// v0: b57d79d37b
	it("a forbidden error, also under an app error factory with default errors", async () => {
		const errors = defineErrors({ teapot: "bad_request" })
		const app = honey<{}>().errorFactory(errors).defaultErrors("teapot")
		app
			.use(csrf())
			.post("/orders")
			.handler((ctx) => ctx.res.text("ok", "x"))
		const res = await app.fetch(
			new Request(`${SELF}/orders`, { headers: { origin: "https://evil.example" }, method: "POST" }),
			{},
		)
		expect([res.status, ((await res.json()) as { error_key: string }).error_key, csrf().errors]).toEqual([
			403,
			"forbidden",
			["forbidden"],
		])
	})

	// v0: 040db204a1
	it("covers routes a mounted sub-app brings", async () => {
		const sub = honey<{}>()
		sub.post("/items").handler((ctx) => ctx.res.text("ok", "x"))
		const app = honey<{}>()
		app.use(csrf()).route("/shop", sub)
		const res = await app.fetch(
			new Request(`${SELF}/shop/items`, { headers: { origin: "https://evil.example" }, method: "POST" }),
			{},
		)
		expect(res.status).toBe(403)
	})
})

describe("csrf() beside cors()", () => {
	// v0: 370dfb9411
	// v0: b128b6e675
	// v0: 760e9c7448
	// v0: a055816429
	it("a preflight is cors's to answer; an allowed cross-origin POST passes both; a foreign one is refused", async () => {
		const partner = "https://partner.example"
		const app = honey<{}>()
		app
			.use(cors({ origin: partner }))
			.use(csrf({ origin: partner }))
			.post("/orders")
			.handler((ctx) => ctx.res.text("ok", "x"))
		const send = (method: string, headers: Record<string, string>) =>
			app.fetch(new Request(`${SELF}/orders`, { headers, method }), {})
		const preflight = await send("OPTIONS", { "access-control-request-method": "POST", origin: partner })
		const allowed = await send("POST", { origin: partner, "sec-fetch-site": "cross-site" })
		const foreign = await send("POST", { origin: "https://evil.example", "sec-fetch-site": "cross-site" })
		expect([
			preflight.status,
			allowed.status,
			allowed.headers.get("access-control-allow-origin"),
			foreign.status,
		]).toEqual([204, 200, partner, 403])
	})
})

describe("csrf()'s refusal beside other errors in the chain", () => {
	/** Middleware that copies the answer and sets x-outer, as outer post-next() code does. */
	const stamp = createMiddleware(async (_ctx, next) => {
		const res = await next()
		const out = new Response(res.body, res)
		out.headers.set("x-outer", "1")
		return out
	})

	// v0: a436c055db
	it("csrf, a refused .input() and a handler throw all keep the outer middleware's headers", async () => {
		const app = honey<{}>()
			.use(stamp)
			.use(csrf({ origin: "https://app.example" }))
		app.post("/form").handler((ctx) => ctx.res.text("ok", "x"))
		app
			.post("/json")
			.input({ json: z.object({ n: z.number() }) })
			.handler((ctx) => ctx.res.json("ok", ctx.input.json))
		app.get("/boom").handler(() => {
			throw new Error("boom")
		})
		const form = {
			body: "a=1",
			headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
		}
		const answers = await Promise.all([
			app.fetch(new Request("http://localhost/form", { ...form, method: "POST" }), {}),
			app.fetch(
				new Request("http://localhost/json", {
					body: '{"n":"x"}',
					headers: { "content-type": "application/json" },
					method: "POST",
				}),
				{},
			),
			app.fetch(new Request("http://localhost/boom"), {}),
		])
		expect(answers.map((res) => [res.status, res.headers.get("x-outer")])).toEqual([
			[403, "1"],
			[400, "1"],
			[500, "1"],
		])
	})
})
