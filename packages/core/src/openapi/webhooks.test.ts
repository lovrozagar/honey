import { describe, expect, it } from "vitest"
import * as z from "zod"
import { honey } from "../routing/app.ts"
import { webhookContract, type WebhookEvents } from "../security/webhook.ts"
import { generateOpenApi } from "./generate.ts"

const INFO = { title: "T", version: "1" }
type Doc = ReturnType<typeof generateOpenApi>

/** A document of one route and the webhook contract of `events`, or none. */
function documented(events: WebhookEvents | undefined): Doc {
	const app = honey<{}>()
	app.get("/a").handler((c) => c.res.text("ok", "ok"))
	return generateOpenApi(app, { info: INFO, webhooks: events === undefined ? undefined : webhookContract(events) })
}

/** `schema` with a component reference followed. */
function resolved(doc: Doc, schema: unknown): Record<string, unknown> {
	const ref = (schema as { $ref?: string } | undefined)?.$ref
	if (ref === undefined) return (schema ?? {}) as Record<string, unknown>
	return doc.components?.schemas?.[ref.split("/").pop() as string] ?? {}
}

/** The webhook `type`'s operation and its JSON body's schema, references followed. */
function delivery(doc: Doc, type: string) {
	const operation = doc.webhooks?.[type]?.post as Record<string, unknown>
	const content = (operation.requestBody as { content: Record<string, { schema: unknown }> }).content
	const envelope = resolved(doc, content["application/json"]?.schema)
	const properties = envelope.properties as Record<string, unknown>
	return { content, envelope, operation, properties }
}

const Batch = z.object({ batchId: z.string(), rows: z.number() })

describe("webhooks: each event of the contract documented as one Standard Webhooks delivery", () => {
	it("documents an event as a POST under its type: the marker, the three signed headers, the envelope, a 2XX", () => {
		const doc = documented({ "batch.complete": Batch })
		const { content, envelope, operation, properties } = delivery(doc, "batch.complete")
		expect([
			Object.keys(doc),
			Object.keys(doc.webhooks?.["batch.complete"] ?? {}),
			operation["x-honey-webhook"],
			operation.parameters,
			(operation.requestBody as { required: boolean }).required,
			Object.keys(content),
			envelope.required,
			properties.type,
			properties.timestamp,
			resolved(doc, properties.data).required,
			operation.responses,
		]).toEqual([
			["openapi", "info", "paths", "webhooks"],
			["post"],
			"standard-webhooks",
			["webhook-id", "webhook-timestamp", "webhook-signature"].map((name) => ({
				in: "header",
				name,
				required: true,
				schema: { type: "string" },
			})),
			true,
			["application/json"],
			["type", "timestamp", "data"],
			{ const: "batch.complete" },
			{ format: "date-time", type: "string" },
			["batchId", "rows"],
			{ "2XX": { description: "Received" } },
		])
	})

	it("documents data as the schema's output, what the sender writes", () => {
		const doc = documented({ counted: z.object({ note: z.string().optional(), rows: z.number().default(0) }) })
		expect(resolved(doc, delivery(doc, "counted").properties.data).required).toEqual(["rows"])
	})

	it("lists events by type in code-unit order, and has no webhooks when none are declared", () => {
		const doc = documented({ ping: z.object({}), "batch.failed": Batch, "batch.complete": Batch })
		expect([Object.keys(doc.webhooks ?? {}), documented(undefined).webhooks, documented({}).webhooks]).toEqual([
			["batch.complete", "batch.failed", "ping"],
			undefined,
			undefined,
		])
	})
})

describe("webhooks: an event type no receiver could key on is refused", () => {
	it("refuses an empty type and a control character", () => {
		expect(() => documented({ "": Batch })).toThrow(/INVALID_WEBHOOK.*a webhook event needs a type/s)
		expect(() => documented({ "a\nb": Batch })).toThrow(/INVALID_WEBHOOK.*the type holds a control character/s)
	})
})
