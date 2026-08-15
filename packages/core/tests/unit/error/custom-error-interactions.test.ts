import { describe, expect, it } from "vitest"
import * as z from "zod"
import { honey, defineErrors } from "../../../src/index.ts"
import { HoneyError } from "../../../src/error.ts"
import { createClient } from "../../../src/client/index.ts"
import "@lovrozagar/honey/i18n"

const fetchAdapter = (app: { fetch: (req: Request) => Promise<Response> }) =>
	(input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(input, init))

/* ── onError returning HoneyError — i18n re-run + default response path ── */

describe("onError returning HoneyError re-runs i18n + falls through to default path", () => {
	it("i18n applied to returned HoneyError errorKey", async () => {
		const app = honey()
			.errorI18n({
				errors: { en: { internal_server_error: "Server boom" } },
				resolveLocale: () => "en",
			})
			.onError(() => new HoneyError({ errorKey: "internal_server_error", status: "internal_server_error" }))

		app.get("/fail").handler(() => { throw new Error("raw") })

		const res = await app.fetch(new Request("http://localhost/fail"))
		expect(res.status).toBe(500)
		const body = await res.json() as Record<string, unknown>
		expect(body["error_key"]).toBe("internal_server_error")
		expect(body["message"]).toBe("Server boom")
	})

	it("i18n NOT configured → returned HoneyError message stays as errorKey", async () => {
		const app = honey()
			.onError(() => new HoneyError({ errorKey: "internal_server_error", status: "internal_server_error" }))

		app.get("/fail").handler(() => { throw new Error("raw") })

		const res = await app.fetch(new Request("http://localhost/fail"))
		expect(res.status).toBe(500)
		const body = await res.json() as Record<string, unknown>
		expect(body["error_key"]).toBe("internal_server_error")
		expect(body["message"]).toBe("internal_server_error")
	})

	it("async onError returning Promise<HoneyError> resolves and processes correctly", async () => {
		const app = honey()
			.errorI18n({
				errors: { en: { internal_server_error: "Async boom" } },
				resolveLocale: () => "en",
			})
			.onError(async () => new HoneyError({ errorKey: "internal_server_error", status: "internal_server_error" }))

		app.get("/fail").handler(() => { throw new Error("raw") })

		const res = await app.fetch(new Request("http://localhost/fail"))
		expect(res.status).toBe(500)
		const body = await res.json() as Record<string, unknown>
		expect(body["message"]).toBe("Async boom")
	})

	it("returned HoneyError with data field → body uses data, message absent (custom schema semantics)", async () => {
		const errors = defineErrors({
			item_gone: { schema: z.object({ reason: z.string() }), status: "gone" },
		})

		const app = honey()
			.errorFactory(errors)
			.errorI18n({
				errors: { en: { item_gone: "Item is gone: {reason}" } },
				resolveLocale: () => "en",
			})
			.onError(() => errors.item_gone({ reason: "x" }))

		app.get("/fail").handler(() => { throw new Error("raw") })

		const res = await app.fetch(new Request("http://localhost/fail"))
		expect(res.status).toBe(410)
		const body = await res.json() as Record<string, unknown>
		expect(body["reason"]).toBe("x")
		expect(body["message"]).toBeUndefined()
	})

	it("returned Response still works (regression)", async () => {
		const app = honey()
			.onError((_err, ctx) =>
				ctx.jsonFromError(new HoneyError({ errorKey: "custom_error", status: "bad_request" })),
			)

		app.get("/fail").handler(() => { throw new Error("oops") })

		const res = await app.fetch(new Request("http://localhost/fail"))
		expect(res.status).toBe(400)
		const body = await res.json() as Record<string, unknown>
		expect(body["error_key"]).toBe("custom_error")
	})

	it("returned undefined falls through to default boundary path (regression)", async () => {
		const app = honey()
			.onError(() => undefined)

		app.get("/fail").handler(() => { throw new Error("oops") })

		const res = await app.fetch(new Request("http://localhost/fail"))
		expect(res.status).toBe(500)
		const body = await res.json() as Record<string, unknown>
		expect(body["error_key"]).toBe("internal_server_error")
	})

	it("returned HoneyError replaces the boundary error — response carries new errorKey", async () => {
		const app = honey()
			.errorI18n({
				errors: { en: { custom_replacement: "Replaced!" } },
				resolveLocale: () => "en",
			})
			.onError(() => new HoneyError({ errorKey: "custom_replacement", status: "bad_request" }))

		app.get("/fail").handler(() => { throw new Error("original") })

		const res = await app.fetch(new Request("http://localhost/fail"))
		expect(res.status).toBe(400)
		const body = await res.json() as Record<string, unknown>
		expect(body["error_key"]).toBe("custom_replacement")
		expect(body["message"]).toBe("Replaced!")
	})
})

/* ── i18n + custom schema errors ── */

