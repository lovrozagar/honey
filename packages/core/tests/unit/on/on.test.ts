import { describe, expect, it } from "vitest"
import { Honey } from "../../../src/index.ts"

function makeRequest(method: string, path: string) {
	return new Request(`http://localhost${path}`, { method })
}

describe(".on() multi-method routing", () => {
	it("matches GET and POST on same path", async () => {
		const app = new Honey()
			.on(["GET", "POST"], "/users")
			.handler((ctx) => ctx.res.json("ok", { method: ctx.req.method }))

		const getRes = await app.fetch(makeRequest("GET", "/users"), {} as never)
		const postRes = await app.fetch(makeRequest("POST", "/users"), {} as never)
		expect(getRes.status).toBe(200)
		expect(postRes.status).toBe(200)
		expect(((await getRes.json()) as { method: string }).method).toBe("GET")
		expect(((await postRes.json()) as { method: string }).method).toBe("POST")
	})

	it("returns 405 for methods not in the list", async () => {
		const app = new Honey().on(["GET", "POST"], "/users").handler((ctx) => ctx.res.json("ok", { ok: true }))

		const res = await app.fetch(makeRequest("DELETE", "/users"), {} as never)
		expect(res.status).toBe(405)
	})

	it("works with middleware chain", async () => {
		const app = new Honey()
			.use(async (_ctx, next) => next({ injected: "yes" }))
			.on(["PUT", "PATCH"], "/items/:id")
			.handler((ctx) => {
				const c = ctx as Record<string, unknown>
				return ctx.res.json("ok", { id: ctx.params.id, injected: c.injected })
			})

		const putRes = await app.fetch(makeRequest("PUT", "/items/42"), {} as never)
		const body = (await putRes.json()) as { id: string; injected: string }
		expect(body.id).toBe("42")
		expect(body.injected).toBe("yes")
	})

	it("works with meta", async () => {
		const app = new Honey()
			.meta<{ tag: string }>()
			.on(["GET", "POST"], "/data")
			.meta({ tag: "data-route" })
			.handler((ctx) => ctx.res.json("ok", { tag: ctx.meta.tag }))

		const res = await app.fetch(makeRequest("GET", "/data"), {} as never)
		const body = (await res.json()) as { tag: string }
		expect(body.tag).toBe("data-route")
	})

	it("works with proxy terminal", async () => {
		const app = new Honey().on(["GET", "POST", "PUT"], "/api/*").proxy({
			destination: (_ctx, url, init) => new Response(JSON.stringify({ method: init.method, url })),
		})

		const getRes = await app.fetch(makeRequest("GET", "/api/test"), {} as never)
		const putRes = await app.fetch(makeRequest("PUT", "/api/test"), {} as never)
		const getBody = (await getRes.json()) as { method: string; url: string }
		const putBody = (await putRes.json()) as { method: string; url: string }
		expect(getBody.method).toBe("GET")
		expect(putBody.method).toBe("PUT")
	})

	it("single method array acts like individual method", async () => {
		const app = new Honey()
			.on(["DELETE"], "/items/:id")
			.handler((ctx) => ctx.res.json("ok", { deleted: ctx.params.id }))

		const res = await app.fetch(makeRequest("DELETE", "/items/99"), {} as never)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { deleted: string }
		expect(body.deleted).toBe("99")
	})
})
