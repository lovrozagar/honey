import { describe, expect, it } from "vitest"
import * as z from "zod"
import { defineErrors } from "../../../src/errors.ts"
import { honey } from "../../../src/index.ts"
import "@lovrozagar/honey/i18n"

describe("i18n: real validation → field errors → translation", () => {
	it("zod validation error → field names translated", async () => {
		const app = honey<{}>()
		app.errorI18n({
			fieldNames: {
				en: {
					"json.email": "Email Address",
					"json.name": "Full Name",
				},
			},
			resolveLocale: () => "en",
		})
		app
			.post("/users")
			.input({ json: z.object({ email: z.string().email(), name: z.string().min(2) }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/users", {
				body: JSON.stringify({ email: "not-email", name: "" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error_key).toBe("validation_failed")

		const fields = data.fields as Record<string, Array<Record<string, string>>>
		/* field paths should be translated */
		const allPaths = Object.values(fields)
			.flat()
			.map((f) => f.path)
		expect(allPaths).toContain("Email Address")
		expect(allPaths).toContain("Full Name")
	})

	it("zod validation error → error message translated", async () => {
		const app = honey<{}>()
		app.errorI18n({
			errors: {
				en: { validation_failed: "Input validation failed for your request" },
			},
			resolveLocale: () => "en",
		})
		app
			.post("/items")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/items", {
				body: JSON.stringify({ name: 123 }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.message).toBe("Input validation failed for your request")
	})

	it("locale from Accept-Language header", async () => {
		const app = honey<{}>()
		app.errorI18n({
			errors: {
				de: { validation_failed: "Eingabevalidierung fehlgeschlagen" },
				en: { validation_failed: "Validation failed" },
			},
			resolveLocale: ({ req }) => {
				const accept = req.headers.get("accept-language") ?? "en"
				return accept.startsWith("de") ? "de" : "en"
			},
		})
		app
			.post("/items")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		/* German request */
		const resDe = await app.fetch(
			new Request("http://localhost/items", {
				body: JSON.stringify({}),
				headers: {
					"accept-language": "de-DE",
					"content-type": "application/json",
				},
				method: "POST",
			}),
			{},
		)
		const dataDe = (await resDe.json()) as Record<string, unknown>
		expect(dataDe.message).toBe("Eingabevalidierung fehlgeschlagen")

		/* English request */
		const resEn = await app.fetch(
			new Request("http://localhost/items", {
				body: JSON.stringify({}),
				headers: {
					"accept-language": "en-US",
					"content-type": "application/json",
				},
				method: "POST",
			}),
			{},
		)
		const dataEn = (await resEn.json()) as Record<string, unknown>
		expect(dataEn.message).toBe("Validation failed")
	})

	it("untranslated locale → falls back to raw error key", async () => {
		const app = honey<{}>()
		app.errorI18n({
			errors: {
				en: { validation_failed: "Validation failed" },
			},
			resolveLocale: () => "fr",
		})
		app
			.post("/items")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/items", {
				body: JSON.stringify({}),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		const data = (await res.json()) as Record<string, unknown>
		/* no fr translation → message NOT overwritten, keeps original */
		expect(data.error_key).toBe("validation_failed")
	})

	it("multiple field errors → all paths translated", async () => {
		const app = honey<{}>()
		app.errorI18n({
			fieldNames: {
				en: {
					"json.age": "Age",
					"json.email": "Email",
					"json.name": "Name",
				},
			},
			resolveLocale: () => "en",
		})
		app
			.post("/register")
			.input({
				json: z.object({
					age: z.number().min(18),
					email: z.string().email(),
					name: z.string().min(1),
				}),
			})
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/register", {
				body: JSON.stringify({ age: 5, email: "bad", name: "" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, unknown>
		const fields = data.fields as Record<string, Array<Record<string, string>>>
		const allPaths = Object.values(fields)
			.flat()
			.map((f) => f.path)

		/* all three should be translated */
		expect(allPaths).toContain("Email")
		expect(allPaths).toContain("Name")
		expect(allPaths).toContain("Age")
	})

	it("field with no translation → keeps raw path", async () => {
		const app = honey<{}>()
		app.errorI18n({
			fieldNames: {
				en: { "json.email": "Email" },
			},
			resolveLocale: () => "en",
		})
		app
			.post("/register")
			.input({
				json: z.object({ email: z.string().email(), name: z.string().min(1) }),
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
		const data = (await res.json()) as Record<string, unknown>
		const fields = data.fields as Record<string, Array<Record<string, string>>>
		const allPaths = Object.values(fields)
			.flat()
			.map((f) => f.path)

		expect(allPaths).toContain("Email")
		/* name has no translation → keeps raw path */
		expect(allPaths.some((p) => p.includes("name"))).toBe(true)
	})

	it("search param validation → field paths use search prefix", async () => {
		const app = honey<{}>()
		app.errorI18n({
			fieldNames: {
				en: { "search.page": "Page Number" },
			},
			resolveLocale: () => "en",
		})
		app
			.get("/list")
			.input({ search: z.object({ page: z.coerce.number().min(1) }) })
			.handler((ctx) => ctx.res.json("ok", ctx.input))

		const res = await app.fetch(new Request("http://localhost/list?page=0"), {})
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, unknown>
		const fields = data.fields as Record<string, Array<Record<string, string>>>
		const allPaths = Object.values(fields)
			.flat()
			.map((f) => f.path)
		expect(allPaths).toContain("Page Number")
	})
})

describe("i18n: unprefixed field name fallback", () => {
	it("unprefixed key matches json. prefix", async () => {
		const app = honey<{}>()
		app.errorI18n({
			fieldNames: {
				en: { email: "Email Address", name: "Full Name" },
			},
			resolveLocale: () => "en",
		})
		app
			.post("/users")
			.input({ json: z.object({ email: z.string().email(), name: z.string().min(2) }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/users", {
				body: JSON.stringify({ email: "not-email", name: "" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, unknown>
		const fields = data.fields as Record<string, Array<Record<string, string>>>
		const allPaths = Object.values(fields)
			.flat()
			.map((f) => f.path)
		expect(allPaths).toContain("Email Address")
		expect(allPaths).toContain("Full Name")
	})

	it("unprefixed key matches search. prefix", async () => {
		const app = honey<{}>()
		app.errorI18n({
			fieldNames: {
				en: { page: "Page Number" },
			},
			resolveLocale: () => "en",
		})
		app
			.get("/list")
			.input({ search: z.object({ page: z.coerce.number().min(1) }) })
			.handler((ctx) => ctx.res.json("ok", ctx.input))

		const res = await app.fetch(new Request("http://localhost/list?page=0"), {})
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, unknown>
		const fields = data.fields as Record<string, Array<Record<string, string>>>
		const allPaths = Object.values(fields)
			.flat()
			.map((f) => f.path)
		expect(allPaths).toContain("Page Number")
	})

	it("exact prefixed key takes precedence over unprefixed fallback", async () => {
		const app = honey<{}>()
		app.errorI18n({
			fieldNames: {
				en: {
					"json.name": "JSON-specific Name",
					name: "Generic Name",
				},
			},
			resolveLocale: () => "en",
		})
		app
			.post("/users")
			.input({ json: z.object({ name: z.string().min(2) }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/users", {
				body: JSON.stringify({ name: "" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, unknown>
		const fields = data.fields as Record<string, Array<Record<string, string>>>
		const allPaths = Object.values(fields)
			.flat()
			.map((f) => f.path)
		/* exact prefixed key wins over unprefixed */
		expect(allPaths).toContain("JSON-specific Name")
		expect(allPaths).not.toContain("Generic Name")
	})
})

describe("i18n: error message interpolation with vars", () => {
	it("custom error with vars → interpolated in translated message", async () => {
		const errors = defineErrors({
			slug_taken: "conflict",
		})

		const app = honey<{}>().errorFactory(errors)
		app.errorI18n({
			errors: {
				en: { slug_taken: "The slug '{slug}' is already taken by org {orgId}" },
			},
			resolveLocale: () => "en",
		})
		app.get("/fail").handler(() => {
			throw errors.slug_taken({ vars: { orgId: 42, slug: "my-org" } })
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(409)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.message).toBe("The slug 'my-org' is already taken by org 42")
	})

	it("error with vars but no translation → message not overwritten", async () => {
		const errors = defineErrors({
			custom_err: "bad_request",
		})

		const app = honey<{}>().errorFactory(errors)
		app.errorI18n({
			errors: { en: {} },
			resolveLocale: () => "en",
		})
		app.get("/fail").handler(() => {
			throw errors.custom_err({ vars: { x: "y" } })
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error_key).toBe("custom_err")
	})
})

describe("i18n: async locale resolution", () => {
	it("resolveLocale can be async", async () => {
		const app = honey<{}>()
		app.errorI18n({
			errors: {
				en: { validation_failed: "Invalid input" },
				fr: { validation_failed: "Entrée invalide" },
			},
			resolveLocale: async ({ req }) => {
				await new Promise((r) => setTimeout(r, 1))
				return req.headers.get("x-locale") ?? "en"
			},
		})
		app
			.post("/items")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/items", {
				body: JSON.stringify({}),
				headers: { "content-type": "application/json", "x-locale": "fr" },
				method: "POST",
			}),
			{},
		)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.message).toBe("Entrée invalide")
	})
})

describe("i18n: env-based locale resolution", () => {
	it("resolveLocale receives env for per-tenant locale", async () => {
		const app = honey<{ DEFAULT_LOCALE: string }>()
		app.errorI18n({
			errors: {
				de: { validation_failed: "Ungültige Eingabe" },
				en: { validation_failed: "Invalid input" },
			},
			resolveLocale: ({ env }) => env.DEFAULT_LOCALE,
		})
		app
			.post("/items")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/items", {
				body: JSON.stringify({}),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{ DEFAULT_LOCALE: "de" },
		)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.message).toBe("Ungültige Eingabe")
	})
})

describe("i18n: resolveLocale receives full context", () => {
	it("resolveLocale receives headers", async () => {
		const app = honey<{}>()
		app.errorI18n({
			errors: { fr: { validation_failed: "Entrée invalide" } },
			resolveLocale: ({ headers }) => headers["accept-language"]?.split(",")[0] ?? "en",
		})
		app
			.post("/items")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/items", {
				body: JSON.stringify({}),
				headers: { "accept-language": "fr", "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.message).toBe("Entrée invalide")
	})

	it("resolveLocale receives cookies", async () => {
		const app = honey<{}>()
		app.errorI18n({
			errors: { de: { validation_failed: "Ungültig" } },
			resolveLocale: ({ cookies }) => cookies["locale"] ?? "en",
		})
		app
			.post("/items")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/items", {
				body: JSON.stringify({}),
				headers: { "content-type": "application/json", cookie: "locale=de" },
				method: "POST",
			}),
			{},
		)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.message).toBe("Ungültig")
	})

	it("resolveLocale receives params", async () => {
		const app = honey<{}>()
		app.errorI18n({
			errors: { fr: { validation_failed: "Invalide" } },
			resolveLocale: ({ params }) => params["lang"] ?? "en",
		})
		app
			.post("/:lang/items")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/fr/items", {
				body: JSON.stringify({}),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.message).toBe("Invalide")
	})

	it("resolveLocale receives search", async () => {
		const app = honey<{}>()
		app.errorI18n({
			errors: { de: { validation_failed: "Ungültig" } },
			resolveLocale: ({ search }) => {
				const lang = search["lang"]
				return (Array.isArray(lang) ? lang[0] : lang) ?? "en"
			},
		})
		app
			.post("/items")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/items?lang=de", {
				body: JSON.stringify({}),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.message).toBe("Ungültig")
	})
})

describe("i18n: nested object validation field paths", () => {
	it("nested object fields → dotted path translated", async () => {
		const app = honey<{}>()
		app.errorI18n({
			fieldNames: {
				en: { "json.address.city": "City", "json.address.zip": "Zip Code" },
			},
			resolveLocale: () => "en",
		})
		app
			.post("/users")
			.input({
				json: z.object({
					address: z.object({
						city: z.string().min(1),
						zip: z.string().length(5),
					}),
				}),
			})
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/users", {
				body: JSON.stringify({ address: { city: "", zip: "1" } }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, unknown>
		const fields = data.fields as Record<string, Array<Record<string, string>>>
		const allPaths = Object.values(fields)
			.flat()
			.map((f) => f.path)
		expect(allPaths).toContain("City")
		expect(allPaths).toContain("Zip Code")
	})
})

describe("i18n: cookie/header validation field paths", () => {
	it("cookie validation field → cookie prefix path translated", async () => {
		const app = honey<{}>()
		app.errorI18n({
			fieldNames: {
				en: { "cookies.session": "Session Token" },
			},
			resolveLocale: () => "en",
		})
		app
			.get("/protected")
			.input({ cookies: z.object({ session: z.string().min(10) }) })
			.handler((ctx) => ctx.res.json("ok", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/protected", {
				headers: { cookie: "session=short" },
			}),
			{},
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, unknown>
		const fields = data.fields as Record<string, Array<Record<string, string>>>
		const allPaths = Object.values(fields)
			.flat()
			.map((f) => f.path)
		expect(allPaths).toContain("Session Token")
	})

	it("header validation field → headers prefix path translated", async () => {
		const app = honey<{}>()
		app.errorI18n({
			fieldNames: {
				en: { "headers.authorization": "Authorization Header" },
			},
			resolveLocale: () => "en",
		})
		app
			.get("/api")
			.input({ headers: z.object({ authorization: z.string().startsWith("Bearer ") }) })
			.handler((ctx) => ctx.res.json("ok", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: { authorization: "bad" },
			}),
			{},
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, unknown>
		const fields = data.fields as Record<string, Array<Record<string, string>>>
		const allPaths = Object.values(fields)
			.flat()
			.map((f) => f.path)
		expect(allPaths).toContain("Authorization Header")
	})
})

describe("i18n: resolveLocale error handling", () => {
	it("resolveLocale throws → error response still works (i18n silently fails)", async () => {
		const app = honey<{}>()
		app.errorI18n({
			errors: { en: { validation_failed: "Should not appear" } },
			resolveLocale: () => {
				throw new Error("locale resolution crashed")
			},
		})
		app
			.post("/items")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/items", {
				body: JSON.stringify({}),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		/* should still return 400, not 500 — i18n failure is swallowed */
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error_key).toBe("validation_failed")
	})
})

describe("i18n: multi-locale same app", () => {
	it("different requests get different locales", async () => {
		const app = honey<{}>()
		app.errorI18n({
			errors: {
				de: { validation_failed: "Fehler" },
				en: { validation_failed: "Error" },
				es: { validation_failed: "Fallo" },
			},
			resolveLocale: ({ req }) => {
				const lang = req.headers.get("accept-language") ?? "en"
				if (lang.startsWith("de")) return "de"
				if (lang.startsWith("es")) return "es"
				return "en"
			},
		})
		app
			.post("/api")
			.input({ json: z.object({ x: z.string() }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const badBody = JSON.stringify({})
		const headers = { "content-type": "application/json" }

		const [resEn, resDe, resEs] = await Promise.all([
			app.fetch(
				new Request("http://localhost/api", {
					body: badBody,
					headers: { ...headers, "accept-language": "en" },
					method: "POST",
				}),
				{},
			),
			app.fetch(
				new Request("http://localhost/api", {
					body: badBody,
					headers: { ...headers, "accept-language": "de" },
					method: "POST",
				}),
				{},
			),
			app.fetch(
				new Request("http://localhost/api", {
					body: badBody,
					headers: { ...headers, "accept-language": "es" },
					method: "POST",
				}),
				{},
			),
		])

		const dataEn = (await resEn.json()) as Record<string, unknown>
		const dataDe = (await resDe.json()) as Record<string, unknown>
		const dataEs = (await resEs.json()) as Record<string, unknown>

		expect(dataEn.message).toBe("Error")
		expect(dataDe.message).toBe("Fehler")
		expect(dataEs.message).toBe("Fallo")
	})
})

describe("i18n: combined message + field translation", () => {
	it("both error message and field names translated in same response", async () => {
		const app = honey<{}>()
		app.errorI18n({
			errors: {
				en: { validation_failed: "Please fix the following errors" },
			},
			fieldNames: {
				en: { "json.email": "Email Address", "json.name": "Full Name" },
			},
			resolveLocale: () => "en",
		})
		app
			.post("/register")
			.input({ json: z.object({ email: z.string().email(), name: z.string().min(1) }) })
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
		/* message translated */
		expect(data.message).toBe("Please fix the following errors")
		/* field names translated */
		const fields = data.fields as Record<string, Array<Record<string, string>>>
		const allPaths = Object.values(fields)
			.flat()
			.map((f) => f.path)
		expect(allPaths).toContain("Email Address")
		expect(allPaths).toContain("Full Name")
	})
})

describe("i18n: boundary error translated", () => {
	it("boundary-wrapped error gets its message translated", async () => {
		const errors = defineErrors({
			boundary: "internal_server_error",
			known: "bad_request",
		})

		const app = honey<{}>().errorFactory(errors).defaultBoundary("boundary")
		app.errorI18n({
			errors: {
				en: { boundary: "An unexpected error occurred. Please try again." },
			},
			resolveLocale: () => "en",
		})
		app
			.get("/crash")
			.errors("known")
			.handler(() => {
				throw new Error("unexpected boom")
			})

		const res = await app.fetch(new Request("http://localhost/crash"), {})
		expect(res.status).toBe(500)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error_key).toBe("boundary")
		expect(data.message).toBe("An unexpected error occurred. Please try again.")
	})
})

describe("i18n: form validation field paths", () => {
	it("multipart form validation → form prefix in field paths", async () => {
		const app = honey<{}>()
		app.errorI18n({
			fieldNames: {
				en: { "form.title": "Document Title" },
			},
			resolveLocale: () => "en",
		})
		app
			.post("/upload")
			.input({ form: z.object({ title: z.string().min(3) }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const fd = new FormData()
		fd.append("title", "ab")

		const res = await app.fetch(new Request("http://localhost/upload", { body: fd, method: "POST" }), {})
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, unknown>
		const fields = data.fields as Record<string, Array<Record<string, string>>>
		const allPaths = Object.values(fields)
			.flat()
			.map((f) => f.path)
		expect(allPaths).toContain("Document Title")
	})

	it("URL-encoded form validation → form prefix in field paths", async () => {
		const app = honey<{}>()
		app.errorI18n({
			fieldNames: {
				en: { "form.username": "Username" },
			},
			resolveLocale: () => "en",
		})
		app
			.post("/login")
			.input({ form: z.object({ username: z.string().min(3) }) })
			.handler((ctx) => ctx.res.json("ok", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/login", {
				body: "username=ab",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, unknown>
		const fields = data.fields as Record<string, Array<Record<string, string>>>
		const allPaths = Object.values(fields)
			.flat()
			.map((f) => f.path)
		expect(allPaths).toContain("Username")
	})
})

describe("i18n: params validation field paths", () => {
	it("param validation error → params prefix in field path", async () => {
		const app = honey<{}>()
		app.errorI18n({
			fieldNames: {
				en: { "params.id": "Resource ID" },
			},
			resolveLocale: () => "en",
		})
		app
			.get("/items/:id")
			.input({ params: z.object({ id: z.string().uuid() }) })
			.handler((ctx) => ctx.res.json("ok", ctx.input))

		const res = await app.fetch(new Request("http://localhost/items/not-a-uuid"), {})
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, unknown>
		const fields = data.fields as Record<string, Array<Record<string, string>>>
		const allPaths = Object.values(fields)
			.flat()
			.map((f) => f.path)
		expect(allPaths).toContain("Resource ID")
	})
})

describe("i18n: error_key field errors preserve structure", () => {
	it("translated response has error_key per field error", async () => {
		const app = honey<{}>()
		app.errorI18n({
			errors: { en: { validation_failed: "Validation error" } },
			fieldNames: { en: { "json.email": "Email" } },
			resolveLocale: () => "en",
		})
		app
			.post("/api")
			.input({ json: z.object({ email: z.string().email() }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				body: JSON.stringify({ email: "not-email" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error_key).toBe("validation_failed")
		expect(data.message).toBe("Validation error")

		const fields = data.fields as Record<string, Array<Record<string, string>>>
		const emailErrors = fields.email
		expect(emailErrors).toBeDefined()
		expect(emailErrors.length).toBeGreaterThan(0)
		/* each field error keeps its error_key */
		expect(emailErrors[0].error_key).toBeDefined()
		expect(typeof emailErrors[0].error_key).toBe("string")
		/* path is translated */
		expect(emailErrors[0].path).toBe("Email")
	})
})
