import { describe, expect, test } from "bun:test"
import { compareApps, probesFromTree } from "../../differential.ts"
import { routeTree } from "../src/_gen/routes.gen.ts"
import { createApp } from "../src/app.ts"

const app = createApp()

async function fetchApp(path: string, init?: RequestInit): Promise<Response> {
	return app.fetch(new Request(`http://honey.test${path}`, init), {})
}

describe("e2e defaults consumes honey", () => {
	test("GET /health", async () => {
		const res = await fetchApp("/health")
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("ok")
	})

	test("GET /openapi.json is a 3.1 spec at the origin root", async () => {
		const res = await fetchApp("/openapi.json")
		expect(res.status).toBe(200)
		const spec = (await res.json()) as {
			info: { title: string }
			openapi: string
			paths: Record<string, unknown>
		}
		expect(spec.openapi).toBe("3.1.0")
		expect(spec.info.title).toBe("Honey Defaults")
		expect(spec.paths["/health"]).toBeDefined()
		expect(spec.paths["/openapi.json"]).toBeUndefined()
	})

	test("no CORS headers without middleware", async () => {
		const res = await fetchApp("/health", { headers: { origin: "http://localhost:3000" } })
		expect(res.status).toBe(200)
		expect(res.headers.get("access-control-allow-origin")).toBeNull()
	})
})

describe("serves identically from its generated route tree", () => {
	test("boots with .routeTree() and answers every probe like the runtime trie", async () => {
		const probes = probesFromTree(routeTree, (p) => p)
		expect(probes.length).toBeGreaterThan(5)
		expect(await compareApps(createApp(), createApp(undefined, { routeTree }), probes)).toEqual([])
	})
})
