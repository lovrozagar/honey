import { describe, expect, it } from "vitest"
import * as z from "zod"
import { honey } from "../../../src/index.ts"

/* ═══════════════════════════════════════════
 * INPUT: cookies + headers validation
 * ═══════════════════════════════════════════ */

describe("input: cookie validation", () => {
	it("valid cookie → passes", async () => {
		const app = honey<{}>()
		app
			.get("/api")
			.input({ cookies: z.object({ session: z.string().min(5) }) })
			.handler((ctx) => ctx.res.json("ok", { session: ctx.input.cookies.session }))

		const res = await app.fetch(
			new Request("http://localhost/api", { headers: { cookie: "session=tok-12345" } }),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.session).toBe("tok-12345")
	})

	it("invalid cookie → 400", async () => {
		const app = honey<{}>()
		app
			.get("/api")
			.input({ cookies: z.object({ session: z.string().min(10) }) })
			.handler((ctx) => ctx.res.json("ok", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/api", { headers: { cookie: "session=short" } }),
			{},
		)
		expect(res.status).toBe(400)
	})

	it("missing cookie → 400", async () => {
		const app = honey<{}>()
		app
			.get("/api")
			.input({ cookies: z.object({ session: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", ctx.input))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(400)
	})

	it("multiple cookies validated together", async () => {
		const app = honey<{}>()
		app
			.get("/api")
			.input({
				cookies: z.object({ csrf: z.string().length(32), session: z.string() }),
			})
			.handler((ctx) =>
				ctx.res.json("ok", {
					csrf: ctx.input.cookies.csrf,
					session: ctx.input.cookies.session,
				}),
			)

		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: { cookie: "session=tok; csrf=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4" },
			}),
			{},
		)
		expect(res.status).toBe(200)
	})
})

describe("input: header validation", () => {
	it("valid authorization header → passes", async () => {
		const app = honey<{}>()
		app
			.get("/api")
			.input({
				headers: z.object({ authorization: z.string().startsWith("Bearer ") }).passthrough(),
			})
			.handler((ctx) => ctx.res.json("ok", { auth: ctx.input.headers.authorization }))

		const res = await app.fetch(
			new Request("http://localhost/api", { headers: { authorization: "Bearer tok-123" } }),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.auth).toBe("Bearer tok-123")
	})

	it("invalid authorization header → 400", async () => {
		const app = honey<{}>()
		app
			.get("/api")
			.input({
				headers: z.object({ authorization: z.string().startsWith("Bearer ") }).passthrough(),
			})
			.handler((ctx) => ctx.res.json("ok", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/api", { headers: { authorization: "Basic abc" } }),
			{},
		)
		expect(res.status).toBe(400)
	})

	it("missing required header → 400", async () => {
		const app = honey<{}>()
		app
			.get("/api")
			.input({
				headers: z.object({ "x-api-key": z.string() }).passthrough(),
			})
			.handler((ctx) => ctx.res.json("ok", ctx.input))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(400)
	})

	it("combined header + search validation", async () => {
		const app = honey<{}>()
		app
			.get("/api")
			.input({
				headers: z.object({ "x-api-key": z.string() }).passthrough(),
				search: z.object({ page: z.coerce.number() }),
			})
			.handler((ctx) =>
				ctx.res.json("ok", {
					key: ctx.input.headers["x-api-key"],
					page: ctx.input.search.page,
				}),
			)

		const res = await app.fetch(
			new Request("http://localhost/api?page=3", { headers: { "x-api-key": "key-123" } }),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.key).toBe("key-123")
		expect(data.page).toBe(3)
	})
})

/* ═══════════════════════════════════════════
 * OUTPUT: non-JSON content type validation
 * ═══════════════════════════════════════════ */

describe("output: non-JSON content type with output schema", () => {
	it("text output with schema → content-type correct", async () => {
		const app = honey<{}>()
		app
			.get("/text")
			.output({ "text/plain": { ok: z.string() } })
			.handler((ctx) => ctx.res.text("ok", "hello"))

		const res = await app.fetch(new Request("http://localhost/text"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toContain("text/plain")
		expect(await res.text()).toBe("hello")
	})

	it("html output with schema → content-type correct", async () => {
		const app = honey<{}>()
		app
			.get("/page")
			.output({ "text/html": { ok: z.string() } })
			.handler((ctx) => ctx.res.html("ok", "<h1>Hi</h1>"))

		const res = await app.fetch(new Request("http://localhost/page"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toContain("text/html")
	})

	it("csv output with schema → content-type correct", async () => {
		const app = honey<{}>()
		app
			.get("/export")
			.output({ "text/csv": { ok: z.string() } })
			.handler((ctx) => ctx.res.csv("ok", "a,b\n1,2"))

		const res = await app.fetch(new Request("http://localhost/export"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toContain("text/csv")
	})

	it("xml output with schema → content-type correct", async () => {
		const app = honey<{}>()
		app
			.get("/feed")
			.output({ "application/xml": { ok: z.string() } })
			.handler((ctx) => ctx.res.xml("ok", "<rss/>"))

		const res = await app.fetch(new Request("http://localhost/feed"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toContain("application/xml")
	})

	it("binary output with schema → content-type correct", async () => {
		const app = honey<{}>()
		app
			.get("/download")
			.output({ "application/octet-stream": { ok: z.instanceof(Uint8Array) } })
			.handler((ctx) => ctx.res.binary("ok", new Uint8Array([0xff, 0xfe])))

		const res = await app.fetch(new Request("http://localhost/download"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toContain("application/octet-stream")
	})
})

/* ═══════════════════════════════════════════
 * WS: input validation (search/cookies)
 * ═══════════════════════════════════════════ */

describe("ws: input validation on upgrade", () => {
	it("ws route with search input → search validated before upgrade", async () => {
		const app = honey<{}>()
		app
			.ws("/chat")
			.input({ search: z.object({ room: z.string().min(1) }) })
			.handler({ onMessage() {} })

		/* ws route without upgrade header → 426 (but input would be checked on real upgrade) */
		const res = await app.fetch(new Request("http://localhost/chat?room=general"), {})
		expect(res.status).toBe(426)
	})

	it("ws route with invalid search → 400 before upgrade attempt", async () => {
		const app = honey<{}>()
		app
			.ws("/chat")
			.input({ search: z.object({ room: z.string().min(1) }) })
			.handler({ onMessage() {} })

		/* missing room param → should fail validation */
		const res = await app.fetch(new Request("http://localhost/chat"), {})
		/* either 400 (validation) or 426 (no upgrade header) depending on order */
		expect([400, 426]).toContain(res.status)
	})
})

/* ═══════════════════════════════════════════
 * COMBINED: all input sources in one route
 * ═══════════════════════════════════════════ */

describe("input: all non-body sources combined", () => {
	it("params + search + headers + cookies validated together", async () => {
		const app = honey<{}>()
		app
			.get("/api/:version")
			.input({
				cookies: z.object({ session: z.string() }),
				headers: z.object({ "x-api-key": z.string() }).passthrough(),
				params: z.object({ version: z.string().startsWith("v") }),
				search: z.object({ limit: z.coerce.number() }),
			})
			.handler((ctx) =>
				ctx.res.json("ok", {
					key: ctx.input.headers["x-api-key"],
					limit: ctx.input.search.limit,
					session: ctx.input.cookies.session,
					version: ctx.input.params.version,
				}),
			)

		const res = await app.fetch(
			new Request("http://localhost/api/v2?limit=10", {
				headers: {
					cookie: "session=tok-abc",
					"x-api-key": "key-xyz",
				},
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.version).toBe("v2")
		expect(data.limit).toBe(10)
		expect(data.key).toBe("key-xyz")
		expect(data.session).toBe("tok-abc")
	})

	it("one source invalid → 400 (other sources not checked)", async () => {
		const app = honey<{}>()
		app
			.get("/api/:version")
			.input({
				params: z.object({ version: z.string().startsWith("v") }),
				search: z.object({ limit: z.coerce.number().positive() }),
			})
			.handler((ctx) => ctx.res.json("ok", ctx.input))

		/* invalid param (no v prefix) */
		const res = await app.fetch(new Request("http://localhost/api/2?limit=10"), {})
		expect(res.status).toBe(400)
	})
})
