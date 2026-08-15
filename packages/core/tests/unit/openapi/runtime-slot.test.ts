import { describe, expect, it } from "vitest"
import { enableOpenApi } from "../../../src/openapi/register.ts"
import { getOpenApiRuntime, resetOpenApiRuntime } from "../../../src/openapi/spec-factory.ts"
import { honey } from "../../../src/index.ts"

describe("OpenAPI runtime slot", () => {
	it("app.openapi() loads honey/openapi without a consumer import", async () => {
		resetOpenApiRuntime()
		expect(() => getOpenApiRuntime()).toThrow(/honey\/openapi/)

		const app = honey()
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		app.openapi({ title: "Demo", version: "1" })
		const res = await app.fetch(new Request("http://x/openapi.json"), {})
		expect(res.status).toBe(200)
		const spec = (await res.json()) as { info: { title: string } }
		expect(spec.info.title).toBe("Demo")
		enableOpenApi()
	})
})
