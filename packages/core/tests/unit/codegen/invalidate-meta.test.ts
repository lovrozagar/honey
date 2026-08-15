import { describe, expect, expectTypeOf, it } from "vitest"
import {
	generateManifest,
	generateOpenApi,
	generateRouteTreeFromApp,
	generateTypes,
} from "../../../src/codegen.ts"
import { honey } from "../../../src/index.ts"

/* ---- Test 1: OpenApiMeta includes invalidate field ---- */

describe("OpenApiMeta includes invalidate field", () => {
	it("accepts invalidate in .meta() and preserves it in manifest", () => {
		const app = honey()
			.get("/v1/users")
			.handler((c) => c.res.text("ok", "ok"))
			.post("/v1/users")
			.meta({ invalidate: ["GET /v1/users"] })
			.handler((c) => c.res.text("ok", "ok"))

		const manifest = generateManifest(app)
		const route = manifest.routes.find((r) => r.path === "/v1/users" && r.method === "POST")
		expect(route?.meta.invalidate).toEqual(["GET /v1/users"])
	})
})

/* ---- Test 2: invalidate accepts null ---- */

describe("invalidate accepts null", () => {
	it("preserves null in manifest meta", () => {
		const app = honey()
			.post("/v1/users")
			.meta({ invalidate: null })
			.handler((c) => c.res.text("ok", "ok"))

		const manifest = generateManifest(app)
		const route = manifest.routes.find((r) => r.path === "/v1/users" && r.method === "POST")
		expect(route?.meta.invalidate).toBeNull()
	})
})

/* ---- Test 3: invalidate accepts empty array ---- */

describe("invalidate accepts empty array", () => {
	it("preserves empty array in manifest meta", () => {
		const app = honey()
			.post("/v1/users")
			.meta({ invalidate: [] })
			.handler((c) => c.res.text("ok", "ok"))

		const manifest = generateManifest(app)
		const route = manifest.routes.find((r) => r.path === "/v1/users" && r.method === "POST")
		expect(route?.meta.invalidate).toEqual([])
	})
})

/* ---- Test 4: invalidate accepts multiple selectors ---- */

describe("invalidate accepts multiple selectors", () => {
	it("preserves all selectors in manifest meta", () => {
		const app = honey()
			.get("/v1/users")
			.handler((c) => c.res.text("ok", "ok"))
			.get("/v1/users/:id")
			.handler((c) => c.res.text("ok", "ok"))
			.post("/v1/search")
			.handler((c) => c.res.text("ok", "ok"))
			.post("/v1/users")
			.meta({
				invalidate: ["GET /v1/users", "GET /v1/users/:id", "POST /v1/search"],
			})
			.handler((c) => c.res.text("ok", "ok"))

		const manifest = generateManifest(app)
		const route = manifest.routes.find((r) => r.path === "/v1/users" && r.method === "POST")
		expect(route?.meta.invalidate).toEqual([
			"GET /v1/users",
			"GET /v1/users/:id",
			"POST /v1/search",
		])
	})
})

/* ---- Test 5: generateTypes emits invalidate as literal array type ---- */

describe("generateTypes emits invalidate as literal array type", () => {
	it("emits invalidate with literal string tuple in route meta", () => {
		const app = honey()
			.get("/v1/users")
			.handler((c) => c.res.text("ok", "ok"))
			.get("/v1/users/:id")
			.handler((c) => c.res.text("ok", "ok"))
			.post("/v1/users")
			.meta({ invalidate: ["GET /v1/users", "GET /v1/users/:id"] })
			.handler((c) => c.res.text("ok", "ok"))

		const code = generateTypes(app, {
			appExport: "app",
			appImport: "./app",
		})
		expect(code).toContain('invalidate: ["GET /v1/users", "GET /v1/users/:id"]')
	})
})

/* ---- Test 6: generateTypes emits RouteSelector union ---- */

