import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"
import { testClient } from "../../../src/testing.ts"
import { scalar } from "../../../src/openapi/scalar.ts"

describe("scalar", () => {
  it("returns a handler function", () => {
    const handler = scalar({ url: "/openapi/json" })
    expect(typeof handler).toBe("function")
  })

  it("GET /openapi/scalar → 200 with text/html", async () => {
    const app = honey<{}>()
    app.get("/openapi/scalar").handler(scalar({ url: "/openapi/json" }))
    const client = testClient(app, { env: {} })
    const res = await client.get("/openapi/scalar")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
  })

  it("HTML contains Scalar CDN script", async () => {
    const app = honey<{}>()
    app.get("/openapi/scalar").handler(scalar({ url: "/openapi/json" }))
    const client = testClient(app, { env: {} })
    const res = await client.get("/openapi/scalar")
    const html = await res.text()
    expect(html).toContain("cdn.jsdelivr.net/npm/@scalar/api-reference")
  })

  it("HTML contains the spec URL from config", async () => {
    const app = honey<{}>()
    app.get("/docs").handler(scalar({ url: "/api/spec.json" }))
    const client = testClient(app, { env: {} })
    const res = await client.get("/docs")
    const html = await res.text()
    expect(html).toContain("/api/spec.json")
  })

  it("custom config (theme) is embedded in HTML", async () => {
    const app = honey<{}>()
    app.get("/docs").handler(scalar({ theme: "purple", url: "/openapi/json" }))
    const client = testClient(app, { env: {} })
    const res = await client.get("/docs")
    const html = await res.text()
    expect(html).toContain("purple")
  })
})
