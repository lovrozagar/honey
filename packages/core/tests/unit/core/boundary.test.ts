import { describe, expect, it } from "vitest"
import { HoneyError } from "../../../src/error.ts"
import { defineErrors } from "../../../src/errors.ts"
import { honey } from "../../../src/index.ts"

const errors = defineErrors({
	auth_error: "internal_server_error",
	internal_server_error: "internal_server_error",
	not_found: "not_found",
	profile_error: "internal_server_error",
	schema_error: "internal_server_error",
})

describe(".boundary() per-route", () => {
	it("wraps undeclared HoneyError in boundary key", async () => {
		const h = honey<{}>().errorFactory(errors)
		h.get("/me")
			.errors("not_found")
			.boundary("profile_error")
			.handler(() => {
				throw new HoneyError({ errorKey: "something_unknown", status: "conflict" })
			})

		const res = await h.fetch(new Request("http://localhost/me"), {})
		expect(res.status).toBe(500)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("profile_error")
	})

	it("does not affect declared errors", async () => {
		const h = honey<{}>().errorFactory(errors)
		h.get("/me")
			.errors("not_found")
			.boundary("profile_error")
			.handler(() => {
				throw errors.not_found()
			})

		const res = await h.fetch(new Request("http://localhost/me"), {})
		expect(res.status).toBe(404)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("not_found")
	})

	it("wraps non-HoneyError throw in boundary key", async () => {
		const h = honey<{}>().errorFactory(errors)
		h.get("/me")
			.boundary("profile_error")
			.handler(() => {
				throw new Error("db connection failed")
			})

		const res = await h.fetch(new Request("http://localhost/me"), {})
		expect(res.status).toBe(500)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("profile_error")
	})

	it("wraps string throw in boundary key", async () => {
		const h = honey<{}>().errorFactory(errors)
		h.get("/me")
			.boundary("profile_error")
			.handler(() => {
				throw "oops"
			})

		const res = await h.fetch(new Request("http://localhost/me"), {})
		expect(res.status).toBe(500)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("profile_error")
	})

	it("boundary key auto-added to route errorKeys (available on ctx.errors)", async () => {
		const h = honey<{}>().errorFactory(errors)
		h.get("/me")
			.boundary("profile_error")
			.handler((ctx) => {
				/* boundary key should be accessible on ctx.errors */
				const e = ctx.errors.profile_error()
				return ctx.res.json("ok", { key: e.errorKey })
			})

		const res = await h.fetch(new Request("http://localhost/me"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.key).toBe("profile_error")
	})

	it("preserves cause from original error", async () => {
		const h = honey<{}>().errorFactory(errors)
		let capturedError: unknown = null
		h.onError((error) => {
			capturedError = error
			return undefined
		})
		h.get("/me")
			.boundary("profile_error")
			.handler(() => {
				throw new Error("original boom")
			})

		await h.fetch(new Request("http://localhost/me"), {})
		expect(capturedError).toBeInstanceOf(Error)
		expect((capturedError as Error).message).toBe("original boom")
	})
})

describe(".defaultBoundary() app-level", () => {
	it("applies to all routes when no per-route boundary", async () => {
		const h = honey<{}>().errorFactory(errors).defaultBoundary("internal_server_error")
		h.get("/a")
			.errors("not_found")
			.handler(() => {
				throw new Error("boom")
			})
		h.get("/b")
			.errors("not_found")
			.handler(() => {
				throw new HoneyError({ errorKey: "undeclared", status: "conflict" })
			})

		const resA = await h.fetch(new Request("http://localhost/a"), {})
		expect(resA.status).toBe(500)
		const bodyA = (await resA.json()) as Record<string, unknown>
		expect(bodyA.error_key).toBe("internal_server_error")

		const resB = await h.fetch(new Request("http://localhost/b"), {})
		expect(resB.status).toBe(500)
		const bodyB = (await resB.json()) as Record<string, unknown>
		expect(bodyB.error_key).toBe("internal_server_error")
	})

	it("per-route .boundary() overrides .defaultBoundary()", async () => {
		const h = honey<{}>().errorFactory(errors).defaultBoundary("internal_server_error")
		h.get("/me")
			.errors(errors, "not_found")
			.boundary("profile_error")
			.handler(() => {
				throw new Error("boom")
			})

		const res = await h.fetch(new Request("http://localhost/me"), {})
		expect(res.status).toBe(500)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("profile_error")
	})

	it("routes without .boundary() use defaultBoundary", async () => {
		const h = honey<{}>().errorFactory(errors).defaultBoundary("auth_error")
		h.get("/login")
			.errors("not_found")
			.handler(() => {
				throw new Error("something unexpected")
			})

		const res = await h.fetch(new Request("http://localhost/login"), {})
		expect(res.status).toBe(500)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("auth_error")
	})
})

describe("boundary + translations", () => {
	it("boundary error message resolved via i18n", async () => {
		const h = honey<{}>().errorFactory(errors)
		h.errorI18n({
			errors: {
				en: { profile_error: "Failed to process profile request" },
			},
			resolveLocale: () => "en",
		})
		h.get("/me")
			.boundary("profile_error")
			.handler(() => {
				throw new Error("db timeout")
			})

		const res = await h.fetch(new Request("http://localhost/me"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("profile_error")
		expect(body.message).toBe("Failed to process profile request")
	})
})

describe("no boundary set", () => {
	it("existing behavior unchanged: undeclared → internal_server_error", async () => {
		const h = honey<{}>().errorFactory(errors)
		h.get("/fail")
			.errors("not_found")
			.handler(() => {
				throw new HoneyError({ errorKey: "undeclared", status: "conflict" })
			})

		const res = await h.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(500)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("internal_server_error")
	})

	it("existing behavior unchanged: non-HoneyError → internal_server_error", async () => {
		const h = honey<{}>()
		h.get("/fail").handler(() => {
			throw new Error("raw")
		})

		const res = await h.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(500)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("internal_server_error")
	})
})
