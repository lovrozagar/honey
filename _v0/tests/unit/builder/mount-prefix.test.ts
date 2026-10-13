import { describe, expect, it } from "vitest"
import { createMiddleware, honey, HoneyError } from "../../../src/index.ts"
import { generateOpenApiFromTree } from "../../../src/openapi/document.ts"

const get = (app: { fetch: (r: Request) => Response | Promise<Response> }, path: string) =>
	app.fetch(new Request(`http://h${path}`))

function makeSub() {
	const sub = honey()
	sub.get("/users").handler((c) => c.res.json("ok", { rp: c.routePattern }))
	return sub
}

describe("route(sub) applies the mounting handle's basePath", () => {
	it("serves the sub under the basePath, not at its own path", async () => {
		const app = honey()
		app.basePath("/v1").route(makeSub())
		expect((await get(app, "/users")).status).toBe(404)
		const res = await get(app, "/v1/users")
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ rp: "/v1/users" })
	})

	it("composes with the sub's own basePath", async () => {
		const sub = honey().basePath("/admin")
		sub.get("/x").handler((c) => c.res.json("ok", {}))
		const app = honey()
		app.basePath("/v1").route(sub)
		expect((await get(app, "/v1/admin/x")).status).toBe(200)
		expect((await get(app, "/admin/x")).status).toBe(404)
	})

	it("route(prefix, sub) is basePath(prefix).route(sub), including the sub's root route", async () => {
		const sub = honey()
		sub.get("/").handler((c) => c.res.json("ok", {}))
		const app = honey()
		app.route("/v2", sub)
		expect((await get(app, "/v2")).status).toBe(200)
	})

	it("mounting without a basePath keeps the sub's paths", async () => {
		const app = honey()
		app.route(makeSub())
		expect((await get(app, "/users")).status).toBe(200)
	})

	it("the sub's scoped middleware guards the prefixed paths", async () => {
		const sub = honey()
		sub.use(
			"/secret",
			createMiddleware(async () => {
				throw new HoneyError({ errorKey: "forbidden", status: "forbidden" })
			}),
		)
		sub.get("/secret/a").handler((c) => c.res.json("ok", {}))
		sub.get("/open").handler((c) => c.res.json("ok", {}))
		const app = honey()
		app.route("/api", sub)
		expect((await get(app, "/api/secret/a")).status).toBe(403)
		expect((await get(app, "/api/open")).status).toBe(200)
	})

	it("the mounting chain runs on the prefixed routes", async () => {
		const seen: string[] = []
		const app = honey().use(
			createMiddleware(async (c, next) => {
				seen.push(c.path)
				return next()
			}),
		)
		app.basePath("/v1").route(makeSub())
		await get(app, "/v1/users")
		expect(seen).toEqual(["/v1/users"])
	})

	it("OpenAPI documents the prefixed path", () => {
		const app = honey()
		app.basePath("/v1").route(makeSub())
		const doc = generateOpenApiFromTree(app, { info: { title: "t", version: "1" } }) as {
			paths: Record<string, unknown>
		}
		expect(Object.keys(doc.paths)).toEqual(["/v1/users"])
	})

	it("route(prefix) without a sub throws", () => {
		expect(() => (honey() as unknown as { route: (p: string) => unknown }).route("/x")).toThrow(/needs the sub-app/)
	})
})
