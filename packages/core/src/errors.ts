import { HoneyError } from "./error.ts"
import type { ExtractICUVars } from "./i18n.ts"
import type { FieldError, InferOutput, StandardSchemaLike, StatusKey } from "./types.ts"

type ErrorFactoryOpts<TVars> = {
	cause?: unknown
	fields?: Record<string, FieldError[]>
	headers?: Record<string, string>
	vars?: TVars
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

export const ERROR_META: unique symbol = Symbol.for("honey.error.meta")

type ErrorFactoryResult<TMap extends Record<string, ErrorDef>, TTranslations extends Record<string, string>> = {
	[K in keyof TMap]: TMap[K] extends ErrorDefWithSchema
		? (data: InferOutput<TMap[K]["schema"]>, opts?: { cause?: unknown; headers?: Record<string, string> }) => HoneyError
		: K extends keyof TTranslations
			? (opts?: ErrorFactoryOpts<ExtractICUVars<TTranslations[K]>>) => HoneyError
			: (opts?: ErrorFactoryOpts<Record<string, string | number>>) => HoneyError
} & {
	readonly [ERROR_META]: { [K in keyof TMap]: ErrorMetaEntry }
}

export function defineErrors<
	TMap extends Record<string, ErrorDef>,
	TTranslations extends Record<string, string> = Record<string, string>,
>(
	map: TMap,
): ErrorFactoryResult<TMap, TTranslations> {
	const result = Object.create(null) as Record<string, unknown>
	const meta = Object.create(null) as Record<string, ErrorMetaEntry>

	for (const [key, def] of Object.entries(map)) {
		if (typeof def === "string") {
			/* standard error — string status key */
			meta[key] = { schema: null, statusKey: def }
			result[key] = (opts?: ErrorFactoryOpts<Record<string, string | number>>) =>
				new HoneyError({
					cause: opts?.cause,
					errorKey: key,
					fields: opts?.fields,
					headers: opts?.headers,
					status: def,
					vars: opts?.vars,
				})
		} else {
			/* custom schema error — { status, schema } */
			meta[key] = { schema: def.schema, statusKey: def.status }
			result[key] = (data: unknown, opts?: { cause?: unknown; headers?: Record<string, string> }) =>
				new HoneyError({
					cause: opts?.cause,
					data,
					errorKey: key,
					headers: opts?.headers,
					status: def.status,
				})
		}
	}

	Object.defineProperty(result, ERROR_META, {
		configurable: false,
		enumerable: false,
		value: meta,
		writable: false,
	})

	return result as ErrorFactoryResult<TMap, TTranslations>
}
