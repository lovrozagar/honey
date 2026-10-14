/**
 * The Standard Schema V1 interface: the vendor-neutral contract zod, valibot, arktype and effect
 * implement. honey validates, converts and types schemas only through it, never through a vendor.
 */

export type StandardSchemaIssue = {
	readonly message: string
	readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined
}

export type StandardSchemaResult = {
	readonly issues?: ReadonlyArray<StandardSchemaIssue> | undefined
	readonly value?: unknown
}

export type StandardSchemaLike = {
	readonly "~standard": {
		readonly types?: { readonly input: unknown; readonly output: unknown } | undefined
		readonly validate: (value: unknown) => Promise<StandardSchemaResult> | StandardSchemaResult
		readonly vendor: string
		readonly version: number
	}
}

/** The type a schema produces once it validated a value. */
export type InferOutput<T> = T extends { readonly "~standard": { readonly types?: infer TTypes } }
	? NonNullable<TTypes> extends { readonly output: infer O }
		? O
		: unknown
	: unknown

/** The type a schema accepts as input. */
export type InferInput<T> = T extends { readonly "~standard": { readonly types?: infer TTypes } }
	? NonNullable<TTypes> extends { readonly input: infer I }
		? I
		: unknown
	: unknown
