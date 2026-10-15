import { describe, expect, it } from "vitest"
import * as z from "zod"
import { honey } from "../routing/app.ts"
import { generateOpenApi, type GenerateOpenApiOptions } from "./generate.ts"

const INFO = { title: "T", version: "1" }
type Doc = ReturnType<typeof generateOpenApi>

/** A document of one route and `webhooks`. */
function documented(webhooks: GenerateOpenApiOptions["webhooks"]): Doc {
	const app = honey<{}>()
	app.get("/a").handler((c) => c.res.text("ok", "ok"))
	return generateOpenApi(app, { info: INFO, webhooks })
}

/** `schema` with a component reference followed. */
function resolved(doc: Doc, schema: unknown): Record<string, unknown> {
	const ref = (schema as { $ref?: string } | undefined)?.$ref
	if (ref === undefined) return (schema ?? {}) as Record<string, unknown>
	return doc.components?.schemas?.[ref.split("/").pop() as string] ?? {}
}

const Paid = z.object({ amount: z.number(), id: z.string() })

describe("webhooks: what the API sends, documented in 3.1 webhooks", () => {
	it("documents each webhook by name as a POST of its converted body, a 200 acknowledging it, after paths", () => {
		const doc = documented({
			"invoice.paid": { body: Paid, description: "Sent once an invoice is paid.", summary: "Invoice paid" },
		})
		const operation = doc.webhooks?.["invoice.paid"]?.post as Record<string, unknown>
		const body = (operation.requestBody as { content: Record<string, { schema: unknown }> }).content
		expect([
			Object.keys(doc),
			Object.keys(doc.webhooks?.["invoice.paid"] ?? {}),
			operation.summary,
			operation.description,
			(operation.requestBody as { required: boolean }).required,
			Object.keys(body),
			resolved(doc, body["application/json"]?.schema).required,
			operation.responses,
		]).toEqual([
			["openapi", "info", "paths", "webhooks"],
			["post"],
			"Invoice paid",
			"Sent once an invoice is paid.",
			true,
			["application/json"],
			["amount", "id"],
			{ "200": { description: "Received" } },
		])
	})

	it("uses the method a webhook names, lists webhooks by name, and has none when none are declared", () => {
		const doc = documented({ "b.removed": { body: Paid, method: "DELETE" }, "a.made": { body: Paid, method: "put" } })
		expect([
			Object.keys(doc.webhooks ?? {}),
			Object.keys(doc.webhooks?.["a.made"] ?? {}),
			Object.keys(doc.webhooks?.["b.removed"] ?? {}),
			documented(undefined).webhooks,
			documented({}).webhooks,
		]).toEqual([["a.made", "b.removed"], ["put"], ["delete"], undefined, undefined])
	})

	it("states how the payload is signed as x-honey-signature, for the SDKs' verify helpers", () => {
		const doc = documented({
			"invoice.paid": {
				body: Paid,
				signature: { algorithm: "hmac-sha256", encoding: "hex", header: "X-Signature", prefix: "sha256=" },
			},
			"order.shipped": { body: Paid, signature: { algorithm: "hmac-sha256", encoding: "base64", header: "Sig" } },
			unsigned: { body: Paid },
		})
		const signature = (name: string) =>
			(doc.webhooks?.[name]?.post as Record<string, unknown> | undefined)?.["x-honey-signature"]
		expect([signature("invoice.paid"), signature("order.shipped"), signature("unsigned")]).toEqual([
			{ algorithm: "hmac-sha256", encoding: "hex", header: "X-Signature", prefix: "sha256=" },
			{ algorithm: "hmac-sha256", encoding: "base64", header: "Sig" },
			undefined,
		])
	})
})

describe("webhooks: a declaration that cannot be signed or sent is refused", () => {
	it("refuses an unknown algorithm or encoding, a header that is not a token, a control character, a bad method and no name", () => {
		const bad = (webhook: Record<string, unknown>) => () => documented({ hook: { body: Paid, ...webhook } as never })
		const sig = { algorithm: "hmac-sha256", encoding: "hex", header: "X-Signature" }
		expect(bad({ signature: { ...sig, algorithm: "md5" } })).toThrow(
			/INVALID_WEBHOOK.*webhook "hook": signature algorithm "md5" is not hmac-sha256/s,
		)
		expect(bad({ signature: { ...sig, encoding: "utf8" } })).toThrow(
			/INVALID_WEBHOOK.*webhook "hook": signature encoding "utf8" is not hex or base64/s,
		)
		expect(bad({ signature: { ...sig, header: "X Sig:" } })).toThrow(
			/INVALID_WEBHOOK.*webhook "hook": signature header "X Sig:" is not a header name/s,
		)
		expect(bad({ signature: { ...sig, prefix: "v1=\r\n" } })).toThrow(
			/INVALID_WEBHOOK.*webhook "hook": the signature prefix holds a control character/s,
		)
		expect(bad({ method: "TRACE" })).toThrow(/INVALID_WEBHOOK.*webhook "hook": method "TRACE" is not one of/s)
		expect(() => documented({ "": { body: Paid } })).toThrow(/INVALID_WEBHOOK.*a webhook needs a name/s)
		expect(() => documented({ "a\nb": { body: Paid } })).toThrow(/INVALID_WEBHOOK.*the name holds a control character/s)
		expect(bad({ description: "Paid.\n\n\u001b[2J" })).toThrow(
			/INVALID_WEBHOOK.*webhook "hook": the description holds a control character/s,
		)
		expect(() => documented({ hook: { body: Paid, description: "Paid.\n\tAgain.", summary: "Paid" } })).not.toThrow()
	})
})
