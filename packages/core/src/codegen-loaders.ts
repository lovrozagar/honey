/** Dynamic Zod/Effect JSON Schema loaders. Not a package export — tests may import this file. */

export let toJSONSchemaFn: ((schema: unknown, opts?: { io?: "input" | "output" }) => unknown) | undefined
let toJSONSchemaLoaded = false

export async function loadToJSONSchema(): Promise<
	((schema: unknown, opts?: { io?: "input" | "output" }) => unknown) | undefined
> {
	if (toJSONSchemaLoaded) return toJSONSchemaFn
	toJSONSchemaLoaded = true
	try {
		const id = "zod"
		const zod = await import(id)
		if (typeof zod.toJSONSchema === "function") {
			toJSONSchemaFn = zod.toJSONSchema as (
				schema: unknown,
				opts?: { io?: "input" | "output" },
			) => unknown
		}
	} catch {
		/* zod not available */
	}
	return toJSONSchemaFn
}

export let effectJsonSchemaFn: ((schema: unknown) => unknown) | undefined
let effectLoaded = false

export async function loadEffectJsonSchema(): Promise<((schema: unknown) => unknown) | undefined> {
	if (effectLoaded) return effectJsonSchemaFn
	effectLoaded = true
	try {
		const id = "effect"
		const effect = await import(id)
		if (effect.JSONSchema && typeof effect.JSONSchema.make === "function") {
			effectJsonSchemaFn = effect.JSONSchema.make as (schema: unknown) => unknown
		}
	} catch {
		/* effect not available */
	}
	return effectJsonSchemaFn
}

export async function prepareCodegen(): Promise<void> {
	await Promise.all([loadToJSONSchema(), loadEffectJsonSchema()])
}

export function resetCodegenJsonSchemaLoadersForTests(): void {
	toJSONSchemaFn = undefined
	toJSONSchemaLoaded = true
	effectJsonSchemaFn = undefined
	effectLoaded = true
}
