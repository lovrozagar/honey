import { describe, expect, it, vi } from "vitest"
import "@lovrozagar/honey/openapi"
import { generateOpenApi } from "../../../src/codegen.ts"
import { honey } from "../../../src/index.ts"
import { spec } from "../../../src/openapi/spec.ts"

const get = (
	app: { fetch: (r: Request, env: unknown) => Response | Promise<Response> },
	path: string,
	init?: RequestInit,
) => Promise.resolve(app.fetch(new Request(`http://x${path}`, init), {}))

type Doc = {
	info: { title: string }
	paths: Record<string, Record<string, Record<string, unknown>>>
	servers?: unknown
}

function tenantApp() {
	const app = honey<{}>().meta<{ tenant?: string }>()
	app.metaSpec({
		meta: { tenant: { key: "x-secret", profiles: ["internal"] } },
		profiles: { internal: {}, public: {} },
	})
	app
		.get("/a")
		.meta({ tenant: "orgId" })
		.handler((c) => c.res.json("ok", {}))
	return app
}

describe("openapi(): one document per call (H31)", () => {
	// regression: H31
	it("an internal and a public document never share a cache, whichever is hit first", async () => {
		for (const first of ["/internal/openapi.json", "/openapi.json"]) {
			const app = tenantApp()
			app.openapi({ path: "/internal/openapi", profile: "internal", title: "Internal", version: "1" })
			app.openapi({ path: "/openapi", profile: "public", title: "Public", version: "1" })
			await get(app, first)
			const internal = (await (await get(app, "/internal/openapi.json")).json()) as Doc
			const pub = (await (await get(app, "/openapi.json")).json()) as Doc
			expect(internal.info.title).toBe("Internal")
			expect(internal.paths["/a"].get["x-secret"]).toBe("orgId")
			expect(pub.info.title).toBe("Public")
			expect(pub.paths["/a"].get).not.toHaveProperty("x-secret")
			/* the YAML alias follows its own call's document */
			expect(await (await get(app, "/openapi.yaml")).text()).not.toContain("x-secret")
		}
	})

	it("a second docs UI mounts at its docsPath and points at its own document", async () => {
		const app = tenantApp()
		app.openapi({ docs: "scalar", path: "/internal/openapi", profile: "internal", title: "I", version: "1" })
		app.openapi({
			docs: "swagger",
			docsPath: "/public-docs",
			path: "/openapi",
			profile: "public",
			title: "P",
			version: "1",
		})
		const first = await (await get(app, "/docs")).text()
		const second = await (await get(app, "/public-docs")).text()
		expect(first).toContain("/internal/openapi.json")
		expect(second).toContain("swagger")
		expect(second).toContain('"/openapi.json"')
	})

	it("a second docs UI with no docsPath throws instead of being silently skipped", () => {
		const app = tenantApp()
		app.openapi({ docs: "scalar", path: "/internal/openapi", title: "I", version: "1" })
		expect(() => app.openapi({ docs: "scalar", path: "/openapi", title: "P", version: "1" })).toThrow(
			/cannot mount at \/docs: an earlier openapi\(\)/,
		)
	})

	// regression: M (index.ts:968 perf)
	it("generates and serializes once per route change, however many requests", async () => {
		const app = honey()
		app.get("/a").handler((c) => c.res.text("ok", "a"))
		/* filterRoutes runs once per route per generation: count generations by route /a */
		let calls = 0
		const filterRoutes = (route: { path: string }): boolean => {
			if (route.path === "/a") calls++
			return true
		}
		app.openapi({ filterRoutes, title: "T", version: "1" })
		const stringify = vi.spyOn(JSON, "stringify")
		for (let i = 0; i < 5; i++) await get(app, "/openapi.json")
		for (let i = 0; i < 3; i++) await get(app, "/openapi.yaml")
		const docStringifies = stringify.mock.calls.filter(([v]) => (v as { openapi?: string })?.openapi === "3.1.0")
		stringify.mockRestore()
		expect(calls).toBe(1)
		/* one serialization per format: the JSON body, and the YAML emitter's own pass */
		expect(docStringifies).toHaveLength(2)
		app.get("/b").handler((c) => c.res.text("ok", "b"))
		const after = (await (await get(app, "/openapi.json")).json()) as Doc
		expect(after.paths["/b"]).toBeDefined()
		expect(calls).toBe(2)
	})
})

