import { describe, expect, it } from "vitest"
import * as z from "zod"
import { generateManifest, generateOpenApi, generateRouteTreeFromApp, generateTypes } from "../../../src/codegen.ts"
import { honey } from "../../../src/index.ts"

/* ---- fixtures ---- */

function createMetaApp() {
	return honey()
		.get("/health")
		.meta({ summary: "Health check" })
		.handler((c) => c.res.text("ok", "ok"))
		.get("/orgs")
		.meta({
			auth: "required",
			operationId: "listOrgs",
			rateLimit: "strict",
			summary: "List orgs",
			tags: ["Organization"],
		})
		.input({ search: z.object({ limit: z.number() }) })
		.handler((c) => c.res.text("ok", "ok"))
		.post("/orgs")
		.meta({
			auth: "required",
			deprecated: true,
			description: "Create a new organization",
			security: [{ bearerAuth: [] }],
			summary: "Create org",
		})
		.input({ json: z.object({ name: z.string() }) })
		.handler((c) => c.res.text("ok", "ok"))
}

/* ---- route tree meta export ---- */

describe("generateRouteTree meta export", () => {
	it("emits separate meta export with full meta", () => {
		const app = createMetaApp()
		const code = generateRouteTreeFromApp(app)

		expect(code).toContain("export const meta")
		/* custom fields present */
		expect(code).toContain('"auth"')
		expect(code).toContain('"required"')
		expect(code).toContain('"rateLimit"')
		expect(code).toContain('"strict"')
		/* openApi fields are flat in meta export */
		expect(code).toContain('"summary"')
	})

	it("uses METHOD /path keys", () => {
		const app = createMetaApp()
		const code = generateRouteTreeFromApp(app)

		expect(code).toContain('"GET /orgs"')
		expect(code).toContain('"POST /orgs"')
	})

	it("includes routes with only openApi fields in meta", () => {
		const app = createMetaApp()
		const code = generateRouteTreeFromApp(app)

		expect(code).toContain('"GET /health"')
	})
})

/* ---- MetaShape emits literal types ---- */

describe("MetaShape emits literal types", () => {
	it("string values become string literal union", () => {
		const app = honey()
			.meta<{ worker: string }>()
			.get("/a")
			.meta({ worker: "extract" })
			.handler((c) => c.res.text("ok", "ok"))
			.get("/b")
			.meta({ worker: "saas" })
			.handler((c) => c.res.text("ok", "ok"))
		const code = generateRouteTreeFromApp(app)

		expect(code).toContain('worker: "extract" | "saas"')
		expect(code).not.toContain("worker: string")
	})

	it("boolean literal values preserved", () => {
		const app = honey()
			.meta<{ auth: string; permissions: boolean }>()
			.get("/a")
			.meta({ auth: "jwt", permissions: false })
			.handler((c) => c.res.text("ok", "ok"))
		const code = generateRouteTreeFromApp(app)

		expect(code).toContain('auth: "jwt"')
		expect(code).toContain("permissions: false")
		expect(code).not.toContain("permissions: boolean")
	})

	it("mixed true/false becomes true | false", () => {
		const app = honey()
			.meta<{ flag: boolean }>()
			.get("/a")
			.meta({ flag: true })
			.handler((c) => c.res.text("ok", "ok"))
			.get("/b")
			.meta({ flag: false })
			.handler((c) => c.res.text("ok", "ok"))
		const code = generateRouteTreeFromApp(app)

		expect(code).toContain("flag: true | false")
	})

	it("number values become number literals", () => {
		const app = honey()
			.meta<{ priority: number }>()
			.get("/a")
			.meta({ priority: 1 })
			.handler((c) => c.res.text("ok", "ok"))
			.get("/b")
			.meta({ priority: 2 })
			.handler((c) => c.res.text("ok", "ok"))
		const code = generateRouteTreeFromApp(app)

		expect(code).toContain("priority: 1 | 2")
	})
})

/* ---- OpenAPI reads flat meta fields ---- */

describe("generateOpenApi reads flat meta", () => {
	it("maps summary from meta", async () => {
		const app = createMetaApp()
		const spec = await generateOpenApi(app, { info: { title: "Test", version: "1" } })

		expect(spec.paths["/orgs"].get.summary).toBe("List orgs")
		expect(spec.paths["/orgs"].post.summary).toBe("Create org")
		expect(spec.paths["/health"].get.summary).toBe("Health check")
	})

	it("maps tags from meta", async () => {
		const app = createMetaApp()
		const spec = await generateOpenApi(app, { info: { title: "Test", version: "1" } })

		expect(spec.paths["/orgs"].get.tags).toEqual(["Organization"])
	})

	it("maps deprecated from meta", async () => {
		const app = createMetaApp()
		const spec = await generateOpenApi(app, { info: { title: "Test", version: "1" } })

		expect(spec.paths["/orgs"].post.deprecated).toBe(true)
	})

	it("maps operationId from meta", async () => {
		const app = createMetaApp()
		const spec = await generateOpenApi(app, { info: { title: "Test", version: "1" } })

		expect(spec.paths["/orgs"].get.operationId).toBe("listOrgs")
	})

	it("maps description from meta", async () => {
		const app = createMetaApp()
		const spec = await generateOpenApi(app, { info: { title: "Test", version: "1" } })

		expect(spec.paths["/orgs"].post.description).toBe("Create a new organization")
	})

	it("maps security from meta", async () => {
		const app = createMetaApp()
		const spec = await generateOpenApi(app, { info: { title: "Test", version: "1" } })

		expect(spec.paths["/orgs"].post.security).toEqual([{ bearerAuth: [] }])
	})
})

/* ---- manifest includes full meta ---- */

describe("generateManifest includes full meta", () => {
	it("includes both openApi and custom fields", () => {
		const app = createMetaApp()
		const manifest = generateManifest(app)

		const orgsGet = manifest.routes.find((r) => r.path === "/orgs" && r.method === "GET")
		expect(orgsGet?.meta).toEqual({
			auth: "required",
			operationId: "listOrgs",
			rateLimit: "strict",
			summary: "List orgs",
			tags: ["Organization"],
		})
	})
})

/* ---- generateTypes includes meta ---- */

describe("generateTypes includes meta", () => {
	it("emits meta field per route with full meta", () => {
		const app = createMetaApp()
		const code = generateTypes(app, {
			appExport: "app",
			appImport: "./app",
		})

		/* meta field present in route type */
		expect(code).toContain("meta:")
		/* custom fields present */
		expect(code).toContain('"required"')
		/* openApi fields flat in types */
		expect(code).toContain("summary")
	})

	it("emits meta for routes with only openApi fields", () => {
		const app = createMetaApp()
		const code = generateTypes(app, {
			appExport: "app",
			appImport: "./app",
		})

		/* /health has summary meta */
		expect(code).toContain('"Health check"')
	})
})
