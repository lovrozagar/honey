import { sanitizeZodJsonSchema } from "../codegen-sanitize.ts"
import type { StandardSchemaLike } from "../types.ts"

export type JsonSchemaConverter = (schema: StandardSchemaLike, io?: "input" | "output") => Record<string, unknown>

let converter: JsonSchemaConverter | undefined

export function setJsonSchemaConverter(next: JsonSchemaConverter | undefined): void {
	converter = next
}

export function getJsonSchemaConverter(): JsonSchemaConverter | undefined {
	return converter
}

type InstanceConverters = {
	"~standard": {
		jsonSchema?: Partial<Record<"input" | "output", (params?: unknown) => unknown>>
		vendor: string
	}
	toJsonSchema?: () => unknown
}

/**
 * The converter used when the full codegen one is not loaded (`@lovrozagar/honey/openapi/spec`
 * on a worker). It uses only what the schema instance carries — Zod 4's Standard JSON Schema
 * and ArkType's `toJsonSchema()` — so it pulls in no validator package. A node JSON Schema
 * cannot express degrades to `{}`, never the whole schema.
 */
export function instanceJsonSchema(
	schema: StandardSchemaLike,
	io: "input" | "output" = "output",
): Record<string, unknown> {
	const s = schema as unknown as InstanceConverters
	try {
		const fromStandard = s["~standard"].jsonSchema?.[io]
		if (typeof fromStandard === "function") {
			const result = fromStandard({ libraryOptions: { unrepresentable: "any" }, target: "draft-2020-12" })
			if (result !== null && typeof result === "object") {
				return s["~standard"].vendor === "zod"
					? sanitizeZodJsonSchema(result as Record<string, unknown>)
					: (result as Record<string, unknown>)
			}
		}
		if (typeof s.toJsonSchema === "function") {
			const result = s.toJsonSchema()
			if (result !== null && typeof result === "object") return result as Record<string, unknown>
		}
	} catch {
		/* the schema cannot describe itself — an unconstrained schema is the honest answer */
	}
	return {}
}
