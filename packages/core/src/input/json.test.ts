import { describe, expect, it } from "vitest"
import * as z from "zod"
import type { HoneyError } from "../errors/error.ts"
import { honey } from "../routing/app.ts"
import { jsonInput } from "./json.ts"

/** A POST carrying `body` as application/json. */
const post = (body: string) =>
	new Request("http://localhost/", { body, headers: { "content-type": "application/json" }, method: "POST" })

/** A schema that accepts anything and returns it. */
const passing = { "~standard": { validate: (value: unknown) => ({ value }), vendor: "test", version: 1 } }

/** The error `run` rejects with. */
async function rejected(run: () => Promise<unknown>): Promise<HoneyError> {
	try {
		await run()
	} catch (error) {
		return error as HoneyError
	}
	throw new Error("did not reject")
}

describe("jsonInput: the JSON body, read once and validated", () => {
	// v0: 1b3125d363
	// v0: 865edbf24c
	// v0: d719a3f97d
	it("parses the body and returns what the schema produced", async () => {
		expect([
			await jsonInput(z.object({ email: z.email() }), post('{"email":"test@example.com"}')),
			await jsonInput(passing, post("{}")),
		]).toEqual([{ email: "test@example.com" }, {}])
	})

	// v0: 0f692031c7
	// v0: 6ff6a76484
	// v0: fc7b1d87db
	// v0: 1c5dfda18a
	it("a body the schema refuses is a 400 validation_failed naming json.<field>", async () => {
		const error = await rejected(() => jsonInput(z.object({ name: z.string() }), post('{"name":123}')))
		expect([error.status, error.errorKey, error.fields.name?.[0]?.path]).toEqual([
			400,
			"validation_failed",
			"json.name",
		])
	})

	// v0: 62502397c2
	// v0: 9ef908a0b6
	// v0: 2cd7f9188e
	it("an empty or unparseable body is a 400 malformed_body, and the next request parses as usual", async () => {
		const empty = await rejected(() => jsonInput(passing, post("")))
		const broken = await rejected(() => jsonInput(passing, post("{ invalid json !!!")))
		expect([empty.status, empty.errorKey, empty.vars, broken.errorKey, broken.cause instanceof SyntaxError]).toEqual([
			400,
			"malformed_body",
			{ format: "json" },
			"malformed_body",
			true,
		])
		expect(await jsonInput(passing, post('{"ok":true}'))).toEqual({ ok: true })
	})
})

describe("jsonInput: what a body may carry, and what reading it may raise", () => {
	// v0: 79214a84a5
	// v0: 6fae7b1048
	// v0: 6372571efb
	it("a __proto__ or constructor key in the body is plain data, and a 10000-character key survives", async () => {
		const body = await jsonInput(passing, post('{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}}}'))
		const long = (await jsonInput(passing, post(JSON.stringify({ ["k".repeat(10_000)]: "value" })))) as object
		expect([
			Object.hasOwn(body as object, "__proto__"),
			({} as Record<string, unknown>).polluted,
			Object.keys(long)[0]?.length,
		]).toEqual([true, undefined, 10_000])
	})

	it("an error while reading the body, such as a size limit, passes through unchanged", async () => {
		const limit = new Error("too large")
		const failing = new Request("http://localhost/", {
			body: new ReadableStream({ pull: (c) => c.error(limit) }),
			duplex: "half",
			headers: { "content-type": "application/json" },
			method: "POST",
		} as RequestInit)
		expect(await rejected(() => jsonInput(passing, failing))).toBe(limit)
	})
})

describe("a json body on a route: every method that may carry one", () => {
	// v0: b867e510cb
	// v0: 9cbcfd250d
	// v0: 0f27793bbf
	// v0: 61aa92a7b4
	it("validates the body on every method that may carry one, beside the params", async () => {
		const app = honey<{}>()
		app
			.on(["DELETE", "OPTIONS", "POST"], "/d/:id")
			.input({ json: z.object({ reason: z.string() }), params: z.object({ id: z.coerce.number() }) })
			.handler((ctx) => ctx.res.json("ok", { id: ctx.input.params.id, reason: ctx.input.json.reason }))
		const send = (method: string, path: string, body: string) =>
			app.fetch(
				new Request(`http://localhost${path}`, { body, headers: { "content-type": "application/json" }, method }),
				{},
			)
		const answers = await Promise.all(
			["DELETE", "OPTIONS", "POST"].map(async (method) => {
				const good = await send(method, "/d/7", '{"reason":"spam"}')
				return [
					good.status,
					await good.json(),
					(await send(method, "/d/7", '{"reason":1}')).status,
					(await send(method, "/d/x", '{"reason":"spam"}')).status,
				]
			}),
		)
		expect(answers).toEqual([
			[200, { id: 7, reason: "spam" }, 400, 400],
			[200, { id: 7, reason: "spam" }, 400, 400],
			[200, { id: 7, reason: "spam" }, 400, 400],
		])
	})
})
