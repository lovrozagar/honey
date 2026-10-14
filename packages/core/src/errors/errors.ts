/**
 * `defineErrors`: an app's error vocabulary. Each key becomes a factory that builds a `HoneyError`
 * with that key and its status; a key with a schema takes a typed payload instead. `ERROR_META`
 * keeps each key's status and schema for the projector and codegen.
 */
import type { StatusKey } from "../response/status.ts"
import type { InferOutput, StandardSchemaLike } from "../validation/standard-schema.ts"
import { type FieldError, HoneyError } from "./error.ts"

type ErrorFactoryOpts = {
	cause?: unknown
	fields?: Record<string, FieldError[]>
	headers?: Record<string, string>
	vars?: Record<string, number | string>
}

type SchemaErrorOpts = {
	cause?: unknown
	headers?: Record<string, string>
}

type ErrorDefWithSchema = {
	schema: StandardSchemaLike
	status: StatusKey
}

type ErrorDef = ErrorDefWithSchema | StatusKey

export type ErrorMetaEntry = {
	schema: StandardSchemaLike | null
	statusKey: StatusKey
}

/** Per-key meta: keeps the schema and status-key literals for the typed error union. */
type ErrorMetaForDef<D extends ErrorDef> = D extends ErrorDefWithSchema
	? { schema: D["schema"]; statusKey: D["status"] }
	: { schema: null; statusKey: D }

export const ERROR_META: unique symbol = /* @__PURE__ */ Symbol.for("honey.error.meta")

export type ErrorFactories<TMap extends Record<string, ErrorDef>> = {
	[K in keyof TMap]: TMap[K] extends ErrorDefWithSchema
		? (data: InferOutput<TMap[K]["schema"]>, opts?: SchemaErrorOpts) => HoneyError
		: (opts?: ErrorFactoryOpts) => HoneyError
} & {
	readonly [ERROR_META]: { [K in keyof TMap]: ErrorMetaForDef<TMap[K]> }
}

function standardFactory(errorKey: string, status: StatusKey) {
	return (opts?: ErrorFactoryOpts) =>
		new HoneyError({
			cause: opts?.cause,
			errorKey,
			fields: opts?.fields,
			headers: opts?.headers,
			status,
			vars: opts?.vars,
		})
}

function schemaFactory(errorKey: string, status: StatusKey) {
	return (data: unknown, opts?: SchemaErrorOpts) =>
		new HoneyError({ cause: opts?.cause, data, errorKey, headers: opts?.headers, status })
}

export function defineErrors<const TMap extends Record<string, ErrorDef>>(map: TMap): ErrorFactories<TMap> {
	const result: Record<string, unknown> = Object.create(null)
	const meta: Record<string, ErrorMetaEntry> = Object.create(null)
	for (const [key, def] of Object.entries(map)) {
		if (typeof def === "string") {
			meta[key] = { schema: null, statusKey: def }
			result[key] = standardFactory(key, def)
		} else {
			meta[key] = { schema: def.schema, statusKey: def.status }
			result[key] = schemaFactory(key, def.status)
		}
	}
	Object.defineProperty(result, ERROR_META, { configurable: false, enumerable: false, value: meta, writable: false })
	return result as ErrorFactories<TMap>
}