describe("i18n does NOT corrupt custom schema error data", () => {
	const errors = defineErrors({
		api_error: "internal_server_error",
		item_not_found: {
			schema: z.object({ reason: z.string(), code: z.number() }),
			status: "not_found",
		},
		std_error: "bad_request",
	})

	const app = honey()
		.errorFactory(errors)
		.defaultBoundary("api_error")
		.errorI18n({
			errors: {
				en: {
					api_error: "Internal server error",
					item_not_found: "Item not found: {reason}",
					std_error: "Bad request",
				},
			},
			fieldNames: { en: {} },
			resolveLocale: () => "en",
		})

		.get("/custom-err")
		.errors("item_not_found")
		.handler(() => {
			throw errors.item_not_found({ reason: "deleted", code: 42 })
		})

		.get("/std-err")
		.errors("std_error")
		.handler(() => {
			throw errors.std_error({ vars: { field: "email" } })
		})

	it("custom error: response body is data, not translated shape", async () => {
		const res = await app.fetch(new Request("http://localhost/custom-err"))
		expect(res.status).toBe(404)
		const body = await res.json()

		/* data should be untouched — i18n should NOT inject into custom error body */
		expect(body.reason).toBe("deleted")
		expect(body.code).toBe(42)
		expect(body.message).toBeUndefined()
		expect(body.error_key).toBeUndefined()
	})

	it("standard error: i18n translates message normally", async () => {
		const res = await app.fetch(new Request("http://localhost/std-err"))
		expect(res.status).toBe(400)
		const body = await res.json()

		expect(body.error_key).toBe("std_error")
		expect(body.message).toBe("Bad request")
	})

	it("client receives custom error data intact through i18n layer", async () => {
		const client = createClient<typeof app>({
			baseURL: "http://localhost",
			fetch: fetchAdapter(app),
		})

		const r = await client.get("/custom-err")
		expect(r.error).not.toBeNull()
		expect(r.error.reason).toBe("deleted")
		expect(r.error.code).toBe(42)
	})
})

/* ── onError callback + custom schema errors ── */

describe("onError callback receives custom schema errors", () => {
	it("onError sees HoneyError with data intact", async () => {
		const errors = defineErrors({
			api_error: "internal_server_error",
			item_gone: {
				schema: z.object({ reason: z.string() }),
				status: "gone",
			},
		})

		let capturedError: unknown = null

		const app = honey()
			.errorFactory(errors)
			.defaultBoundary("api_error")
			.onError((thrown) => {
				capturedError = thrown
				return undefined
			})
			.get("/gone")
			.errors("item_gone")
			.handler(() => {
				throw errors.item_gone({ reason: "permanently removed" })
			})

		await app.fetch(new Request("http://localhost/gone"))

		expect(capturedError).toBeInstanceOf(HoneyError)
		const he = capturedError as HoneyError
		expect(he.errorKey).toBe("item_gone")
		expect(he.data).toEqual({ reason: "permanently removed" })
		expect(he.status).toBe(410)
	})

	it("onError sees boundary-wrapped error for undeclared custom errors", async () => {
		const errors = defineErrors({
			api_error: "internal_server_error",
			item_gone: {
				schema: z.object({ reason: z.string() }),
				status: "gone",
			},
		})

		let capturedError: unknown = null

		const app = honey()
			.errorFactory(errors)
			.defaultBoundary("api_error")
			.onError((thrown) => {
				capturedError = thrown
				return undefined
			})
			.get("/undeclared")
			.handler(() => {
				throw errors.item_gone({ reason: "should be wrapped" })
			})

		await app.fetch(new Request("http://localhost/undeclared"))

		/* onError receives the ORIGINAL thrown error, not the boundary-wrapped one */
		expect(capturedError).toBeInstanceOf(HoneyError)
		const he = capturedError as HoneyError
		expect(he.errorKey).toBe("item_gone")
		expect(he.data).toEqual({ reason: "should be wrapped" })
	})
})

/* ── SDK runtime with safe mode raw body ── */

describe("SDK runtime: safe mode returns raw body as error", () => {
	const errors = defineErrors({
		api_error: "internal_server_error",
		item_not_found: {
			schema: z.object({ reason: z.string() }),
			status: "not_found",
		},
		email_taken: "conflict",
	})

	const app = honey()
		.errorFactory(errors)
		.defaultBoundary("api_error")

		.get("/items/:id")
		.meta({ operationId: "items.get" })
		.output({ "application/json": { ok: z.object({ name: z.string() }) } })
		.errors("item_not_found")
		.handler((c) => {
			if (c.params.id === "404") {
				throw errors.item_not_found({ reason: "not found" })
			}
			return c.res.json("ok", { name: "widget" })
		})

		.post("/register")
		.meta({ operationId: "auth.register" })
		.output({ "application/json": { created: z.object({ id: z.string() }) } })
		.errors("email_taken")
		.handler((c) => {
			throw errors.email_taken()
		})

	/* simulate SDK by using createClient as proxy (SDK uses same HTTPClient) */
	const client = createClient<typeof app>({
		baseURL: "http://localhost",
		fetch: fetchAdapter(app),
	})

	it("custom error: r.error has schema payload directly", async () => {
		const r = await client.get("/items/:id", { params: { id: "404" } })
		expect(r.error).not.toBeNull()
		expect(r.status).toBe(404)
		expect(r.error.reason).toBe("not found")
	})

	it("standard error: r.error has default shape directly", async () => {
		const r = await client.post("/register")
		expect(r.error).not.toBeNull()
		expect(r.status).toBe(409)
		expect(r.error.error_key).toBe("email_taken")
	})

	it("success: r.data typed, r.error null", async () => {
		const r = await client.get("/items/:id", { params: { id: "1" } })
		expect(r.error).toBeNull()
		expect(r.data).toEqual({ name: "widget" })
	})
})
