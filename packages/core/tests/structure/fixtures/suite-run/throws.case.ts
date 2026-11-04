import { expect, it } from "vitest"

/* a timer throws while the test still waits, so vitest reports it as unhandled every time; the test itself passes */
it("throws from a timer", async () => {
	setTimeout(() => {
		throw new Error("thrown from a timer, outside the test")
	})
	await new Promise((resolve) => setTimeout(resolve, 50))
	expect(1).toBe(1)
})
