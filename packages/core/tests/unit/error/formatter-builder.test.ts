import { describe, expect, it } from "vitest"
import * as z from "zod"
import { honey } from "../../../src/index.ts"
import { defineErrors } from "../../../src/errors.ts"
import { createClient } from "../../../src/client/index.ts"
import { ClientError } from "../../../src/client/error.ts"

const appErrors = defineErrors({
	api_error: "internal_server_error",
	email_taken: "conflict",
	item_not_found: {
		schema: z.object({ reason: z.string() }),
		status: "not_found",
	},
})

const fetchAdapter = (app: { fetch: (req: Request) => Promise<Response> }) =>
	(input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(input, init))

/* ── defaultErrorFormatter builder method ── */

describe("defaultErrorFormatter builder method", () => {
	it("replaces the default identity formatter", async () => {
		const app = honey()
			.errorFactory(appErrors)
			.defaultBoundary("api_error")
			.defaultErrorFormatter((_err, shape) => ({
				...shape,
				timestamp: 999,
			}))
			.get("/fail")
			.errors("email_taken")
			.handler(() => { throw appErrors.email_taken() })

		const res = await app.fetch(new Request("http://localhost/fail"))
		const body = await res.json()
		expect(body.error_key).toBe("email_taken")
		expect(body.timestamp).toBe(999)
		expect(body.success).toBe(false)
	})

	it("schema overload works for codegen", async () => {
		const schema = z.object({
			error_key: z.string(),
			message: z.string(),
			ts: z.number(),
		})
		const app = honey()
			.errorFactory(appErrors)
			.defaultBoundary("api_error")
			.defaultErrorFormatter(schema, (err) => ({
				error_key: err.errorKey,
				message: err.message,
				ts: Date.now(),
			}))
			.get("/fail")
			.errors("email_taken")
			.handler(() => { throw appErrors.email_taken() })

		const res = await app.fetch(new Request("http://localhost/fail"))
		const body = await res.json()
		expect(body.error_key).toBe("email_taken")
		expect(typeof body.ts).toBe("number")
	})

	it("does NOT affect custom schema errors", async () => {
		const app = honey()
			.errorFactory(appErrors)
			.defaultBoundary("api_error")
			.defaultErrorFormatter((_err, shape) => ({
				...shape,
				wrapped: true,
			}))
			.get("/custom")
			.errors("item_not_found")
			.handler(() => { throw appErrors.item_not_found({ reason: "gone" }) })

		const res = await app.fetch(new Request("http://localhost/custom"))
		const body = await res.json()
		expect(body.reason).toBe("gone")
		expect(body.wrapped).toBeUndefined()
	})

	it("defaultErrorFormatter reshapes error response body", async () => {
		const app = honey()
			.errorFactory(appErrors)
			.defaultBoundary("api_error")
			.defaultErrorFormatter((_err, shape) => ({ ...shape, compat: true }))
			.get("/fail")
			.errors("email_taken")
			.handler(() => { throw appErrors.email_taken() })

		const res = await app.fetch(new Request("http://localhost/fail"))
		const body = await res.json()
		expect(body.compat).toBe(true)
	})
})

/* ── customErrorFormatter builder method ── */

describe("customErrorFormatter builder method", () => {
	it("post-processes custom schema error payloads", async () => {
		const app = honey()
			.errorFactory(appErrors)
			.defaultBoundary("api_error")
			.customErrorFormatter((_err, data) => ({
				...data,
				request_id: "req-123",
			}))
			.get("/custom")
			.errors("item_not_found")
			.handler(() => { throw appErrors.item_not_found({ reason: "deleted" }) })

		const res = await app.fetch(new Request("http://localhost/custom"))
		const body = await res.json()
		expect(body.reason).toBe("deleted")
		expect(body.request_id).toBe("req-123")
	})

	it("does NOT affect standard errors", async () => {
		const app = honey()
			.errorFactory(appErrors)
			.defaultBoundary("api_error")
			.customErrorFormatter((_err, data) => ({
				...data,
				injected: true,
			}))
			.get("/std")
			.errors("email_taken")
			.handler(() => { throw appErrors.email_taken() })

		const res = await app.fetch(new Request("http://localhost/std"))
		const body = await res.json()
		expect(body.error_key).toBe("email_taken")
		expect(body.injected).toBeUndefined()
	})

	it("schema overload works", async () => {
		const addedSchema = z.object({ trace_id: z.string() })
		const app = honey()
			.errorFactory(appErrors)
			.defaultBoundary("api_error")
			.customErrorFormatter(addedSchema, (_err, data) => ({
				...data,
				trace_id: "trace-abc",
			}))
			.get("/custom")
			.errors("item_not_found")
			.handler(() => { throw appErrors.item_not_found({ reason: "x" }) })

		const res = await app.fetch(new Request("http://localhost/custom"))
		const body = await res.json()
		expect(body.trace_id).toBe("trace-abc")
		expect(body.reason).toBe("x")
	})

	it("crash falls back to raw data", async () => {
		const app = honey()
			.errorFactory(appErrors)
			.defaultBoundary("api_error")
			.customErrorFormatter(() => { throw new Error("boom") })
			.get("/custom")
			.errors("item_not_found")
			.handler(() => { throw appErrors.item_not_found({ reason: "safe" }) })

		const res = await app.fetch(new Request("http://localhost/custom"))
		const body = await res.json()
		expect(body.reason).toBe("safe")
	})
})

/* ── both formatters together ── */

