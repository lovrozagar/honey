import type { StandardSchemaLike } from "../types.ts"

export type JsonSchemaConverter = (schema: StandardSchemaLike, io?: "input" | "output") => Record<string, unknown>

let converter: JsonSchemaConverter | undefined

export function setJsonSchemaConverter(next: JsonSchemaConverter | undefined): void {
	converter = next
}

export function getJsonSchemaConverter(): JsonSchemaConverter | undefined {
	return converter
}
