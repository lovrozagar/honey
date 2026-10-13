/** Follow `#/components/schemas/...` so tests see the hoisted document. */
export function resolveSchema(
	spec: { components?: { schemas?: Record<string, Record<string, unknown>> } },
	schema: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!schema) return undefined
	if (typeof schema.$ref !== "string") return schema
	const name = schema.$ref.replace("#/components/schemas/", "")
	return spec.components?.schemas?.[name]
}
