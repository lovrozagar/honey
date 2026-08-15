import { describe, expect, it } from "vitest"
import * as z from "zod"
import { generateOpenApi, generateSDK } from "../../../src/codegen.ts"
import { honey } from "../../../src/index.ts"

/* ---- Test 1: generateOpenApi emits x-invalidate from meta ---- */

describe("generateOpenApi emits x-invalidate from meta", () => {
	it("emits x-invalidate on operation with invalidate meta", async () => {
		const app = honey()
			.get("/v1/users")
			.meta({ operationId: "users.list" })
			.handler((c) => c.res.text("ok", "ok"))
			.post("/v1/users")
			.meta({ invalidate: ["GET /v1/users"], operationId: "users.create" })
			.handler((c) => c.res.text("ok", "ok"))

		const spec = await generateOpenApi(app, {
			info: { title: "Test", version: "1" },
		})
		const postOp = spec.paths["/v1/users"].post
		expect(postOp["x-invalidate"]).toEqual(["GET /v1/users"])
		expect(postOp.operationId).toBe("users.create")
	})
})

/* ---- Test 2: generateOpenApi omits x-invalidate when not present ---- */

describe("generateOpenApi omits x-invalidate when not present", () => {
	it("does not emit x-invalidate when meta has no invalidate", async () => {
		const app = honey()
			.get("/v1/users")
			.meta({ operationId: "users.list" })
			.handler((c) => c.res.text("ok", "ok"))

		const spec = await generateOpenApi(app, {
			info: { title: "Test", version: "1" },
		})
		const getOp = spec.paths["/v1/users"].get
		expect(getOp["x-invalidate"]).toBeUndefined()
	})
})

/* ---- Test 3: generateOpenApi omits x-invalidate for null ---- */

describe("generateOpenApi omits x-invalidate for null", () => {
	it("does not emit x-invalidate when invalidate is null", async () => {
		const app = honey()
			.post("/v1/users")
			.meta({ invalidate: null, operationId: "users.create" })
			.handler((c) => c.res.text("ok", "ok"))

		const spec = await generateOpenApi(app, {
			info: { title: "Test", version: "1" },
		})
		const postOp = spec.paths["/v1/users"].post
		expect(postOp["x-invalidate"]).toBeUndefined()
	})
})

/* ---- Test 4: generateOpenApi omits x-invalidate for empty array ---- */

describe("generateOpenApi omits x-invalidate for empty array", () => {
	it("does not emit x-invalidate when invalidate is empty", async () => {
		const app = honey()
			.post("/v1/users")
			.meta({ invalidate: [], operationId: "users.create" })
			.handler((c) => c.res.text("ok", "ok"))

		const spec = await generateOpenApi(app, {
			info: { title: "Test", version: "1" },
		})
		const postOp = spec.paths["/v1/users"].post
		expect(postOp["x-invalidate"]).toBeUndefined()
	})
})

/* ---- Test 5: generateSDK emits invalidate on serviceMap entry ---- */

describe("generateSDK emits invalidate on serviceMap entry", () => {
	it("reads x-invalidate from OpenAPI and adds to serviceMap", async () => {
		const app = honey()
			.get("/v1/users")
			.meta({ operationId: "users.list" })
			.handler((c) => c.res.text("ok", "ok"))
			.post("/v1/users")
			.meta({ invalidate: ["GET /v1/users"], operationId: "users.create" })
			.handler((c) => c.res.text("ok", "ok"))

		const spec = await generateOpenApi(app, {
			info: { title: "Test", version: "1" },
		})
		const { files, serviceMap } = generateSDK(spec)
		expect(serviceMap.users.create.invalidate).toEqual(["GET /v1/users"])
		expect(files.map).toContain("invalidate:")
		expect(files.map).toContain('"GET /v1/users"')
	})
})

/* ---- Test 6: generateSDK omits invalidate when x-invalidate absent ---- */

describe("generateSDK omits invalidate when x-invalidate absent", () => {
	it("does not add invalidate to serviceMap entry", async () => {
		const app = honey()
			.get("/v1/users")
			.meta({ operationId: "users.list" })
			.handler((c) => c.res.text("ok", "ok"))

		const spec = await generateOpenApi(app, {
			info: { title: "Test", version: "1" },
		})
		const { serviceMap } = generateSDK(spec)
		expect(serviceMap.users.list.invalidate).toBeUndefined()
	})
})

/* ---- Test 7: generateSDK preserves multiple invalidation targets ---- */

describe("generateSDK preserves multiple invalidation targets", () => {
	it("keeps all targets from x-invalidate", async () => {
		const app = honey()
			.get("/v1/users")
			.meta({ operationId: "users.list" })
			.handler((c) => c.res.text("ok", "ok"))
			.get("/v1/users/:id")
			.meta({ operationId: "users.get" })
			.input({ params: z.object({ id: z.string() }) })
			.handler((c) => c.res.text("ok", "ok"))
			.post("/v1/users")
			.meta({
				invalidate: ["GET /v1/users", "GET /v1/users/:id"],
				operationId: "users.create",
			})
			.handler((c) => c.res.text("ok", "ok"))

		const spec = await generateOpenApi(app, {
			info: { title: "Test", version: "1" },
		})
		const { serviceMap } = generateSDK(spec)
		expect(serviceMap.users.create.invalidate).toEqual([
			"GET /v1/users",
			"GET /v1/users/:id",
		])
	})
})
