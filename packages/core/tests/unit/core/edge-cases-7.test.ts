import { describe, expect, it } from "vitest"
import * as z from "zod"
import { cors } from "../../../src/cors.ts"
import { csrf } from "../../../src/csrf.ts"
import { honey } from "../../../src/index.ts"

/* ═══════════════════════════════════════════
 * CORS: multiple/dynamic origins
 * ═══════════════════════════════════════════ */

describe("cors: origin array", () => {
	it("request from allowed origin in array → CORS headers", async () => {
		const app = honey<{}>().use(cors({ origin: ["http://a.com", "http://b.com"] }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/api", { headers: { origin: "http://b.com" } }), {})
		expect(res.headers.get("access-control-allow-origin")).toBe("http://b.com")
	})

	it("request from disallowed origin → no CORS origin header", async () => {
		const app = honey<{}>().use(cors({ origin: ["http://a.com", "http://b.com"] }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/api", { headers: { origin: "http://evil.com" } }), {})
		expect(res.headers.get("access-control-allow-origin")).toBeNull()
	})
})

describe("cors: dynamic origin function", () => {
	it("function returning true → origin allowed", async () => {
		const app = honey<{}>().use(cors({ origin: (o) => o.endsWith(".example.com") }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", { headers: { origin: "http://app.example.com" } }),
			{},
		)
		expect(res.headers.get("access-control-allow-origin")).toBe("http://app.example.com")
	})

	it("function returning false → no CORS headers", async () => {
		const app = honey<{}>().use(cors({ origin: (o) => o.endsWith(".example.com") }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/api", { headers: { origin: "http://evil.com" } }), {})
		expect(res.headers.get("access-control-allow-origin")).toBeNull()
	})
})

describe("cors: wildcard origin", () => {
	it("origin: * → allows any origin", async () => {
		const app = honey<{}>().use(cors({ origin: "*" }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/api", { headers: { origin: "http://anything.com" } }), {})
		expect(res.headers.get("access-control-allow-origin")).toBe("*")
	})
})

describe("cors: no origin header (non-CORS request)", () => {
	it("no origin header → no CORS headers added", async () => {
		const app = honey<{}>().use(cors({ origin: "http://app.com" }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.headers.get("access-control-allow-origin")).toBeNull()
	})
})

/* ═══════════════════════════════════════════
 * CSRF: same-origin, null origin
 * ═══════════════════════════════════════════ */

describe("csrf: origin checks", () => {
	it("same-origin via Sec-Fetch-Site → passes", async () => {
		const app = honey<{}>().use(csrf({ origin: "http://app.com" }))
		app.post("/api").handler((ctx) => ctx.res.json("created", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				body: "x=1",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					"sec-fetch-site": "same-origin",
				},
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
	})

	it("cross-origin without allowed origin → 403", async () => {
		const app = honey<{}>().use(csrf({ origin: "http://app.com" }))
		app.post("/api").handler((ctx) => ctx.res.json("created", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				body: "x=1",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					origin: "http://evil.com",
				},
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(403)
	})

	it("matching origin → passes", async () => {
		const app = honey<{}>().use(csrf({ origin: "http://app.com" }))
		app.post("/api").handler((ctx) => ctx.res.json("created", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				body: "x=1",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					origin: "http://app.com",
				},
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
	})

	it("null origin (privacy redirect) → 403", async () => {
		const app = honey<{}>().use(csrf({ origin: "http://app.com" }))
		app.post("/api").handler((ctx) => ctx.res.json("created", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				body: "x=1",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					origin: "null",
				},
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(403)
	})

	it("GET method → skips CSRF check", async () => {
		const app = honey<{}>().use(csrf({ origin: "http://app.com" }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/api", { headers: { origin: "http://evil.com" } }), {})
		expect(res.status).toBe(200)
	})

	it("JSON content-type → skips CSRF check (not a form)", async () => {
		const app = honey<{}>().use(csrf({ origin: "http://app.com" }))
		app.post("/api").handler((ctx) => ctx.res.json("created", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				body: "{}",
				headers: {
					"content-type": "application/json",
					origin: "http://evil.com",
				},
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
	})

	it("origin array → matches any in list", async () => {
		const app = honey<{}>().use(csrf({ origin: ["http://a.com", "http://b.com"] }))
		app.post("/api").handler((ctx) => ctx.res.json("created", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				body: "x=1",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					origin: "http://b.com",
				},
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
	})
})

/* ═══════════════════════════════════════════
 * DUPLICATE ROUTE REGISTRATION
 * ═══════════════════════════════════════════ */

describe("duplicate route registration", () => {
	it("same path + same method registered twice → throws", () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.json("ok", { v: 1 }))
		expect(() => app.get("/test").handler((ctx) => ctx.res.json("ok", { v: 2 }))).toThrow()
	})

	it("same path different method → no conflict", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.json("ok", { method: "get" }))
		app.post("/test").handler((ctx) => ctx.res.json("created", { method: "post" }))

		const getRes = await app.fetch(new Request("http://localhost/test"), {})
		expect(getRes.status).toBe(200)
		const postRes = await app.fetch(new Request("http://localhost/test", { method: "POST" }), {})
		expect(postRes.status).toBe(201)
	})
})

/* ═══════════════════════════════════════════
 * INPUT: params coercion/transform
 * ═══════════════════════════════════════════ */

describe("input: params coercion", () => {
	it("z.coerce.number on param → string coerced to number", async () => {
		const app = honey<{}>()
		app
			.get("/items/:id")
			.input({ params: z.object({ id: z.coerce.number() }) })
			.handler((ctx) =>
				ctx.res.json("ok", {
					id: ctx.input.params.id,
					isNum: typeof ctx.input.params.id === "number",
				}),
			)

		const res = await app.fetch(new Request("http://localhost/items/42"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.id).toBe(42)
		expect(data.isNum).toBe(true)
	})

	it("z.coerce.number on non-numeric param → 400", async () => {
		const app = honey<{}>()
		app
			.get("/items/:id")
			.input({ params: z.object({ id: z.coerce.number().int().positive() }) })
			.handler((ctx) => ctx.res.json("ok", ctx.input))

		const res = await app.fetch(new Request("http://localhost/items/abc"), {})
		expect(res.status).toBe(400)
	})

	it("z.string().uuid() on param → validates format", async () => {
		const app = honey<{}>()
		app
			.get("/items/:id")
			.input({ params: z.object({ id: z.string().uuid() }) })
			.handler((ctx) => ctx.res.json("ok", ctx.input))

		const validRes = await app.fetch(new Request("http://localhost/items/550e8400-e29b-41d4-a716-446655440000"), {})
		expect(validRes.status).toBe(200)

		const invalidRes = await app.fetch(new Request("http://localhost/items/not-a-uuid"), {})
		expect(invalidRes.status).toBe(400)
	})
})

/* ═══════════════════════════════════════════
 * INPUT + OUTPUT: same route full pipeline
 * ═══════════════════════════════════════════ */

describe("input + output: full pipeline", () => {
	it("input validated → handler processes → output validated", async () => {
		const app = honey<{}>().outputValidation("always")
		app
			.post("/users")
			.input({ json: z.object({ email: z.string().email(), name: z.string() }) })
			.output({ "application/json": { created: z.object({ id: z.number(), name: z.string() }) } })
			.handler((ctx) => ctx.res.json("created", { id: 1, name: ctx.input.json.name }))

		const res = await app.fetch(
			new Request("http://localhost/users", {
				body: JSON.stringify({ email: "alice@test.com", name: "Alice" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.name).toBe("Alice")
		expect(data.id).toBe(1)
	})

	it("invalid input → 400 before handler runs", async () => {
		let handlerCalled = false
		const app = honey<{}>()
		app
			.post("/users")
			.input({ json: z.object({ email: z.string().email() }) })
			.handler((ctx) => {
				handlerCalled = true
				return ctx.res.json("created", {})
			})

		await app.fetch(
			new Request("http://localhost/users", {
				body: JSON.stringify({ email: "invalid" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(handlerCalled).toBe(false)
	})
})

/* ═══════════════════════════════════════════
 * CONCURRENT REQUESTS: app state isolation
 * ═══════════════════════════════════════════ */

describe("concurrent requests: state isolation", () => {
	it("100 parallel requests with different params → no cross-contamination", async () => {
		const app = honey<{}>()
		app.get("/users/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

		const results = await Promise.all(
			Array.from({ length: 100 }, (_, i) =>
				Promise.resolve(app.fetch(new Request(`http://localhost/users/${i}`), {})).then(
					(r) => r.json() as Promise<Record<string, string>>,
				),
			),
		)

		for (let i = 0; i < 100; i++) {
			expect(results[i].id).toBe(String(i))
		}
	})

	it("parallel requests with input validation → each validates independently", async () => {
		const app = honey<{}>()
		app
			.post("/api")
			.input({ json: z.object({ value: z.number() }) })
			.handler((ctx) => ctx.res.json("created", { doubled: ctx.input.json.value * 2 }))

		const results = await Promise.all(
			Array.from({ length: 50 }, (_, i) =>
				Promise.resolve(
					app.fetch(
						new Request("http://localhost/api", {
							body: JSON.stringify({ value: i }),
							headers: { "content-type": "application/json" },
							method: "POST",
						}),
						{},
					),
				).then((r) => r.json() as Promise<Record<string, number>>),
			),
		)

		for (let i = 0; i < 50; i++) {
			expect(results[i].doubled).toBe(i * 2)
		}
	})
})

/* ═══════════════════════════════════════════
 * MIDDLEWARE: early return (short-circuit)
 * ═══════════════════════════════════════════ */

describe("middleware: short-circuit without calling next", () => {
	it("middleware returns response directly → handler never runs", async () => {
		let handlerRan = false
		const app = honey<{}>()
		app
			.get("/guarded")
			.use(async () => new Response("blocked", { status: 401 }))
			.handler((ctx) => {
				handlerRan = true
				return ctx.res.json("ok", {})
			})

		const res = await app.fetch(new Request("http://localhost/guarded"), {})
		expect(res.status).toBe(401)
		expect(await res.text()).toBe("blocked")
		expect(handlerRan).toBe(false)
	})
})
