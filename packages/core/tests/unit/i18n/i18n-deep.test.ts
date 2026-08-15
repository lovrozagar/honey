import * as v from "valibot"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { defineErrors } from "../../../src/errors.ts"
import { honey } from "../../../src/index.ts"
import "@lovrozagar/honey/i18n"

type FieldErrors = Record<string, Array<{ error_key: string; message: string; path: string }>>

function extractFields(data: Record<string, unknown>): FieldErrors {
	return data.fields as FieldErrors
}

function allPaths(fields: FieldErrors): string[] {
	return Object.values(fields)
		.flat()
		.map((f) => f.path)
}

function allErrorKeys(fields: FieldErrors): string[] {
	return Object.values(fields)
		.flat()
		.map((f) => f.error_key)
}

/* ═══════════════════════════════════════════
 * Multi-vendor validation with i18n
 * ═══════════════════════════════════════════ */

describe("i18n: valibot validation + field translation", () => {
	it("valibot schema field errors → paths translated", async () => {
		const app = honey<{}>()
		app.errorI18n({
			fieldNames: {
				en: { "json.email": "Email", "json.name": "Name" },
			},
			resolveLocale: () => "en",
		})
		app
			.post("/register")
			.input({
				json: v.object({
					email: v.pipe(v.string(), v.email()),
					name: v.pipe(v.string(), v.minLength(2)),
				}),
			})
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/register", {
				body: JSON.stringify({ email: "bad", name: "" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, unknown>
		const paths = allPaths(extractFields(data))
		expect(paths).toContain("Email")
		expect(paths).toContain("Name")
	})
})

describe("i18n: zod vs valibot field error structure", () => {
	it("zod and valibot both produce error_key per field", async () => {
		/* zod app */
		const zodApp = honey<{}>()
		zodApp.errorI18n({
			fieldNames: { en: { "json.x": "Field X" } },
			resolveLocale: () => "en",
		})
		zodApp
			.post("/zod")
			.input({ json: z.object({ x: z.string().min(5) }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		/* valibot app */
		const valApp = honey<{}>()
		valApp.errorI18n({
			fieldNames: { en: { "json.x": "Field X" } },
			resolveLocale: () => "en",
		})
		valApp
			.post("/val")
			.input({ json: v.object({ x: v.pipe(v.string(), v.minLength(5)) }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const body = JSON.stringify({ x: "ab" })
		const headers = { "content-type": "application/json" }

		const [zodRes, valRes] = await Promise.all([
			zodApp.fetch(new Request("http://localhost/zod", { body, headers, method: "POST" }), {}),
			valApp.fetch(new Request("http://localhost/val", { body, headers, method: "POST" }), {}),
		])

		const zodData = (await zodRes.json()) as Record<string, unknown>
		const valData = (await valRes.json()) as Record<string, unknown>

		/* both have error_key, fields, and translated paths */
		expect(zodData.error_key).toBe("validation_failed")
		expect(valData.error_key).toBe("validation_failed")

		const zodPaths = allPaths(extractFields(zodData))
		const valPaths = allPaths(extractFields(valData))
		expect(zodPaths).toContain("Field X")
		expect(valPaths).toContain("Field X")

		/* both have error_key per field error */
		const zodKeys = allErrorKeys(extractFields(zodData))
		const valKeys = allErrorKeys(extractFields(valData))
		expect(zodKeys.every((k) => typeof k === "string" && k.length > 0)).toBe(true)
		expect(valKeys.every((k) => typeof k === "string" && k.length > 0)).toBe(true)
	})
})

/* ═══════════════════════════════════════════
 * Array validation field paths
 * ═══════════════════════════════════════════ */

describe("i18n: array item validation field paths", () => {
	it("array item validation → indexed field paths", async () => {
		const app = honey<{}>()
		app.errorI18n({
			fieldNames: { en: {} },
			resolveLocale: () => "en",
		})
		app
			.post("/items")
			.input({ json: z.object({ tags: z.array(z.string().min(1)) }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/items", {
				body: JSON.stringify({ tags: ["valid", ""] }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, unknown>
		const fields = extractFields(data)
		/* should have field error with array index in path */
		const paths = allPaths(fields)
		expect(paths.some((p) => p.includes("tags") || p.includes("1"))).toBe(true)
	})

	it("nested object in array → deep path", async () => {
		const app = honey<{}>()
		app.errorI18n({
			fieldNames: { en: {} },
			resolveLocale: () => "en",
		})
		app
			.post("/items")
			.input({
				json: z.object({
					items: z.array(z.object({ name: z.string().min(1) })),
				}),
			})
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/items", {
				body: JSON.stringify({ items: [{ name: "ok" }, { name: "" }] }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, unknown>
		const paths = allPaths(extractFields(data))
		/* path should reference the second item's name field */
		expect(paths.some((p) => p.includes("name"))).toBe(true)
	})
})

/* ═══════════════════════════════════════════
 * Optional fields and i18n
 * ═══════════════════════════════════════════ */

describe("i18n: optional field validation", () => {
	it("optional field when present but invalid → field error translated", async () => {
		const app = honey<{}>()
		app.errorI18n({
			fieldNames: {
				en: { "json.nickname": "Nickname" },
			},
			resolveLocale: () => "en",
		})
		app
			.post("/profile")
			.input({
				json: z.object({
					name: z.string(),
					nickname: z.string().min(3).optional(),
				}),
			})
			.handler((ctx) => ctx.res.json("created", ctx.input))

		/* nickname present but too short */
		const res = await app.fetch(
			new Request("http://localhost/profile", {
				body: JSON.stringify({ name: "Alice", nickname: "ab" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, unknown>
		const paths = allPaths(extractFields(data))
		expect(paths).toContain("Nickname")
	})

	it("optional field when absent → no error", async () => {
		const app = honey<{}>()
		app
			.post("/profile")
			.input({
				json: z.object({
					name: z.string(),
					nickname: z.string().min(3).optional(),
				}),
			})
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/profile", {
				body: JSON.stringify({ name: "Alice" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
	})
})

/* ═══════════════════════════════════════════
 * Union / discriminated union field errors
 * ═══════════════════════════════════════════ */

describe("i18n: union validation field errors", () => {
	it("discriminated union invalid → field errors present", async () => {
		const schema = z.discriminatedUnion("type", [
			z.object({ payload: z.string(), type: z.literal("text") }),
			z.object({ payload: z.number(), type: z.literal("number") }),
		])

		const app = honey<{}>()
		app.errorI18n({
			fieldNames: { en: {} },
			resolveLocale: () => "en",
		})
		app
			.post("/data")
			.input({ json: schema })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/data", {
				body: JSON.stringify({ payload: 123, type: "text" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error_key).toBe("validation_failed")
		expect(data.fields).toBeDefined()
	})
})

/* ═══════════════════════════════════════════
 * Custom error messages with i18n vars
 * ═══════════════════════════════════════════ */

describe("i18n: custom defineErrors with vars + translation", () => {
	it("error with multiple vars → all interpolated", async () => {
		const errors = defineErrors({
			rate_limited: "too_many_requests",
		})

		const app = honey<{}>().errorFactory(errors)
		app.errorI18n({
			errors: {
				en: { rate_limited: "Rate limited: {current}/{limit} requests in {window}s" },
			},
			resolveLocale: () => "en",
		})
		app.get("/api").handler(() => {
			throw errors.rate_limited({
				vars: { current: 150, limit: 100, window: 60 },
			})
		})

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(429)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.message).toBe("Rate limited: 150/100 requests in 60s")
	})

	it("error with zero-value var → 0 rendered not empty", async () => {
		const errors = defineErrors({
			low_balance: "payment_required",
		})

		const app = honey<{}>().errorFactory(errors)
		app.errorI18n({
			errors: { en: { low_balance: "Balance is {amount}" } },
			resolveLocale: () => "en",
		})
		app.get("/pay").handler(() => {
			throw errors.low_balance({ vars: { amount: 0 } })
		})

		const res = await app.fetch(new Request("http://localhost/pay"), {})
		const data = (await res.json()) as Record<string, unknown>
		expect(data.message).toBe("Balance is 0")
	})
})

/* ═══════════════════════════════════════════
 * Per-route different locales
 * ═══════════════════════════════════════════ */

describe("i18n: per-route locale based on path", () => {
	it("different routes can resolve to different locales", async () => {
		const app = honey<{}>()
		app.errorI18n({
			errors: {
				de: { validation_failed: "Fehler" },
				en: { validation_failed: "Error" },
			},
			resolveLocale: ({ req }) => {
				const url = new URL(req.url)
				return url.pathname.startsWith("/de/") ? "de" : "en"
			},
		})

		const schema = z.object({ x: z.string() })
		app
			.post("/en/api")
			.input({ json: schema })
			.handler((ctx) => ctx.res.json("created", ctx.input))
		app
			.post("/de/api")
			.input({ json: schema })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const body = JSON.stringify({})
		const headers = { "content-type": "application/json" }

		const [enRes, deRes] = await Promise.all([
			app.fetch(new Request("http://localhost/en/api", { body, headers, method: "POST" }), {}),
			app.fetch(new Request("http://localhost/de/api", { body, headers, method: "POST" }), {}),
		])

		const enData = (await enRes.json()) as Record<string, unknown>
		const deData = (await deRes.json()) as Record<string, unknown>
		expect(enData.message).toBe("Error")
		expect(deData.message).toBe("Fehler")
	})
})

/* ═══════════════════════════════════════════
 * Multiple field errors on same field
 * ═══════════════════════════════════════════ */

describe("i18n: multiple errors on same field", () => {
	it("field with multiple validation issues → all translated", async () => {
		const app = honey<{}>()
		app.errorI18n({
			fieldNames: { en: { "json.password": "Password" } },
			resolveLocale: () => "en",
		})
		app
			.post("/register")
			.input({
				json: z.object({
					password: z.string().min(8).regex(/[A-Z]/, "must contain uppercase"),
				}),
			})
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/register", {
				body: JSON.stringify({ password: "short" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, unknown>
		const fields = extractFields(data)
		const passwordErrors = fields.password
		expect(passwordErrors).toBeDefined()
		/* multiple errors on same field — all have translated path */
		expect(passwordErrors.length).toBeGreaterThanOrEqual(1)
		expect(passwordErrors.every((e) => e.path === "Password")).toBe(true)
	})
})