describe("openapi(): caching headers and enabled", () => {
	// regression: L (spec gating)
	it("sends a strong ETag with no-cache and answers If-None-Match with 304", async () => {
		const app = honey()
		app.get("/a").handler((c) => c.res.text("ok", "a"))
		app.openapi({ title: "T", version: "1" }).manifest()
		for (const path of ["/openapi.json", "/openapi.yaml", "/manifest.json"]) {
			const res = await get(app, path)
			const tag = res.headers.get("etag")
			expect(tag).toMatch(/^"[\w-]+"$/)
			expect(res.headers.get("cache-control")).toBe("no-cache")
			expect(res.headers.get("x-content-type-options")).toBe("nosniff")
			const hit = await get(app, path, { headers: { "if-none-match": `W/${tag}` } })
			expect(hit.status).toBe(304)
			expect(await hit.text()).toBe("")
		}
		const before = (await get(app, "/openapi.json")).headers.get("etag")
		app.get("/b").handler((c) => c.res.text("ok", "b"))
		const changed = await get(app, "/openapi.json", { headers: { "if-none-match": before ?? "" } })
		expect(changed.status).toBe(200)
		expect(changed.headers.get("etag")).not.toBe(before)
	})

	// regression: L (spec gating)
	it("enabled: false mounts nothing", async () => {
		const app = honey()
		app.get("/a").handler((c) => c.res.text("ok", "a"))
		app.openapi({ docs: "scalar", enabled: false, title: "T", version: "1" }).manifest({ enabled: false })
		for (const path of ["/openapi.json", "/openapi.yaml", "/docs", "/manifest.json"]) {
			expect((await get(app, path)).status).toBe(404)
		}
	})
})

describe("openapi(): mounting", () => {
	// regression: M (index.ts:1020-1032)
	it("a root /:slug or /*rest route does not shadow the spec routes", async () => {
		for (const pattern of ["/:slug", "/*rest"]) {
			const app = honey()
			app.get(pattern).handler((c) => c.res.text("ok", "user"))
			app.openapi({ docs: "scalar", title: "T", version: "1" })
			const res = await get(app, "/openapi.json")
			expect(res.status).toBe(200)
			expect(((await res.json()) as Doc).info.title).toBe("T")
			expect(await (await get(app, "/docs")).text()).toContain("scalar")
			expect(await (await get(app, "/other")).text()).toBe("user")
		}
	})

	it("throws when a user route owns a spec path, in either order", () => {
		const before = honey()
		before.get("/openapi.json").handler((c) => c.res.text("ok", "mine"))
		expect(() => before.openapi({ title: "T", version: "1" })).toThrow(/GET \/openapi\.json: a route already owns it/)

		const all = honey()
		all.all("/openapi.yaml").handler((c) => c.res.text("ok", "mine"))
		expect(() => all.openapi({ title: "T", version: "1" })).toThrow(/GET \/openapi\.yaml: a route already owns it/)

		const after = honey().openapi({ title: "T", version: "1" })
		expect(() => after.get("/openapi.json").handler((c) => c.res.text("ok", "mine"))).toThrow(/Duplicate route/)
	})

	// regression: L (index.ts:972)
	it("the docs UI points at the stripped prefix the browser sees", async () => {
		const app = honey().stripPrefix("/api")
		app.get("/a").handler((c) => c.res.text("ok", "a"))
		app.openapi({ docs: "scalar", title: "T", version: "1" })
		const html = await (await get(app, "/api/docs")).text()
		expect(html).toContain("/api/openapi.json")
		expect((await get(app, "/api/openapi.json")).status).toBe(200)
	})
})

