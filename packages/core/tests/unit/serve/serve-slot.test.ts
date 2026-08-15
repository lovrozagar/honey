import { describe, expect, it } from "vitest"
import { enableServe } from "../../../src/serve-register.ts"
import { getServeRuntime, resetServeRuntime } from "../../../src/serve-slot.ts"
import { honey } from "../../../src/index.ts"

describe("serve runtime slot", () => {
	it("app.serve() loads honey/serve without a consumer import", async () => {
		resetServeRuntime()
		expect(() => getServeRuntime()).toThrow(/honey\/serve/)

		const handle = await honey()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "ok"))
			.serve({ hostname: "127.0.0.1", port: 0, runtime: "node" })
		try {
			expect(getServeRuntime()).toBeTypeOf("function")
			const res = await fetch(`${handle.url}/health`)
			expect(res.status).toBe(200)
			expect(await res.text()).toBe("ok")
		} finally {
			await handle.close()
			enableServe()
		}
	})
})
