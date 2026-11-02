/**
 * `defineErrors`: an app's error vocabulary. Each key becomes a factory that builds a `HoneyError`
 * with that key and its status; a key with a schema takes a typed payload instead. `ERROR_META`
 * keeps each key's status and schema for the projector and codegen.
 */
import type { StatusKey } from "../response/status.ts"
import type { InferOutput, StandardSchemaLike } from "../validation/standard-schema.ts"
import { type FieldError, HoneyError } from "./error.ts"

/** Options a factory for a status-only error accepts. */
type ErrorFactoryOpts = {
	/** The underlying failure, kept on the error's `cause` and not sent to the client. */
	cause?: unknown
	/** Per-field problems the client reads under `fields`. */
	fields?: Record<string, FieldError[]>
	/** Headers added to the error response. */
	headers?: Record<string, string>
	/** Named values that fill the translated message's template. */
	vars?: Record<string, number | string>
}

/** Options a factory for a schema error accepts, after its payload. */
type SchemaErrorOpts = {
	/** The underlying failure, kept on the error's `cause` and not sent to the client. */
	cause?: unknown
	/** Headers added to the error response. */
	headers?: Record<string, string>
}

/** An error declared with a payload schema and a status. */
type ErrorDefWithSchema = {
	/**
	 * Types the payload the factory takes and describes it in the OpenAPI document. The payload is not checked at run
	 * time.
	 */
	schema: StandardSchemaLike
	/** The response status, by key. */
	status: StatusKey
}

/** One entry of an error map: a status key, or a schema with a status. */
type ErrorDef = ErrorDefWithSchema | StatusKey

/** What `ERROR_META` records for one error key. */
export type ErrorMetaEntry = {
	/** The payload schema, or `null` for a status-only error. */
	schema: StandardSchemaLike | null
	/** The error's status, by key. */
	statusKey: StatusKey
}

/** Per-key meta: keeps the schema and status-key literals for the typed error union. */
type ErrorMetaForDef<D extends ErrorDef> = D extends ErrorDefWithSchema
	? {
			/** The declared payload schema. */
			schema: D["schema"]
			/** The declared status key. */
			statusKey: D["status"]
		}
	: {
			/** A status-only error has no payload schema. */
			schema: null
			/** The declared status key. */
			statusKey: D
		}

/**
 * Key of the non-enumerable property on a `defineErrors` result that holds each error's status and schema. Read by
 * honey's own error handling and OpenAPI generation.
 */
export const ERROR_META: unique symbol = /* @__PURE__ */ Symbol.for("honey.error.meta")

/**
 * The factories `defineErrors` returns for `TMap`: a payload-taking function for each schema error and an
 * options-taking function for each status-only one, each returning a `HoneyError`.
 */
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

/**
 * Declares an app's errors. `map` gives each error key a status key, or a `{ schema, status }` pair for an error that
 * carries a typed payload. Each key becomes a factory returning a `HoneyError` with that key and status.
 */
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
