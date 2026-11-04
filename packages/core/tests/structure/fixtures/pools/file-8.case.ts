import { expect, it } from "vitest"

it("reports its pool", () => {
	expect(process.env.VITEST_POOL_ID).toBe("none")
})
