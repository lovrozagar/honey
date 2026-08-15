import { describe, expect, it } from "vitest"
import { generateManifest, generateOpenApi } from "../../../src/codegen.ts"
import { honey } from "../../../src/index.ts"
import { scalar } from "../../../src/openapi/scalar.ts"
import { spec } from "../../../src/openapi/spec.ts"
import { swagger } from "../../../src/openapi/swagger.ts"
import { testClient } from "../../../src/testing.ts"

function makeApp() {
  const app = honey<{}>()
  app.get("/health").handler((ctx) => ctx.res.json("ok", { status: "ok" }))
  app.post("/users").handler((ctx) => ctx.res.json("created", { id: "1" }))
  app.get("/users/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))
  app.get("/openapi/json").handler(spec({ title: "Test API", version: "1.0.0" }))
  return app
}

describe("spec", () => {
  it("returns a handler function", () => {
    const handler = spec({ title: "API", version: "1.0" })
    expect(typeof handler).toBe("function")
  })

  it("GET /openapi/json → 200 with application/json", async () => {
    const app = makeApp()
    const client = testClient(app, { env: {} })
    const res = await client.get("/openapi/json")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
  })

  it("response body has openapi 3.1.0, info.title, paths", async () => {
    const app = makeApp()
    const client = testClient(app, { env: {} })
    const res = await client.get("/openapi/json")
    const body = await res.json() as Record<string, unknown>
    expect(body.openapi).toBe("3.1.0")
    expect((body.info as Record<string, unknown>).title).toBe("Test API")
    expect(body.paths).toBeDefined()
  })

  it("spec reflects routes registered on the app", async () => {
    const app = makeApp()
    const client = testClient(app, { env: {} })
    const res = await client.get("/openapi/json")
    const body = await res.json() as Record<string, Record<string, unknown>>
    expect(body.paths["/health"]).toBeDefined()
    expect(body.paths["/users"]).toBeDefined()
    expect(body.paths["/users/{id}"]).toBeDefined()
  })

  it("spec is cached (same object on second call)", async () => {
    const app = makeApp()
    const client = testClient(app, { env: {} })
    const res1 = await client.get("/openapi/json")
    const body1 = await res1.text()
    const res2 = await client.get("/openapi/json")
    const body2 = await res2.text()
    expect(body1).toBe(body2)
  })

  it("openapi routes excluded from codegen output", async () => {
    const app = honey<{}>()
    app.get("/health").handler((ctx) => ctx.res.json("ok", { status: "ok" }))
    app.get("/openapi/json").handler(spec({ title: "API", version: "1.0" }))
    app.get("/openapi/scalar").handler(scalar({ url: "/openapi/json" }))
    app.get("/openapi/swagger").handler(swagger({ url: "/openapi/json" }))

    const manifest = generateManifest(app)
    const paths = manifest.routes.map((r) => r.path)
    expect(paths).toContain("/health")
    expect(paths).not.toContain("/openapi/json")
    expect(paths).not.toContain("/openapi/scalar")
    expect(paths).not.toContain("/openapi/swagger")

    const openApiSpec = await generateOpenApi(app, { info: { title: "API", version: "1.0" } })
    expect(openApiSpec.paths["/health"]).toBeDefined()
    expect(openApiSpec.paths["/openapi/json"]).toBeUndefined()
    expect(openApiSpec.paths["/openapi/scalar"]).toBeUndefined()
    expect(openApiSpec.paths["/openapi/swagger"]).toBeUndefined()
  })

  it("filter option excludes routes from spec response", async () => {
    const app = honey<{}>().meta<{ auth?: false | string }>()
    app.get("/public")
      .meta({ auth: false })
      .handler((ctx) => ctx.res.json("ok", { ok: true }))
    app.get("/dashboard")
      .meta({ auth: "jwt" })
      .handler((ctx) => ctx.res.json("ok", { ok: true }))
    app.get("/openapi/json").handler(
      spec({
        filterRoutes: (route) => (route.meta as Record<string, unknown>)?.auth !== "jwt",
        title: "API",
        version: "1.0",
      }),
    )
    const client = testClient(app, { env: {} })
    const res = await client.get("/openapi/json")
    const body = await res.json() as Record<string, Record<string, unknown>>
    expect(body.paths["/public"]).toBeDefined()
    expect(body.paths["/dashboard"]).toBeUndefined()
  })

  it("description is included when provided", async () => {
    const app = honey<{}>()
    app.get("/health").handler((ctx) => ctx.res.json("ok", { status: "ok" }))
    app.get("/openapi/json").handler(
      spec({ description: "My API description", title: "API", version: "1.0" }),
    )
    const client = testClient(app, { env: {} })
    const res = await client.get("/openapi/json")
    const body = await res.json() as Record<string, unknown>
    expect((body.info as Record<string, unknown>).description).toBe("My API description")
  })
})
