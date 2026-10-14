import { afterEach, describe, expect, it } from "vitest"
import { compileTrust } from "../trust/trust.ts"
import { registerFeature, requireFeature, resetFeature } from "./feature-slots.ts"

describe("feature slots", () => {
	afterEach(() => {
		registerFeature("trust", { compileTrust })
	})

	it("hands back the feature its entry registered on import", () => {
		expect(requireFeature("trust", "app.trustProxy()").compileTrust).toBe(compileTrust)
	})

	it("names the import a caller needs when the entry was not imported", () => {
		resetFeature("trust")
		expect(() => requireFeature("trust", "app.trustProxy()")).toThrow(
			'honey: app.trustProxy() requires `import "@lovrozagar/honey/trust"` in the app entry.',
		)
	})
})
