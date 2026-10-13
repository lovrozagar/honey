import { afterEach, describe, expect, it } from "vitest"
import { registerFeature, requireFeature, resetFeature, type FeatureName } from "../../../src/feature-slots.ts"
import { honey } from "../../../src/index.ts"
import { createProxyHandler } from "../../../src/proxy.ts"
import { createBus } from "../../../src/realtime/bus.ts"
import { resolveRealtimeConfig } from "../../../src/realtime/route.ts"
import { createRealtimePublisher, createRealtimeSession } from "../../../src/realtime/server.ts"
import { compileTrust } from "../../../src/trust.ts"

/* the entries above registered themselves on import; each test removes one and restores it */
const REGISTERED = {
	proxy: { createProxyHandler },
	realtime: { createBus, createRealtimePublisher, createRealtimeSession, resolveRealtimeConfig },
	trust: { compileTrust },
}

let removed: Exclude<FeatureName, "ws"> | null = null
function without(name: Exclude<FeatureName, "ws">): void {
	removed = name
	resetFeature(name)
}

afterEach(() => {
	if (removed !== null) registerFeature(removed, REGISTERED[removed] as never)
	removed = null
})

describe("optional features fail at registration when their entry was not imported", () => {
	it(".proxy() names @lovrozagar/honey/proxy", () => {
		without("proxy")
		expect(() =>
			honey()
				.all("/*")
				.proxy({ destination: () => new Response() }),
		).toThrow('.proxy() requires `import "@lovrozagar/honey/proxy"`')
	})

	it("app.realtime() names @lovrozagar/honey/realtime", () => {
		without("realtime")
		expect(() => honey().realtime("/rt", { handler: () => {} })).toThrow(
			'app.realtime() requires `import "@lovrozagar/honey/realtime"`',
		)
	})

	it("app.trustProxy(hops) names @lovrozagar/honey/trust; the default needs nothing", () => {
		without("trust")
		expect(() => honey().trustProxy(1)).toThrow('app.trustProxy() requires `import "@lovrozagar/honey/trust"`')
		expect(() => honey().trustProxy(false)).not.toThrow()
	})

	it("an imported entry registers its feature", () => {
		expect(requireFeature("proxy", "x").createProxyHandler).toBe(createProxyHandler)
		expect(requireFeature("trust", "x").compileTrust).toBe(compileTrust)
	})
})
