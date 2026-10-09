import { describe, expect, test } from "bun:test"
import internalDoc from "../src/_gen/openapi.gen.json"
import publicDoc from "../src/_gen/openapi.public.gen.json"
import { compareApps, probesFromTree } from "../../differential.ts"
import { routeTree } from "../src/_gen/routes.gen.ts"
import { createApp } from "../src/app.ts"
import { tree as downstream } from "../src/route-tree.ts"

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
		const op = operation(internalDoc, "/articles/")
		expect(op["x-permissions"]).toEqual(["articles.read"])
		expect(op.summary).toBe("List articles")
	})

	test("middleware-contributed tenancy reaches the document", () => {
		expect(operation(internalDoc, "/articles/")["x-tenant"]).toEqual({ param: "project_id" })
		/* a route that declares no meta at all still carries what the middleware contributed */
		expect(operation(internalDoc, "/articles/meta/")["x-tenant"]).toEqual({ param: "project_id" })
	})

	test("an entity descriptor fans out through a pagination envelope", () => {
		const op = operation(internalDoc, "/articles/")
		expect(op["x-entity"]).toBe("article")
		expect(op["x-identity"]).toBe("id")
		expect(op["x-generated"]).toEqual(["id", "created_at"])
		expect(op["x-immutable"]).toEqual(["id"])
		expect(op["x-soft-delete"]).toBe("deleted_at")
	})

	test("both members of one reserved key reach the same operation", () => {
		/* the publisher stamps `x-comb` with a union: the entity descriptor on the read
		   schema, the query descriptor on the list-query schema. Two policy entries, told
		   apart by the discriminant, must both land — this pair is the whole point. */
		const op = operation(internalDoc, "/articles/")
		expect(op["x-entity"]).toBe("article")
		expect(op["x-query"]).toEqual({
			filter: ["title"],
			maxLimit: 100,
			select: ["id", "title"],
			sort: ["title"],
		})
	})

	test("a fact the publisher could not determine is an absent key, not a null tag", () => {
		const op = operation(internalDoc, "/articles/")
		/* tenantColumn: null and searchable: null — "unknown", which must not be published
		   as "definitively none" */
		expect(op).not.toHaveProperty("x-tenant-column")
		expect(op).not.toHaveProperty("x-searchable")
		/* the routing layer does know the tenant, and supplies it from middleware */
		expect(op["x-tenant"]).toEqual({ param: "project_id" })
	})

	test("a hidden meta key is in neither document", () => {
		for (const doc of [internalDoc, publicDoc]) {
			expect(JSON.stringify(doc)).not.toContain("worker")
			expect(JSON.stringify(doc)).not.toContain("origin")
		}
	})

	test("the public profile is default-deny: only allowlisted extensions survive", () => {
		const op = operation(publicDoc, "/articles/")
		expect(op["x-entity"]).toBe("article")
		expect(op["x-query"]).toBeDefined()
		expect(op).not.toHaveProperty("x-tenant")
		expect(op).not.toHaveProperty("x-identity")
		expect(op).not.toHaveProperty("x-permissions")
		/* standard fields are not gated by the allowlist */
		expect(op.summary).toBe("List articles")
	})

	test("both documents describe the same routes and schemas", () => {
		expect(Object.keys((publicDoc as Doc).paths).sort()).toEqual(Object.keys((internalDoc as Doc).paths).sort())
		expect(operation(publicDoc, "/articles/").responses).toEqual(operation(internalDoc, "/articles/").responses)
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
		expect(operation(served, "/articles/")).toEqual(operation(internalDoc, "/articles/"))
	})
})

describe("gateway — generated tree with own and downstream routes", () => {
	test("downstream routes delegate to the catch-all proxy with their own pattern", async () => {
		const list = await fetchApp("/app/users/")
		expect(list.status).toBe(200)
		expect(await list.json()).toEqual({ service: "users", users: [] })
		const one = await fetchApp("/app/users/7/")
		expect(await one.json()).toEqual({ id: "7", service: "users" })
	})

	test("own routes next to the catch-all are served by the gateway", async () => {
		expect(await (await fetchApp("/app/nl/c/d1/aHR0cHM/")).json()).toEqual({ delivery: "d1", url: "aHR0cHM" })
		expect(await (await fetchApp("/app/v1/openapi/spec/")).json()).toEqual({ spec: "gateway" })
	})

	test("a path no route serves is 404, not forwarded", async () => {
		expect((await fetchApp("/app/nowhere/at/all/")).status).toBe(404)
	})

	test("the generated documents list own and downstream routes", () => {
		for (const doc of [internalDoc, publicDoc]) {
			expect(Object.keys((doc as Doc).paths)).toEqual(
				expect.arrayContaining(["/ping/", "/nl/c/{delivery}/{url}/", "/users/", "/users/{id}/"]),
			)
		}
	})

	/* GET and HEAD only: without a tree the root `ALL /*` is an ordinary route, so a method miss
	   on an own route backtracks into it and is forwarded; from the gateway tree the catch-all
	   serves only delegated leaves, and the miss is a 405 */
	test("own routes answer GET and HEAD like the runtime trie", async () => {
		const own = {
			...routeTree,
			routes: Object.fromEntries(Object.entries(routeTree.routes).filter(([id]) => !(id in downstream.routes))),
		}
		const probes = probesFromTree(own, (p) => `/app${p === "/" ? "" : p}/`).filter(
			(p) => (p.method === "GET" || p.method === "HEAD") && !p.path.includes("__nope__"),
		)
		expect(probes.length).toBeGreaterThan(5)
		expect(await compareApps(createApp(undefined, { routeTree: null }), createApp(), probes)).toEqual([])
	})
})