describe("both formatters configured simultaneously", () => {
	const app = honey()
		.errorFactory(appErrors)
		.defaultBoundary("api_error")
		.defaultErrorFormatter((_err, shape) => ({ ...shape, source: "default" }))
		.customErrorFormatter((_err, data) => ({ ...data, source: "custom" }))

		.get("/std")
		.errors("email_taken")
		.handler(() => { throw appErrors.email_taken() })

		.get("/custom")
		.errors("item_not_found")
		.handler(() => { throw appErrors.item_not_found({ reason: "gone" }) })

	it("standard error gets default formatter", async () => {
		const res = await app.fetch(new Request("http://localhost/std"))
		const body = await res.json()
		expect(body.source).toBe("default")
		expect(body.error_key).toBe("email_taken")
	})

	it("custom error gets custom formatter", async () => {
		const res = await app.fetch(new Request("http://localhost/custom"))
		const body = await res.json()
		expect(body.source).toBe("custom")
		expect(body.reason).toBe("gone")
	})
})

/* ── formatter propagation ── */

describe("formatter propagation through basePath and use", () => {
	const baseApp = honey()
		.errorFactory(appErrors)
		.defaultBoundary("api_error")
		.defaultErrorFormatter((_err, shape) => ({ ...shape, fmt: "default" }))
		.customErrorFormatter((_err, data) => ({ ...data, fmt: "custom" }))

	it("basePath preserves both formatters", async () => {
		const sub = baseApp
			.basePath("/api")
			.get("/fail")
			.errors("email_taken")
			.handler(() => { throw appErrors.email_taken() })

		const res = await sub.fetch(new Request("http://localhost/api/fail"))
		const body = await res.json()
		expect(body.fmt).toBe("default")
	})

	it("basePath preserves custom formatter for custom errors", async () => {
		const app = honey()
			.errorFactory(appErrors)
			.defaultBoundary("api_error")
			.defaultErrorFormatter((_err, shape) => ({ ...shape, fmt: "default" }))
			.customErrorFormatter((_err, data) => ({ ...data, fmt: "custom" }))
			.basePath("/api")
			.get("/custom-fail")
			.errors("item_not_found")
			.handler(() => { throw appErrors.item_not_found({ reason: "x" }) })

		const res = await app.fetch(new Request("http://localhost/api/custom-fail"))
		expect(res.status).toBe(404)
		const body = await res.json()
		expect(body.reason).toBe("x")
		expect(body.fmt).toBe("custom")
	})
})

/* ── boundary wrapping ── */

describe("boundary wrapping of custom schema errors", () => {
	it("undeclared custom error gets wrapped by boundary, data lost", async () => {
		const app = honey()
			.errorFactory(appErrors)
			.defaultBoundary("api_error")
			.get("/undeclared")
			.handler(() => {
				throw appErrors.item_not_found({ reason: "should be wrapped" })
			})

		const res = await app.fetch(new Request("http://localhost/undeclared"))
		expect(res.status).toBe(500)
		const body = await res.json()
		expect(body.error_key).toBe("api_error")
		expect(body.reason).toBeUndefined()
	})

	it("declared custom error passes through with data intact", async () => {
		const app = honey()
			.errorFactory(appErrors)
			.defaultBoundary("api_error")
			.get("/declared")
			.errors("item_not_found")
			.handler(() => {
				throw appErrors.item_not_found({ reason: "intact" })
			})

		const res = await app.fetch(new Request("http://localhost/declared"))
		expect(res.status).toBe(404)
		const body = await res.json()
		expect(body.reason).toBe("intact")
	})
})

/* ── client e2e with formatters ── */

describe("client e2e: both formatters flow through to client", () => {
	const app = honey()
		.errorFactory(appErrors)
		.defaultBoundary("api_error")
		.defaultErrorFormatter((_err, shape) => ({ ...shape, ts: 1000 }))
		.customErrorFormatter((_err, data) => ({ ...data, ts: 2000 }))

		.get("/std-err")
		.errors("email_taken")
		.handler(() => { throw appErrors.email_taken() })

		.get("/custom-err")
		.errors("item_not_found")
		.handler(() => { throw appErrors.item_not_found({ reason: "nope" }) })

		.get("/ok")
		.output({ "application/json": { ok: z.object({ id: z.string() }) } })
		.handler((c) => c.res.json("ok", { id: "1" }))

	const client = createClient<typeof app>({
		baseURL: "http://localhost",
		fetch: fetchAdapter(app),
	})

	it("standard error: client gets formatter-enhanced body", async () => {
		const r = await client.get("/std-err")
		expect(r.error).not.toBeNull()
		expect(r.error.ts).toBe(1000)
		expect(r.error.error_key).toBe("email_taken")
	})

	it("custom error: client gets custom-formatter-enhanced body", async () => {
		const r = await client.get("/custom-err")
		expect(r.error).not.toBeNull()
		expect(r.error.ts).toBe(2000)
		expect(r.error.reason).toBe("nope")
	})

	it("success: unaffected by formatters", async () => {
		const r = await client.get("/ok")
		expect(r.error).toBeNull()
		expect(r.data).toEqual({ id: "1" })
	})

	it("throw mode: custom error has body with formatter additions", async () => {
		const throwClient = createClient<typeof app>({
			baseURL: "http://localhost",
			fetch: fetchAdapter(app),
			throwOnError: true,
		})

		try {
			await throwClient.get("/custom-err")
			expect.fail("should throw")
		} catch (e) {
			expect(e).toBeInstanceOf(ClientError)
			const ce = e as ClientError
			expect(ce.body.ts).toBe(2000)
			expect(ce.body.reason).toBe("nope")
		}
	})
})
