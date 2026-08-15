import { describe, expect, it } from "vitest"
import "@lovrozagar/honey/openapi"
import { honey } from "../../../src/index.ts"

describe("Honey.openapi()", () => {
	it("serves JSON and identical YAML aliases", async () => {
		const app = honey()
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		app.openapi({ title: "Demo", version: "1.0.0" })

		const jsonRes = await app.fetch(new Request("http://x/openapi.json"), {})
		expect(jsonRes.status).toBe(200)
		expect(jsonRes.headers.get("content-type")).toMatch(/json/)
		const spec = (await jsonRes.json()) as {
			info: { title: string; version: string }
			openapi: string
			paths: Record<string, unknown>
		}
		expect(spec.openapi).toBe("3.1.0")
		expect(spec.info.title).toBe("Demo")
		expect(spec.info.version).toBe("1.0.0")
		expect(spec.paths["/health"]).toBeDefined()

		const ymlRes = await app.fetch(new Request("http://x/openapi.yml"), {})
		const yamlRes = await app.fetch(new Request("http://x/openapi.yaml"), {})
		expect(ymlRes.status).toBe(200)
		expect(yamlRes.status).toBe(200)
		expect(ymlRes.headers.get("content-type")).toMatch(/yaml/)
		expect(yamlRes.headers.get("content-type")).toMatch(/yaml/)
		const ymlText = await ymlRes.text()
		expect(ymlText).toBe(await yamlRes.text())
		expect(ymlText).toMatch(/openapi:\s*"?3\.1\.0"?/)
		expect(ymlText).toContain("Demo")
		expect(ymlText).toContain("/health")
	})

	it("respects basePath", async () => {
		const app = honey().basePath("/api")
		app.openapi({ title: "Api", version: "2" })
		const res = await app.fetch(new Request("http://x/api/openapi.json"), {})
		expect(res.status).toBe(200)
		const spec = (await res.json()) as { info: { title: string } }
		expect(spec.info.title).toBe("Api")
	})

	it("honors a custom path stem", async () => {
		const app = honey()
		app.openapi({ path: "/docs/spec", title: "Docs", version: "1" })
		const res = await app.fetch(new Request("http://x/docs/spec.yaml"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toContain("Docs")
	})

	it("excludes spec endpoints from the generated document and manifest", async () => {
		const { generateManifest, generateOpenApi } = await import("../../../src/codegen.ts")
		const app = honey()
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		app.openapi({ title: "Demo", version: "1.0.0" })

		const spec = await generateOpenApi(app, { info: { title: "Demo", version: "1.0.0" } })
		expect(spec.paths["/health"]).toBeDefined()
		expect(spec.paths["/openapi.json"]).toBeUndefined()
		expect(spec.paths["/openapi.yml"]).toBeUndefined()
		expect(spec.paths["/openapi.yaml"]).toBeUndefined()

		const served = await app.fetch(new Request("http://x/openapi.json"), {})
		const body = (await served.json()) as { paths: Record<string, unknown> }
		expect(body.paths["/health"]).toBeDefined()
		expect(body.paths["/openapi.json"]).toBeUndefined()
		expect(body.paths["/openapi.yml"]).toBeUndefined()
		expect(body.paths["/openapi.yaml"]).toBeUndefined()

		const paths = generateManifest(app).routes.map((r) => r.path)
		expect(paths).toContain("/health")
		expect(paths).not.toContain("/openapi.json")
		expect(paths).not.toContain("/openapi.yml")
		expect(paths).not.toContain("/openapi.yaml")
	})

	it("does not mount a docs UI unless docs is set", async () => {
		const app = honey()
		app.openapi({ title: "Demo", version: "1" })
		const res = await app.fetch(new Request("http://x/docs"), {})
		expect(res.status).toBe(404)
	})

	it('docs: "scalar" serves HTML at /docs pointing at the JSON spec', async () => {
		const app = honey()
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		app.openapi({ docs: "scalar", title: "Demo", version: "1" })

		const res = await app.fetch(new Request("http://x/docs"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toMatch(/html/)
		const html = await res.text()
		expect(html).toContain("cdn.jsdelivr.net/npm/@scalar/api-reference")
		expect(html).toContain("/openapi.json")
	})

	it('docs: "swagger" serves HTML at /docs pointing at the JSON spec', async () => {
		const app = honey()
		app.openapi({ docs: "swagger", title: "Demo", version: "1" })
		const res = await app.fetch(new Request("http://x/docs"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toMatch(/html/)
		const html = await res.text()
		expect(html).toContain("unpkg.com/swagger-ui-dist")
		expect(html).toContain("/openapi.json")
	})

	it("honors docsPath and prefixes the spec URL with basePath", async () => {
		const app = honey().basePath("/api")
		app.openapi({ docs: "scalar", docsPath: "/reference", title: "Api", version: "2" })
		const res = await app.fetch(new Request("http://x/api/reference"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toContain("/api/openapi.json")
	})

	it("does not steal a user GET /docs — Scalar falls back to /reference", async () => {
		const app = honey()
			.get("/docs")
			.handler((ctx) => ctx.res.text("ok", "user-docs"))
		expect(() => app.openapi({ docs: "scalar", title: "Demo", version: "1" })).not.toThrow()

		const user = await app.fetch(new Request("http://x/docs"), {})
		expect(user.status).toBe(200)
		expect(await user.text()).toBe("user-docs")

		const ui = await app.fetch(new Request("http://x/reference"), {})
		expect(ui.status).toBe(200)
		expect(await ui.text()).toContain("scalar")
	})

	it("openapi() twice is idempotent", async () => {
		const app = honey()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "ok"))
		app.openapi({ docs: "scalar", title: "Demo", version: "1" })
		expect(() => app.openapi({ docs: "scalar", title: "Demo", version: "1" })).not.toThrow()
		const res = await app.fetch(new Request("http://x/docs"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toContain("scalar")
	})

	it("explicit docsPath collision throws a clear error", () => {
		const app = honey()
			.get("/docs")
			.handler((ctx) => ctx.res.text("ok", "user-docs"))
		expect(() =>
			app.openapi({ docs: "scalar", docsPath: "/docs", title: "Demo", version: "1" }),
		).toThrow(/docsPath|already registered|\/docs/i)
	})

	it("route() of two apps that both called openapi() keeps one docs UI", async () => {
		const a = honey()
			.get("/a")
			.handler((ctx) => ctx.res.text("ok", "a"))
		a.openapi({ docs: "scalar", title: "A", version: "1" })
		const b = honey()
			.get("/b")
			.handler((ctx) => ctx.res.text("ok", "b"))
		b.openapi({ docs: "scalar", title: "B", version: "1" })
		expect(() => a.route(b)).not.toThrow()
		expect((await a.fetch(new Request("http://x/a"), {})).status).toBe(200)
		expect((await a.fetch(new Request("http://x/b"), {})).status).toBe(200)
		expect((await a.fetch(new Request("http://x/docs"), {})).status).toBe(200)
	})

	it("compose from a shared base then openapi() does not throw", async () => {
		const base = honey()
		const a = base.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		const b = base.get("/docs").handler((ctx) => ctx.res.text("ok", "user-docs"))
		const app = a.route(b)
		expect(() => app.openapi({ docs: "scalar", title: "Demo", version: "1" })).not.toThrow()
		expect(await (await app.fetch(new Request("http://x/docs"), {})).text()).toBe("user-docs")
		const ui = await app.fetch(new Request("http://x/reference"), {})
		expect(ui.status).toBe(200)
		expect(await ui.text()).toContain("scalar")
	})

	it("excludes the docs route from the generated document", async () => {
		const { generateOpenApi } = await import("../../../src/codegen.ts")
		const app = honey()
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		app.openapi({ docs: "scalar", title: "Demo", version: "1" })
		const spec = await generateOpenApi(app, { info: { title: "Demo", version: "1" } })
		expect(spec.paths["/docs"]).toBeUndefined()
		expect(spec.paths["/health"]).toBeDefined()
	})

	it("includes routes registered after the first spec request", async () => {
		const app = honey()
		app.get("/a").handler((ctx) => ctx.res.text("ok", "ok"))
		app.openapi({ title: "Demo", version: "1" })

		const first = await app.fetch(new Request("http://x/openapi.json"), {})
		const spec1 = (await first.json()) as { paths: Record<string, unknown> }
		expect(spec1.paths["/a"]).toBeDefined()
		expect(spec1.paths["/b"]).toBeUndefined()

		app.get("/b").handler((ctx) => ctx.res.text("ok", "ok"))
		const second = await app.fetch(new Request("http://x/openapi.json"), {})
		expect(second.status).toBe(200)
		const spec2 = (await second.json()) as { paths: Record<string, unknown> }
		expect(spec2.paths["/a"]).toBeDefined()
		expect(spec2.paths["/b"]).toBeDefined()

		const yaml = await app.fetch(new Request("http://x/openapi.yaml"), {})
		expect(await yaml.text()).toContain("/b")
	})

	it("retries generate after a failed spec request", async () => {
		const app = honey()
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		let shouldThrow = true
		app.openapi({
			filterRoutes: () => {
				if (shouldThrow) throw new Error("codegen boom")
				return true
			},
			title: "Demo",
			version: "1",
		})

		const fail = await app.fetch(new Request("http://x/openapi.json"), {})
		expect(fail.status).toBeGreaterThanOrEqual(500)

		shouldThrow = false
		const ok = await app.fetch(new Request("http://x/openapi.json"), {})
		expect(ok.status).toBe(200)
		const spec = (await ok.json()) as { paths: Record<string, unknown> }
		expect(spec.paths["/health"]).toBeDefined()
	})
})