describe("generateTypes emits RouteSelector union", () => {
	it("emits RouteSelector type with all non-internal route selectors", () => {
		const app = honey()
			.get("/v1/users")
			.handler((c) => c.res.text("ok", "ok"))
			.get("/v1/users/:id")
			.handler((c) => c.res.text("ok", "ok"))
			.post("/v1/users")
			.handler((c) => c.res.text("ok", "ok"))
			.delete("/v1/users/:id")
			.handler((c) => c.res.text("ok", "ok"))

		const code = generateTypes(app, {
			appExport: "app",
			appImport: "./app",
		})
		expect(code).toContain("export type RouteSelector =")
		expect(code).toContain('"DELETE /v1/users/:id"')
		expect(code).toContain('"GET /v1/users"')
		expect(code).toContain('"GET /v1/users/:id"')
		expect(code).toContain('"POST /v1/users"')
	})
})

/* ---- Test 7: RouteSelector union is sorted alphabetically ---- */

describe("generateTypes RouteSelector union is sorted", () => {
	it("emits selectors in alphabetical order", () => {
		const app = honey()
			.post("/z")
			.handler((c) => c.res.text("ok", "ok"))
			.get("/a")
			.handler((c) => c.res.text("ok", "ok"))
			.delete("/m")
			.handler((c) => c.res.text("ok", "ok"))

		const code = generateTypes(app, {
			appExport: "app",
			appImport: "./app",
		})
		const match = code.match(/export type RouteSelector = (.+)/)
		expect(match).not.toBeNull()
		const union = match?.[1] ?? ""
		const deleteIdx = union.indexOf('"DELETE /m"')
		const getIdx = union.indexOf('"GET /a"')
		const postIdx = union.indexOf('"POST /z"')
		expect(deleteIdx).toBeLessThan(getIdx)
		expect(getIdx).toBeLessThan(postIdx)
	})
})

/* ---- Test 8: RouteSelector omitted when no routes ---- */

describe("generateTypes omits RouteSelector when no routes", () => {
	it("does not emit RouteSelector for empty app", () => {
		const app = honey()

		const code = generateTypes(app, {
			appExport: "app",
			appImport: "./app",
		})
		expect(code).not.toContain("RouteSelector")
	})
})

/* ---- Test 9: RouteSelector skips x-internal routes ---- */

describe("generateTypes skips x-internal routes from RouteSelector", () => {
	it("excludes internal routes from RouteSelector union", () => {
		const app = honey()
			.get("/v1/users")
			.handler((c) => c.res.text("ok", "ok"))
			.get("/v1/internal")
			.meta({ internal: true })
			.handler((c) => c.res.text("ok", "ok"))

		const code = generateTypes(app, {
			appExport: "app",
			appImport: "./app",
		})
		expect(code).toContain('"GET /v1/users"')
		expect(code).not.toContain('"GET /v1/internal"')
	})
})

/* ---- Test 10: generateManifest preserves invalidate alongside other meta ---- */

describe("generateManifest preserves invalidate in route meta", () => {
	it("preserves invalidate alongside operationId", () => {
		const app = honey()
			.get("/v1/users")
			.handler((c) => c.res.text("ok", "ok"))
			.post("/v1/users")
			.meta({ invalidate: ["GET /v1/users"], operationId: "user.create" })
			.handler((c) => c.res.text("ok", "ok"))

		const manifest = generateManifest(app)
		const route = manifest.routes.find((r) => r.path === "/v1/users" && r.method === "POST")
		expect(route?.meta.invalidate).toEqual(["GET /v1/users"])
		expect(route?.meta.operationId).toBe("user.create")
	})
})

/* ---- Test 11: generateOpenApi does not emit invalidate ---- */

describe("generateOpenApi does not emit invalidate", () => {
	it("excludes invalidate from OpenAPI operation but keeps summary", async () => {
		const app = honey()
			.post("/v1/users")
			.meta({ invalidate: ["GET /v1/users"], summary: "Create user" })
			.handler((c) => c.res.text("ok", "ok"))

		const spec = await generateOpenApi(app, {
			info: { title: "Test", version: "1" },
		})
		const operation = spec.paths["/v1/users"].post
		expect(operation.summary).toBe("Create user")
		expect(operation.invalidate).toBeUndefined()
	})
})

/* ---- Test 12: invalidate selectors are deduplicated ---- */