describe("openapi(): gateway and sub-app", () => {
	for (const order of ["sub-first", "gateway-first"] as const) {
		// regression: H32
		it(`the gateway serves its own document when the sub also called openapi() (${order})`, async () => {
			const sub = honey()
			sub.get("/users").handler((c) => c.res.text("ok", "users"))
			sub.openapi({ docs: "scalar", title: "Sub", version: "1" }).manifest()
			const gateway = honey()
			gateway.get("/health").handler((c) => c.res.text("ok", "ok"))
			if (order === "gateway-first") gateway.openapi({ docs: "swagger", title: "Gateway", version: "1" })
			gateway.route(sub)
			if (order === "sub-first") gateway.openapi({ docs: "swagger", title: "Gateway", version: "1" })
			const doc = (await (await get(gateway, "/openapi.json")).json()) as Doc
			expect(doc.info.title).toBe("Gateway")
			expect(doc.paths["/users"]).toBeDefined()
			expect(doc.paths["/health"]).toBeDefined()
			expect(await (await get(gateway, "/docs")).text()).toContain("swagger")
			/* the sub's manifest stayed with the sub */
			expect((await get(gateway, "/manifest.json")).status).toBe(404)
			expect(((await (await get(sub, "/openapi.json")).json()) as Doc).info.title).toBe("Sub")
		})
	}
})

describe("standalone spec() on several apps", () => {
	// regression: M (openapi/spec.ts:20-47)
	it("one spec() handler mounted on two apps documents each app", async () => {
		const handler = spec({ title: "Shared", version: "1" })
		const a = honey()
		a.get("/only-a").handler((c) => c.res.text("ok", "a"))
		a.get("/spec.json").handler(handler)
		const b = honey()
		b.get("/only-b").handler((c) => c.res.text("ok", "b"))
		expect(() => b.get("/spec.json").handler(handler)).not.toThrow()
		const docA = (await (await get(a, "/spec.json")).json()) as Doc
		const docB = (await (await get(b, "/spec.json")).json()) as Doc
		expect(Object.keys(docA.paths)).toEqual(["/only-a"])
		expect(Object.keys(docB.paths)).toEqual(["/only-b"])
	})
})

describe("metaSpec composition with mounted sub-apps", () => {
	const subWith = (strict: "off" | undefined) => {
		const sub = honey<{}>().meta<{ rateLimit?: string }>()
		sub.metaSpec({ meta: {}, strict })
		sub
			.get("/s")
			.meta({ rateLimit: "ai" })
			.handler((c) => c.res.json("ok", {}))
		return sub
	}

	// regression: L (index.ts:1310-1312)
	it("metaSpec() after route(sub) merges instead of throwing", async () => {
		const parent = honey<{}>().meta<{ rateLimit?: string }>()
		parent.route(subWith(undefined) as never)
		expect(() => parent.metaSpec({ meta: { rateLimit: "x-rate-limit" } })).not.toThrow()
		const doc = await generateOpenApi(parent as never, { info: { title: "T", version: "1" } })
		expect(doc.paths["/s"].get["x-rate-limit"]).toBe("ai")
		/* still one declaration per app */
		expect(() => parent.metaSpec({ meta: {} })).toThrow(/already declared/)
	})

	for (const order of ["declare-first", "mount-first"] as const) {
		// regression: M (index.ts:1346)
		it(`a sub's strict: "off" does not downgrade the parent's resolved strictness (${order})`, async () => {
			const parent = honey<{}>().meta<{ rateLimit?: string }>()
			if (order === "declare-first") parent.metaSpec({ meta: {} })
			parent.route(subWith("off") as never)
			if (order === "mount-first") parent.metaSpec({ meta: {} })
			await expect(generateOpenApi(parent as never, { info: { title: "T", version: "1" } })).rejects.toThrow(
				/MISSING_ENTRY/,
			)
		})
	}
})
