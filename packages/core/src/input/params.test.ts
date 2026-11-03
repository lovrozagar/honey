import { describe, expect, it } from "vitest"
import * as z from "zod"
import type { HoneyError } from "../errors/error.ts"
import { honey } from "../routing/app.ts"
import { paramsStep } from "./params.ts"

/** The error `run` throws. */
function thrown(run: () => unknown): HoneyError {
	try {
		run()
	} catch (error) {
		return error as HoneyError
	}
	throw new Error("did not throw")
}

describe("paramsStep: the path params a schema names, validated; the rest strings", () => {
	// v0: 51b07873af
	// v0: bb1c3d0d10
	// v0: fda8b40310
	it("hands each schema its param and keeps what it produced, the unlisted params as they came", () => {
		expect(paramsStep({ id: z.coerce.number() })({ id: "42", orgId: "abc-123" })).toEqual({ id: 42, orgId: "abc-123" })
	})

	// v0: 225f324cb4
	// v0: 39ca2fba1a
	it("every param a schema refuses is one 400, each named params.<name>", () => {
		const error = thrown(() => paramsStep({ id: z.coerce.number(), uid: z.uuid() })({ id: "abc", uid: "nope" }))
		expect([error.status, error.errorKey, Object.keys(error.fields), error.fields.uid?.[0]]).toEqual([
			400,
			"validation_failed",
			["id", "uid"],
			{ error_key: "field_invalid_format", message: expect.any(String), path: "params.uid" },
		])
	})

	it("waits for an async schema, and refuses through it the same way", async () => {
		const later = z.string().refine(async (value) => value.startsWith("v"))
		await expect(paramsStep({ version: later })({ version: "v2" })).resolves.toEqual({ version: "v2" })
		const error = await (paramsStep({ version: later })({ version: "2" }) as Promise<unknown>).catch((e: unknown) => e)
		expect((error as HoneyError).fields.version?.[0]?.path).toBe("params.version")
	})
})

describe(".input({ params }): onto ctx.params, checked against the path", () => {
	const providers = z.enum(["github", "google"])

	it("validates an enum param onto ctx.params, leaves an unlisted one a string, and refuses a bad value", async () => {
		const app = honey<{}>().logger(false)
		app
			.get("/oauth/:provider/:step")
			.input({ params: { provider: providers } })
			.handler((ctx) => ctx.res.json("ok", { params: ctx.params, input: ctx.input }))
		const ok = await app.fetch(new Request("http://localhost/oauth/github/start"), {})
		const bad = await app.fetch(new Request("http://localhost/oauth/gitlab/start"), {})
		expect([await ok.json(), bad.status, ((await bad.json()) as { fields: object }).fields]).toEqual([
			{ input: {}, params: { provider: "github", step: "start" } },
			400,
			{ provider: [expect.objectContaining({ error_key: "field_invalid_enum", path: "params.provider" })] },
		])
	})

	it("waits for an async param schema before the handler, ctx.params holding what it produced", async () => {
		const app = honey<{}>().logger(false)
		const version = z.string().transform(async (value) => Number(value.slice(1)))
		app
			.get("/v/:version")
			.input({ params: { version } })
			.handler((ctx) => ctx.res.json("ok", { params: ctx.params }))
		const res = await app.fetch(new Request("http://localhost/v/v2"), {})
		expect([res.status, await res.json()]).toEqual([200, { params: { version: 2 } }])
	})

	it("refuses at registration a key the path does not name", () => {
		const route = honey<{}>().get("/oauth/:provider")
		expect(() => route.input({ params: { provder: providers } } as never)).toThrow(
			'GET /oauth/:provider: .input() params key "provder" is no param of the path (provider)',
		)
	})
})
