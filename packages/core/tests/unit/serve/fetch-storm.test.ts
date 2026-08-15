import { describe, expect, it } from "vitest"
import * as z from "zod"
import "honey/openapi"
import { createMiddleware, defineErrors, honey } from "../../../src/index.ts"
import { cors } from "../../../src/cors.ts"

const N = 2_000
const errors = defineErrors({
	bad_input: "bad_request",
	gone: "not_found",
})

function json(path: string, body: unknown): Request {
	return new Request(`http://x${path}`, {
		body: JSON.stringify(body),
		headers: { "content-type": "application/json" },
		method: "POST",
	})
}

describe("fetch storm", () => {
	it("happy + validation + typed errors stay correct under concurrency", async () => {
		const app = honey()
			.errorFactory(errors)
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "ok"))
			.post("/echo")
			.input({ json: z.object({ n: z.number() }) })
			.handler((ctx) => ctx.res.json("ok", { n: ctx.input.json.n }))
			.get("/fail")
			.errors("gone")
			.handler((ctx) => {
				throw ctx.errors.gone()
			})

		const jobs: Array<Promise<{ kind: string; status: number; body: string }>> = []
		for (let i = 0; i < N; i++) {
			const lane = i % 4
			if (lane === 0) {
				jobs.push(
					Promise.resolve(app.fetch(new Request("http://x/health"), {})).then(async (r) => ({
						body: await r.text(),
						kind: "health",
						status: r.status,
					})),
				)
			} else if (lane === 1) {
				jobs.push(
					Promise.resolve(app.fetch(json("/echo", { n: i }), {})).then(async (r) => ({
						body: await r.text(),
						kind: "echo",
						status: r.status,
					})),
				)
			} else if (lane === 2) {
				jobs.push(
					Promise.resolve(app.fetch(json("/echo", { n: "nope" }), {})).then(async (r) => ({
						body: await r.text(),
						kind: "invalid",
						status: r.status,
					})),
				)
			} else {
				jobs.push(
					Promise.resolve(app.fetch(new Request("http://x/fail"), {})).then(async (r) => ({
						body: await r.text(),
						kind: "fail",
						status: r.status,
					})),
				)
			}
		}

		const results = await Promise.all(jobs)
		expect(results).toHaveLength(N)
		for (const r of results) {
			if (r.kind === "health") {
				expect(r.status).toBe(200)
				expect(r.body).toBe("ok")
			} else if (r.kind === "echo") {
				expect(r.status).toBe(200)
				expect(JSON.parse(r.body).n).toEqual(expect.any(Number))
			} else if (r.kind === "invalid") {
				expect(r.status).toBeGreaterThanOrEqual(400)
				expect(r.status).toBeLessThan(500)
			} else {
				expect(r.status).toBe(404)
			}
		}
	})

	it("route() + scoped use stay correct; 404+CORS on the corsed instance", async () => {
		const withId = createMiddleware(async (_c, next) => next({ rid: "r1" }))
		const parent = honey().use(cors({ origin: "*" }))
		const child = parent.use("/admin", withId).get("/admin/x").handler((ctx) => {
			return ctx.res.json("ok", { rid: ctx.rid })
		})
		const extra = honey().get("/extra").handler((ctx) => ctx.res.text("ok", "extra"))
		const app = child.route(extra)

		const jobs = [
			...Array.from({ length: N / 2 }, () =>
				app.fetch(new Request("http://x/admin/x", { headers: { origin: "http://app.example" } }), {}),
			),
			...Array.from({ length: N / 4 }, () => app.fetch(new Request("http://x/extra"), {})),
			...Array.from({ length: N / 4 }, () =>
				app.fetch(
					new Request("http://x/missing", {
						headers: {
							"access-control-request-method": "GET",
							origin: "http://app.example",
						},
						method: "OPTIONS",
					}),
					{},
				),
			),
		]

		const results = await Promise.all(jobs)
		const admin = results.slice(0, N / 2)
		const extras = results.slice(N / 2, N / 2 + N / 4)
		const missing = results.slice(N / 2 + N / 4)

		for (const r of admin) {
			expect(r.status).toBe(200)
			expect(r.headers.get("access-control-allow-origin")).toBeTruthy()
			expect(await r.json()).toEqual({ rid: "r1" })
		}
		for (const r of extras) {
			expect(r.status).toBe(200)
			expect(await r.text()).toBe("extra")
		}
		for (const r of missing) {
			expect(r.status).toBe(204)
			expect(r.headers.get("access-control-allow-origin")).toBeTruthy()
		}
	})

	it("openapi cache is stable across a storm and refreshes after a new route", async () => {
		const app = honey()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "ok"))
		app.openapi({ title: "Storm", version: "1.0.0" })

		const first = await Promise.all(
			Array.from({ length: N }, () => app.fetch(new Request("http://x/openapi.json"), {})),
		)
		const bodies = await Promise.all(first.map((r) => r.json()))
		for (const r of first) expect(r.status).toBe(200)
		const title = (bodies[0] as { info: { title: string } }).info.title
		expect(title).toBe("Storm")
		for (const b of bodies) {
			expect((b as { info: { title: string } }).info.title).toBe("Storm")
			expect((b as { paths: Record<string, unknown> }).paths["/health"]).toBeDefined()
			expect((b as { paths: Record<string, unknown> }).paths["/later"]).toBeUndefined()
		}

		app.get("/later").handler((ctx) => ctx.res.text("ok", "later"))
		const after = await app.fetch(new Request("http://x/openapi.json"), {})
		const spec = (await after.json()) as { paths: Record<string, unknown> }
		expect(spec.paths["/health"]).toBeDefined()
		expect(spec.paths["/later"]).toBeDefined()
	})
})
