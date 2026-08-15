import { describe, expect, test } from "bun:test"
import internalDoc from "../src/_gen/openapi.gen.json"
import publicDoc from "../src/_gen/openapi.public.gen.json"
import { createApp } from "../src/app.ts"

const app = createApp()

async function fetchApp(path: string, init?: RequestInit): Promise<Response> {
	return app.fetch(new Request(`http://honey.test${path}`, init), {})
}

type Doc = { paths: Record<string, Record<string, Record<string, unknown>>> }

function operation(doc: unknown, path: string): Record<string, unknown> {
	return (doc as Doc).paths[path].get
}

describe("e2e gateway consumes honey", () => {
	test("GET /app/ping → 308 to /app/ping/", async () => {
		const res = await fetchApp("/app/ping")
		expect(res.status).toBe(308)
		expect(res.headers.get("location")).toContain("/app/ping/")
	})

	test("GET /app/ping/ → pong", async () => {
		const res = await fetchApp("/app/ping/")
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("pong")
	})
})

describe("metaSpec — generated documents", () => {
	test("route meta reaches the internal document", () => {
		const op = operation(internalDoc, "/articles")
		expect(op["x-permissions"]).toEqual(["articles.read"])
		expect(op.summary).toBe("List articles")
	})

	test("middleware-contributed tenancy reaches the document", () => {
		expect(operation(internalDoc, "/articles")["x-tenant"]).toEqual({ param: "project_id" })
		/* a route that declares no meta at all still carries what the middleware contributed */
		expect(operation(internalDoc, "/articles/meta")["x-tenant"]).toEqual({ param: "project_id" })
	})

	test("a schema-stamped descriptor fans out through a pagination envelope", () => {
		const op = operation(internalDoc, "/articles")
		expect(op["x-entity"]).toBe("article")
		expect(op["x-generated"]).toEqual(["id"])
		expect(op["x-immutable"]).toEqual(["id"])
		expect(op["x-soft-delete"]).toEqual({ field: "deletedAt" })
		expect(op["x-query"]).toMatchObject({ sort: ["title"] })
	})

	test("a hidden meta key is in neither document", () => {
		for (const doc of [internalDoc, publicDoc]) {
			expect(JSON.stringify(doc)).not.toContain("worker")
			expect(JSON.stringify(doc)).not.toContain("origin")
		}
	})

	test("the public profile is default-deny: only allowlisted extensions survive", () => {
		const op = operation(publicDoc, "/articles")
		expect(op["x-entity"]).toBe("article")
		expect(op["x-query"]).toBeDefined()
		expect(op).not.toHaveProperty("x-tenant")
		expect(op).not.toHaveProperty("x-permissions")
		/* standard fields are not gated by the allowlist */
		expect(op.summary).toBe("List articles")
	})

	test("both documents describe the same routes and schemas", () => {
		expect(Object.keys((publicDoc as Doc).paths).sort()).toEqual(Object.keys((internalDoc as Doc).paths).sort())
		expect(operation(publicDoc, "/articles").responses).toEqual(operation(internalDoc, "/articles").responses)
	})
})

describe("metaSpec — running server", () => {
	test("contributed meta is visible on ctx.meta at runtime", async () => {
		const res = await fetchApp("/app/articles/meta/")
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ meta: { tenant: "project_id" } })
	})

	test("the served document matches the generated internal one", async () => {
		/* this app enforces trailing slashes, so the spec route is /app/openapi.json/ */
		const res = await fetchApp("/app/openapi.json/")
		expect(res.status).toBe(200)
		const served = (await res.json()) as Doc
		expect(operation(served, "/articles")).toEqual(operation(internalDoc, "/articles"))
	})
})
