import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"
import { poweredBy } from "../../../src/powered-by.ts"
import { requestId } from "../../../src/request-id.ts"
import { secureHeaders } from "../../../src/secure-headers.ts"
import { serverTiming } from "../../../src/server-timing.ts"

describe("res.raw with response middleware", () => {
	it("serves a guarded response through middleware that sets headers", async () => {
		const app = honey().use(requestId()).use(secureHeaders()).use(poweredBy()).use(serverTiming())
		app.get("/asset").handler((ctx) => ctx.res.raw(Response.redirect("https://example.com/asset.json", 302)))

		const response = await app.fetch(new Request("http://localhost/asset", { headers: { "x-request-id": "rid-1" } }))

		expect(response.status).toBe(302)
		expect(response.headers.get("location")).toBe("https://example.com/asset.json")
		expect(response.headers.get("x-request-id")).toBe("rid-1")
		expect(response.headers.get("x-powered-by")).not.toBeNull()
		expect(response.headers.get("server-timing")).not.toBeNull()
	})
})
