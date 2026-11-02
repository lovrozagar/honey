/** What a webhook contract lets a sender write, and what the document takes, at compile time. */
import { expectTypeOf, test } from "vitest"
import * as z from "zod"
import { honey } from "../../src/routing/app.ts"
import { generateOpenApi, type GenerateOpenApiOptions } from "../../src/openapi/generate.ts"
import { webhookContract } from "../../src/security/webhook.ts"

const options = { id: "msg_1", occurredAt: new Date(), secrets: "whsec_x" }

const events = webhookContract({
	"batch.complete": z.object({ batchId: z.string() }),
	counted: z.object({ rows: z.number().default(0) }),
})

test("sign takes a declared type's data as the document states it, and refuses anything else", async () => {
	expectTypeOf(events.sign<"counted">)
		.parameter(1)
		.toEqualTypeOf<{ rows: number }>()
	await events.sign("batch.complete", { batchId: "b" }, options)
	await events.sign("counted", { rows: 3 }, options)
	// @ts-expect-error an undeclared type
	await events.sign("batch.gone", { batchId: "b" }, options)
	// @ts-expect-error the wrong field
	await events.sign("batch.complete", { id: "b" }, options)
	// @ts-expect-error the schema's input, where the document states its output: a default is filled in already
	await events.sign("counted", {}, options)
	// @ts-expect-error no occurredAt
	await events.sign("batch.complete", { batchId: "b" }, { id: "msg_1", secrets: "whsec_x" })
})

test("the document's webhooks are a contract, never a free-form record", () => {
	expectTypeOf(events).toExtend<NonNullable<GenerateOpenApiOptions["webhooks"]>>()
	const app = honey<{}>()
	generateOpenApi(app, { info: { title: "T", version: "1" }, webhooks: events })
	// @ts-expect-error a record of bodies is not a contract
	generateOpenApi(app, { info: { title: "T", version: "1" }, webhooks: { paid: { body: z.object({}) } } })
})
