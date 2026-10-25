/**
 * A tool's outputSchema (bit 18 phase d, D1): from its operation's success answer as the TS SDK picks it, when that is
 * JSON with a schema. An object schema goes as it is. Any other shape is wrapped `{result}`, since structuredContent is
 * an object (2025-11-25), and so is an answer whose operation declares response headers (Q11), as `{result, headers}`:
 * a body key named `headers` then never meets them. Each header is a string, as it arrives. No JSON success schema
 * means no outputSchema: the result is text only. An event stream's collect (phase e) is `{events, last_event_id,
 * ended}`, each event's data its declared schema, else a string.
 */
import type { IR } from "../../ir/model.ts"
import type { SdkOp } from "../../ir/sdk-model.ts"
import { jsonSchemaOf, type JsonSchema } from "./schema.ts"

/** A tool's outputSchema, and whether its structuredContent wraps the answer. */
export type Output = { readonly outputSchema: JsonSchema; readonly wrap?: true }

/** What a collect gathered, its events' data as `data` says. */
const collectedOf = (data: JsonSchema): JsonSchema => ({
	type: "object",
	properties: {
		events: {
			type: "array",
			items: {
				type: "object",
				properties: { data, event: { type: "string" }, id: { type: "string" } },
				required: ["data"],
			},
		},
		last_event_id: { anyOf: [{ type: "string" }, { type: "null" }] },
		ended: { type: "string", enum: ["end", "max_events", "cap", "timeout"] },
	},
	required: ["events", "last_event_id", "ended"],
})

/** The outputSchema `op`'s success answer gives, or none. */
export function outputOf(op: SdkOp, ir: IR): Output | undefined {
	if (op.stream === "sse")
		return {
			outputSchema: collectedOf(op.events === undefined ? { type: "string" } : jsonSchemaOf(op.events, ir.schemas)),
		}
	/* the SDK model gives a success its schema only when it is JSON */
	if (op.success.schema === undefined) return undefined
	const result = jsonSchemaOf(op.success.schema, ir.schemas)
	const names = [...new Set((op.ir.responses[op.success.status]?.headers ?? []).map(({ name }) => name.toLowerCase()))]
	if (result.type === "object" && names.length === 0) return { outputSchema: result }
	/* null-prototype: a header named __proto__ is a property, never the object's prototype */
	const headers: Record<string, JsonSchema> = Object.create(null) as Record<string, JsonSchema>
	for (const name of names.sort()) headers[name] = { type: "string" }
	const properties = names.length === 0 ? { result } : { result, headers: { type: "object", properties: headers } }
	return { outputSchema: { type: "object", properties, required: ["result"] }, wrap: true }
}
