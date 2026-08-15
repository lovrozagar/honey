import { describe, expect, it } from "vitest"
import "honey/openapi"
import { honey } from "../../../src/index.ts"

describe("Honey.manifest()", () => {
	it("serves a route manifest at /manifest.json", async () => {
		const app = honey()
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		app.manifest()

		const res = await app.fetch(new Request("http://x/manifest.json"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toMatch(/json/)
		const body = (await res.json()) as {
			errors: unknown[]
			routes: Array<{ method: string; path: string }>
		}
		expect(Array.isArray(body.routes)).toBe(true)
		expect(Array.isArray(body.errors)).toBe(true)
		expect(body.routes.some((r) => r.method === "GET" && r.path === "/health")).toBe(true)
	})

	it("respects basePath", async () => {
		const app = honey().basePath("/api")
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		app.manifest()
		const res = await app.fetch(new Request("http://x/api/manifest.json"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as { routes: Array<{ path: string }> }
		expect(body.routes.some((r) => r.path === "/api/health")).toBe(true)
	})

	it("honors a custom path", async () => {
		const app = honey()
		app.manifest({ path: "/_meta/routes" })
		const res = await app.fetch(new Request("http://x/_meta/routes"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as { routes: unknown[] }
		expect(Array.isArray(body.routes)).toBe(true)
	})

	it("excludes the manifest endpoint from generateOpenApi and generateManifest", async () => {
		const { generateManifest, generateOpenApi } = await import("../../../src/codegen.ts")
		const app = honey()
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		app.manifest()

		const spec = await generateOpenApi(app, { info: { title: "Demo", version: "1" } })
		expect(spec.paths["/health"]).toBeDefined()
		expect(spec.paths["/manifest.json"]).toBeUndefined()

		const paths = generateManifest(app).routes.map((r) => r.path)
		expect(paths).toContain("/health")
		expect(paths).not.toContain("/manifest.json")

		const served = await app.fetch(new Request("http://x/manifest.json"), {})
		const body = (await served.json()) as { routes: Array<{ path: string }> }
		expect(body.routes.some((r) => r.path === "/health")).toBe(true)
		expect(body.routes.some((r) => r.path === "/manifest.json")).toBe(false)
	})

	it("includes routes registered after the first manifest request", async () => {
		const app = honey()
		app.get("/a").handler((ctx) => ctx.res.text("ok", "ok"))
		app.manifest()

		const first = (await (
			await app.fetch(new Request("http://x/manifest.json"), {})
		).json()) as { routes: Array<{ path: string }> }
		expect(first.routes.some((r) => r.path === "/a")).toBe(true)
		expect(first.routes.some((r) => r.path === "/b")).toBe(false)

		app.get("/b").handler((ctx) => ctx.res.text("ok", "ok"))
		const second = (await (
			await app.fetch(new Request("http://x/manifest.json"), {})
		).json()) as { routes: Array<{ path: string }> }
		expect(second.routes.some((r) => r.path === "/a")).toBe(true)
		expect(second.routes.some((r) => r.path === "/b")).toBe(true)
	})
})
