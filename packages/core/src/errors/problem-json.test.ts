import { describe, expect, it } from "vitest"
import { requestId } from "../middleware/request-id.ts"
import { honey } from "../routing/app.ts"
import { HoneyError } from "./error.ts"
import { problemDetails } from "./problem-json.ts"

const FIELDS = { email: [{ error_key: "field_invalid_email", message: "bad", path: "json.email" }] }

/** An app answering /t by throwing what `thrown` builds, in problem+json unless `native`. */
function throwing(thrown: () => unknown, native = false) {
	const app = honey<{}>().logger(false)
	if (!native) app.errorFormat("problem+json")
	app.get("/t").handler(() => {
		throw thrown()
	})
	return app
}

/** The status, content type and parsed body of an answer. */
async function seen(answer: Response | Promise<Response>): Promise<[number, string | null, Record<string, unknown>]> {
	const res = await answer
	return [res.status, res.headers.get("content-type"), (await res.json()) as Record<string, unknown>]
}

const get = (path: string) => new Request(`http://localhost${path}`)

describe("problemDetails: the RFC 9457 document for an error", () => {
	it("maps the key to type, the status to its reason phrase, the message to detail, fields to errors", () => {
		const error = new HoneyError({ errorKey: "val_error", fields: FIELDS, status: "unprocessable_entity" })
		expect(problemDetails(error, "req-1")).toEqual({
			detail: "val_error",
			errors: FIELDS,
			instance: "req-1",
			status: 422,
			title: "Unprocessable Content",
			type: "https://honey.dev/errors/val_error",
		})
	})

	it("titles every error status by its reason phrase, not its key", () => {
		const titles = (["bad_request", "uri_too_long", "content_too_large", "http_version_not_supported"] as const).map(
			(status) => problemDetails(new HoneyError({ errorKey: "x", status }), null).title,
		)
		expect(titles).toEqual(["Bad Request", "URI Too Long", "Content Too Large", "HTTP Version Not Supported"])
	})

	it("titles a status outside the table by its key", () => {
		expect(problemDetails(new HoneyError({ errorKey: "x", status: "ok" }), null).title).toBe("ok")
	})

	it("leaves out errors when there are no fields, instance when there is no request id, and never carries vars", () => {
		const error = new HoneyError({ errorKey: "rate_limited", status: "too_many_requests", vars: { limit: 100 } })
		expect(problemDetails(error, null)).toEqual({
			detail: "rate_limited",
			status: 429,
			title: "Too Many Requests",
			type: "https://honey.dev/errors/rate_limited",
		})
	})
})

describe("errorFormat: off by default", () => {
	it("the native envelope answers as before, as application/json", async () => {
		const app = throwing(
			() => new HoneyError({ errorKey: "val_error", fields: FIELDS, status: "unprocessable_entity" }),
			true,
		)
		expect(await seen(app.fetch(get("/t"), {}))).toEqual([
			422,
			"application/json",
			{
				error_key: "val_error",
				fields: FIELDS,
				message: "val_error",
				status: 422,
				status_key: "unprocessable_entity",
				success: false,
			},
		])
	})
})

describe('errorFormat("problem+json")', () => {
	it("answers a standard error as application/problem+json, its fields nested where they cannot override a member", async () => {
		const smuggled = {
			status: [{ error_key: "x", message: "m", path: "json.status" }],
			type: [{ error_key: "x", message: "m", path: "json.type" }],
		}
		const app = throwing(
			() =>
				new HoneyError({ cause: new Error("secret"), errorKey: "val_error", fields: smuggled, status: "bad_request" }),
		)
		const [status, type, body] = await seen(app.fetch(get("/t"), {}))
		expect([status, type, body, "cause" in body]).toEqual([
			400,
			"application/problem+json",
			{
				detail: "val_error",
				errors: smuggled,
				status: 400,
				title: "Bad Request",
				type: "https://honey.dev/errors/val_error",
			},
			false,
		])
	})

	it("an unknown throw is a 500 problem that keeps its digest, the cause never in it", async () => {
		const [status, type, body] = await seen(throwing(() => new Error("secret detail")).fetch(get("/t"), {}))
		expect([
			status,
			type,
			body.title,
			body.detail,
			typeof body.digest,
			JSON.stringify(body).includes("secret"),
		]).toEqual([500, "application/problem+json", "Internal Server Error", "internal_server_error", "string", false])
	})
})

describe('errorFormat("problem+json"): instance and formatters', () => {
	it("instance is the request id requestId() set; a framework 404 has none, and an inbound id is never used", async () => {
		const app = honey<{}>().logger(false).errorFormat("problem+json").use(requestId())
		app.get("/t").handler(() => {
			throw new HoneyError({ errorKey: "gone_for_good", status: "gone" })
		})
		const thrown = await app.fetch(get("/t"), {})
		const missing = await seen(
			app.fetch(new Request("http://localhost/missing", { headers: { "x-request-id": "forged" } }), {}),
		)
		const body = (await thrown.json()) as Record<string, unknown>
		expect([
			body.instance === thrown.headers.get("x-request-id"),
			typeof body.instance,
			missing[0],
			"instance" in missing[2],
		]).toEqual([true, "string", 404, false])
	})

	it("the default formatter shapes the problem document; a schema error keeps its declared body and type", async () => {
		const app = honey<{}>().logger(false).errorFormat("problem+json")
		app.defaultErrorFormatter((error, shape) => ({ ...shape, code: error.errorKey }))
		app.get("/standard").handler(() => {
			throw new HoneyError({ errorKey: "conflicted", status: "conflict" })
		})
		app.get("/schema").handler(() => {
			throw new HoneyError({ data: { plan: "free" }, errorKey: "quota", status: "payment_required" })
		})
		expect([await seen(app.fetch(get("/standard"), {})), await seen(app.fetch(get("/schema"), {}))]).toEqual([
			[
				409,
				"application/problem+json",
				{
					code: "conflicted",
					detail: "conflicted",
					status: 409,
					title: "Conflict",
					type: "https://honey.dev/errors/conflicted",
				},
			],
			[402, "application/json", { plan: "free" }],
		])
	})
})
