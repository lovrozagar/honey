/**
 * The tables gen restates because it never imports core (H2), compared to core's own: a drift
 * is a red here, not a wrong generated type later. Test-only, gen is imported by path.
 */
import { describe, expect, it } from "vitest"
import { STATUS_KEYS } from "../../../gen/src/emit/shared/status-keys.ts"
import { statusKeyToCode } from "../../src/response/status.ts"

describe("gen's status keys", () => {
	it("are core's status vocabulary, code for code", () => {
		const core = Object.fromEntries(Object.entries(statusKeyToCode).map(([key, code]) => [code, key]))
		expect(STATUS_KEYS).toEqual(core)
	})
})
