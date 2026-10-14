import { describe, expect, it } from "vitest"
import * as z from "zod"
import type { HoneyError } from "../errors/error.ts"
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
