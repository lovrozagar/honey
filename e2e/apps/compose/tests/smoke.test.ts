import { describe, expect, test } from "bun:test"
import { compareApps, probesFromTree } from "../../differential.ts"
import { routeTree } from "../src/_gen/routes.gen.ts"
import { createApp } from "../src/app.ts"

const app = createApp()

async function fetchApp(path: string, init?: RequestInit): Promise<Response> {
	return app.fetch(new Request(`http://honey.test${path}`, init), {})
}

describe("e2e compose consumes honey", () => {
	test("GET /health uses composed middleware", async () => {
		const res = await fetchApp("/health")
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ cached: null, status: "up" })
	})

	test("GET /docs is the user route, not Scalar", async () => {
		const res = await fetchApp("/docs")
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("API documentation")
	})
})

describe("serves identically from its generated route tree", () => {
	test("boots with .routeTree() and answers every probe like the runtime trie", async () => {
		const probes = probesFromTree(routeTree, (p) => p)
		expect(probes.length).toBeGreaterThan(5)
		expect(await compareApps(createApp(), createApp(undefined, { routeTree }), probes)).toEqual([])
	})
})
