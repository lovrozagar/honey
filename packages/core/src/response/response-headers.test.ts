import { describe, expect, it, vi } from "vitest"
import * as z from "zod"
import type { HoneyError } from "../errors/error.ts"
import { honey } from "../routing/app.ts"
import { compileResponseHeaders } from "./response-headers.ts"
import { HoneyRes } from "./response.ts"

const get = (path: string, method = "GET") => new Request(`http://localhost${path}`, { method })

/** The error `run` throws or rejects with. */
async function failure(run: () => unknown): Promise<HoneyError> {
	try {
		await run()
	} catch (error) {
		return error as HoneyError
	}
	throw new Error("did not fail")
}

describe("compileResponseHeaders: the check a declaration compiles to", () => {
	it("is nothing at all without a declaration", () => {
		expect([compileResponseHeaders(undefined), compileResponseHeaders({})]).toEqual([null, null])
	})

	it("reads the answer's headers by lowercased name, on the native and the Node path", async () => {
		const seen = vi.fn((value: unknown) => ({ value }))
		const check = compileResponseHeaders({ created: { "~standard": { validate: seen, vendor: "test", version: 1 } } })
		for (const res of [new HoneyRes(), new HoneyRes(true)]) {
			check?.(res.json("created", {}, { headers: { ETag: '"v1"', Location: "/users/1" } }))
		}
		expect(seen.mock.calls).toEqual([
			[{ "content-type": "application/json", etag: '"v1"', location: "/users/1" }],
			[{ "content-type": "application/json", etag: '"v1"', location: "/users/1" }],
		])
	})

	it("passes a status no status key names, and one declaring no headers, unread", () => {
		const validate = vi.fn(() => ({ issues: [{ message: "never" }] }))
		const check = compileResponseHeaders({ created: { "~standard": { validate, vendor: "test", version: 1 } } })
		const results = [new Response(null, { status: 299 }), new Response("{}")].map((response) => check?.(response))
		expect([results, validate.mock.calls.length]).toEqual([[undefined, undefined], 0])
	})

	it("answers synchronously for a sync validator, a promise for an async one, and fails naming the status key", async () => {
		const sync = compileResponseHeaders({ ok: z.object({ etag: z.string() }) })
		const later = compileResponseHeaders({ ok: z.object({ etag: z.string().refine(async () => true) }) })
		const res = new HoneyRes()
		const error = await failure(() => sync?.(res.json("ok", {})))
		expect([
			sync?.(res.json("ok", {}, { headers: { etag: '"a"' } })),
			later?.(res.json("ok", {}, { headers: { etag: '"a"' } })) instanceof Promise,
			[error.status, error.errorKey, error.vars],
		]).toEqual([undefined, true, [500, "output_validation_failed", { statusKey: "ok" }]])
	})
})

/** An app checking its answers, with routes declaring the headers each status carries. */
function declaring() {
	const app = honey<{}>().logger(false).outputValidation("always")
	const out = {
		"application/json": { created: z.object({ id: z.string() }), ok: z.object({ id: z.string() }) },
		headers: {
			created: z.object({ location: z.string().startsWith("/").describe("SECRET_SCHEMA") }),
			found: z.object({ location: z.string() }),
			no_content: z.object({ etag: z.string() }),
		},
		redirect: { found: true },
	} as const
	app
		.post("/good")
		.output(out)
		.handler((ctx) => ctx.res.json("created", { id: "1" }, { headers: { location: "/users/1" } }))
	app
		.post("/bad")
		.output(out)
		.handler((ctx) => ctx.res.json("created", { id: "1" }, { headers: { location: "users/1" } }))
	app
		.get("/plain")
		.output(out)
		.handler((ctx) => ctx.res.json("ok", { id: "1" }))
	app
		.get("/moved")
		.output(out)
		.handler((ctx) => ctx.res.redirect("/elsewhere"))
	app
		.delete("/tagged")
		.output(out)
		.handler((ctx) => ctx.res.noContent({ headers: { etag: '"v2"' } }))
	app
		.delete("/untagged")
		.output(out)
		.handler((ctx) => ctx.res.noContent())
	return app
}

describe("declared response headers through the app", () => {
	it("an answer carrying its status's declared headers passes; one breaking them is a 500 that names no issue", async () => {
		const app = declaring()
		const bad = await app.fetch(get("/bad", "POST"), {})
		const text = await bad.text()
		expect([
			(await app.fetch(get("/good", "POST"), {})).status,
			bad.status,
			(JSON.parse(text) as { error_key: string }).error_key,
			text.includes("SECRET") || text.includes("startsWith") || text.includes("location"),
		]).toEqual([201, 500, "output_validation_failed", false])
	})

	it("checks a redirect and an answer without a body too; a status declaring no headers is not checked", async () => {
		const app = declaring()
		const statuses = await Promise.all(
			[get("/plain"), get("/moved"), get("/tagged", "DELETE"), get("/untagged", "DELETE")].map(
				async (req) => (await app.fetch(req, {})).status,
			),
		)
		expect(statuses).toEqual([200, 302, 204, 500])
	})

	it("adds nothing with outputValidation off: the answer is not checked and stays synchronous", () => {
		const app = honey<{}>()
		app
			.get("/t")
			.output({ "application/json": { ok: z.object({}) }, headers: { ok: z.object({ etag: z.string() }) } })
			.handler((ctx) => ctx.res.json("ok", {}, { headers: {} as never }))
		const answer = app.fetch(get("/t"), {})
		expect([answer instanceof Response, (answer as Response).status]).toEqual([true, 200])
	})
})