describe("invalidate selectors are deduplicated", () => {
	it("deduplicates in generateTypes meta type", () => {
		const app = honey()
			.get("/v1/users")
			.handler((c) => c.res.text("ok", "ok"))
			.post("/v1/users")
			.meta({ invalidate: ["GET /v1/users", "GET /v1/users"] })
			.handler((c) => c.res.text("ok", "ok"))

		const code = generateTypes(app, {
			appExport: "app",
			appImport: "./app",
		})
		/* should contain single entry, not duplicated */
		expect(code).toContain('invalidate: ["GET /v1/users"]')
		expect(code).not.toContain('invalidate: ["GET /v1/users", "GET /v1/users"]')
	})

	it("deduplicates in generateManifest", () => {
		const app = honey()
			.get("/v1/users")
			.handler((c) => c.res.text("ok", "ok"))
			.post("/v1/users")
			.meta({ invalidate: ["GET /v1/users", "GET /v1/users"] })
			.handler((c) => c.res.text("ok", "ok"))

		const manifest = generateManifest(app)
		const route = manifest.routes.find((r) => r.path === "/v1/users" && r.method === "POST")
		expect(route?.meta.invalidate).toEqual(["GET /v1/users"])
	})
})

/* ---- Test 13: invalidate coexists with other meta fields ---- */

describe("invalidate coexists with other meta fields", () => {
	it("all fields present in manifest and types", () => {
		const app = honey()
			.get("/v1/users")
			.handler((c) => c.res.text("ok", "ok"))
			.post("/v1/users")
			.meta({
				deprecated: true,
				invalidate: ["GET /v1/users"],
				operationId: "user.create",
				tags: "users",
			})
			.handler((c) => c.res.text("ok", "ok"))

		const manifest = generateManifest(app)
		const route = manifest.routes.find((r) => r.path === "/v1/users" && r.method === "POST")
		expect(route?.meta.deprecated).toBe(true)
		expect(route?.meta.invalidate).toEqual(["GET /v1/users"])
		expect(route?.meta.operationId).toBe("user.create")
		expect(route?.meta.tags).toBe("users")

		const code = generateTypes(app, {
			appExport: "app",
			appImport: "./app",
		})
		expect(code).toContain("deprecated: true")
		expect(code).toContain("invalidate:")
		expect(code).toContain('operationId: "user.create"')
		expect(code).toContain('tags: "users"')
	})
})

/* ---- Test 14: generateRouteTreeFromApp preserves invalidate ---- */

describe("generateRouteTreeFromApp preserves invalidate", () => {
	it("includes invalidate in emitted meta", () => {
		const app = honey()
			.get("/v1/users")
			.handler((c) => c.res.text("ok", "ok"))
			.post("/v1/users")
			.meta({ invalidate: ["GET /v1/users"] })
			.handler((c) => c.res.text("ok", "ok"))

		const code = generateRouteTreeFromApp(app)
		expect(code).toContain('"invalidate"')
		expect(code).toContain('"GET /v1/users"')
	})
})

/* ---- Test 15b: generateTypes emits HoneyCodegen module augmentation ---- */

describe("generateTypes emits HoneyCodegen module augmentation", () => {
	it("emits declare module with HoneyCodegen routeSelector", () => {
		const app = honey()
			.get("/v1/users")
			.handler((c) => c.res.text("ok", "ok"))
			.post("/v1/users")
			.handler((c) => c.res.text("ok", "ok"))

		const code = generateTypes(app, {
			appExport: "app",
			appImport: "./app",
		})
		expect(code).toContain('declare module "@ecomet/honey"')
		expect(code).toContain("interface HoneyCodegen")
		expect(code).toContain("routeSelector:")
		expect(code).toContain('"GET /v1/users"')
		expect(code).toContain('"POST /v1/users"')
	})

	it("omits augmentation when no routes", () => {
		const app = honey()

		const code = generateTypes(app, {
			appExport: "app",
			appImport: "./app",
		})
		expect(code).not.toContain("HoneyCodegen")
	})
})

/* ---- Test 15: ctx.meta.invalidate is accessible at type level ---- */

describe("ctx.meta.invalidate type-level access", () => {
	it("invalidate is typed as readonly string[] on ctx.meta", () => {
		const app = honey()
			.post("/v1/users")
			.meta({ invalidate: ["GET /v1/users"] as const })
			.handler((c) => {
				expectTypeOf(c.meta.invalidate).toEqualTypeOf<readonly ["GET /v1/users"]>()
				return c.res.text("ok", "ok")
			})

		expect(app).toBeDefined()
	})
})
