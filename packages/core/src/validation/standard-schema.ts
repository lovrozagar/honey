/**
 * The Standard Schema V1 interface: the vendor-neutral contract zod, valibot, arktype and effect
 * implement. honey validates, converts and types schemas only through it, never through a vendor.
 */

/** One validation problem reported by a schema. */
export type StandardSchemaIssue = {
	/** Human-readable description of the problem. */
	readonly message: string
	/** Where in the value the problem is, as a list of keys or `{ key }` objects. Unset or empty means the value as a whole. */
	readonly path?:
		| ReadonlyArray<
				| PropertyKey
				| {
						/** The key at this step of the path. */
						readonly key: PropertyKey
				  }
		  >
		| undefined
}

/** What a schema's `validate` returns. */
export type StandardSchemaResult = {
	/** The problems found. honey treats any defined value as a failure, even an empty list. */
	readonly issues?: ReadonlyArray<StandardSchemaIssue> | undefined
	/** The validated value, which honey uses when `issues` is undefined. */
	readonly value?: unknown
}

/** The shape every Standard Schema validator has, whatever library made it. */
export type StandardSchemaLike = {
	/** The Standard Schema properties, under the spec's reserved key. */
	readonly "~standard": {
		/** Carries the schema's input and output types for inference. honey reads it only at the type level. */
		readonly types?:
			| {
					/** What the schema accepts. */
					readonly input: unknown
					/** What the schema produces after validating. */
					readonly output: unknown
			  }
			| undefined
		/** Validates a value. honey's validation stays synchronous unless this returns a promise. */
		readonly validate: (value: unknown) => Promise<StandardSchemaResult> | StandardSchemaResult
		/** Name of the library that made the schema, such as `zod`. honey picks its JSON Schema converter by this name. */
		readonly vendor: string
		/** Version of the Standard Schema spec the schema implements. */
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
