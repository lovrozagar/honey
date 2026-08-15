import { describe, expect, it } from "vitest"
import "@lovrozagar/honey/openapi"
import { honey } from "../../../src/index.ts"
import { cors } from "../../../src/cors.ts"

function preflight(path: string, requestMethod = "GET"): Request {
	return new Request(`http://x${path}`, {
		headers: {
			"access-control-request-method": requestMethod,
			origin: "http://app.example",
		},
		method: "OPTIONS",
	})
}

describe("CORS preflight on method-specific routes", () => {
	it("OPTIONS + AC-Request-Method on a GET route with cors → 204", async () => {
		const app = honey().use(cors({ origin: "*" }))
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(preflight("/health"), {})
		expect(res.status).toBe(204)
		expect(res.headers.get("access-control-allow-origin")).toBe("*")
		expect(res.headers.get("access-control-allow-methods")).toBeTruthy()
	})

	it("GET still works after preflight dispatch", async () => {
		const app = honey().use(cors({ origin: "*" }))
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		await app.fetch(preflight("/health"), {})
		const res = await app.fetch(new Request("http://x/health", { headers: { origin: "http://app.example" } }), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("ok")
	})

	it("OPTIONS without AC-Request-Method stays 405", async () => {
		const app = honey().use(cors({ origin: "*" }))
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		const res = await app.fetch(
			new Request("http://x/health", {
				headers: { origin: "http://app.example" },
				method: "OPTIONS",
			}),
			{},
		)
		expect(res.status).toBe(405)
		expect(res.headers.get("allow")).toContain("GET")
	})

	it("preflight without cors stays 405 and does not run the GET handler", async () => {
		const app = honey()
		let ran = 0
		app.get("/health").handler((ctx) => {
			ran += 1
			return ctx.res.text("ok", "ok")
		})
		const res = await app.fetch(preflight("/health"), {})
		expect(res.status).toBe(405)
		expect(ran).toBe(0)
	})

	it("preflight on a POST-only cors route → 204", async () => {
		const app = honey().use(cors({ origin: "*" }))
		app.post("/users").handler((ctx) => ctx.res.json("ok", { ok: true }))
		const res = await app.fetch(preflight("/users", "POST"), {})
		expect(res.status).toBe(204)
		expect(res.headers.get("access-control-allow-origin")).toBe("*")
	})

	it("preflight on an unknown path stays 404 when cors is on a child chain", async () => {
		const app = honey()
		const corsed = app.use(cors({ origin: "*" }))
		corsed.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		const res = await app.fetch(preflight("/missing"), {})
		expect(res.status).toBe(404)
	})

	it("parent fetch + child cors param route preflight → 204", async () => {
		const app = honey()
		const corsed = app.use(cors({ origin: "*" }))
		corsed.get("/users/:id").handler((ctx) => ctx.res.text("ok", ctx.params.id))
		const res = await app.fetch(preflight("/users/7"), {})
		expect(res.status).toBe(204)
		expect(res.headers.get("access-control-allow-origin")).toBe("*")
	})

	it("parent fetch + child cors GET route → 204 (e2e pattern)", async () => {
		const app = honey()
		const corsed = app.use(cors({ origin: "*" }))
		corsed.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		const res = await app.fetch(preflight("/health"), {})
		expect(res.status).toBe(204)
		expect(res.headers.get("access-control-allow-origin")).toBe("*")
	})

	it("parent fetch + child openapi() → 204 on spec and docs", async () => {
		const app = honey()
		const corsed = app.use(cors({ origin: "*" }))
		corsed.openapi({ docs: "scalar", title: "Demo", version: "1" })
		expect((await app.fetch(preflight("/openapi.json"), {})).status).toBe(204)
		expect((await app.fetch(preflight("/docs"), {})).status).toBe(204)
	})

	it("preflight respects basePath", async () => {
		const app = honey()
			.basePath("/api")
			.use(cors({ origin: "*" }))
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		const res = await app.fetch(preflight("/api/health"), {})
		expect(res.status).toBe(204)
	})

	it("preflight on openapi() spec and docs routes → 204", async () => {
		const app = honey().use(cors({ origin: "*" }))
		app.openapi({ docs: "scalar", title: "Demo", version: "1" })
		const spec = await app.fetch(preflight("/openapi.json"), {})
		expect(spec.status).toBe(204)
		const docs = await app.fetch(preflight("/docs"), {})
		expect(docs.status).toBe(204)
	})

	it("does not run the GET handler when cors allows the preflight", async () => {
		const app = honey().use(cors({ origin: "*" }))
		let ran = 0
		app.get("/health").handler((ctx) => {
			ran += 1
			return ctx.res.text("ok", "ok")
		})
		const res = await app.fetch(preflight("/health"), {})
		expect(res.status).toBe(204)
		expect(ran).toBe(0)
	})
})
