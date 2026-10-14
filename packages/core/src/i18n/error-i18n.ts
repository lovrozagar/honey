/**
 * Error-message i18n: `errorI18n({ errors, fieldNames, resolveLocale })` builds the value
 * `app.errorI18n(value)` carries (H23: a value, never a module slot). For an error answer, core
 * resolves the request's locale and asks it to `translate`: the message from the locale's template
 * for the error key, its vars filled in, and each field path's display name, tried as written and
 * then without its leading segments (`json.email`, then `email`). The result is a copy; the thrown
 * error is never changed, so one instance can answer many requests in many locales.
 */
import { type FieldError, HoneyError } from "../errors/error.ts"
import { DIGEST } from "../errors/projector.ts"
import { dict } from "../routing/tree.ts"
import type { ErrorI18n, ResolveLocaleCtx } from "../routing/settings.ts"
import type { MaybePromise } from "../middleware/middleware.ts"
import { Formatter } from "./icu.ts"

/** Message templates and field display names, each keyed by locale. */
export type ErrorTranslations = {
	/** locale → error key → ICU template */
	errors?: Record<string, Record<string, string>>
	/** locale → field path → display name */
	fieldNames?: Record<string, Record<string, string>>
}

export type ErrorI18nConfig<TEnv> = ErrorTranslations & {
	/** The request's locale: a header, a cookie, the tenant in env, a path param. */
	resolveLocale: (ctx: ResolveLocaleCtx<TEnv>) => MaybePromise<string>
}

/* the locale and keys come from request data: own keys only */
function ownValue<T>(record: Record<string, T> | undefined, key: string): T | undefined {
	return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined
}

/** `path`'s display name: as written, else without its leading segments; the path itself when none. */
function displayName(names: Record<string, string>, path: string): string {
	let candidate = path
	while (candidate) {
		const name = ownValue(names, candidate)
		if (name) return name
		const dot = candidate.indexOf(".")
		if (dot === -1) break
		candidate = candidate.slice(dot + 1)
	}
	return path
}

function translatedFields(
	fields: Readonly<Record<string, FieldError[]>>,
	names: Record<string, string>,
): Record<string, FieldError[]> {
	const out = dict<FieldError[]>()
	for (const source of Object.keys(fields)) {
		out[source] = (fields[source] as FieldError[]).map((field) => ({ ...field, path: displayName(names, field.path) }))
	}
	return out
}

/** A copy of `error` with `message` and `fields`: same key, status, data, headers, vars, cause, stack and digest. */
function copyOf(
	error: HoneyError,
	message: string | undefined,
	fields: Record<string, FieldError[]> | undefined,
): HoneyError {
	const copy = new HoneyError({
		cause: error.cause,
		data: error.data,
		errorKey: error.errorKey,
		fields: fields ?? error.fields,
		headers: error.headers,
		status: error.statusKey,
		vars: error.vars,
	})
	copy.message = message ?? error.message
	if (error.stack !== undefined) copy.stack = error.stack
	/* a 5xx's digest names the operator's line: the client's copy carries it too */
	const digest = (error as unknown as Record<symbol, unknown>)[DIGEST]
	if (digest !== undefined) Object.defineProperty(copy, DIGEST, { value: digest })
	return copy
}

function translateWith(
	formatter: Formatter,
	error: HoneyError,
	translations: ErrorTranslations,
	locale: string,
): HoneyError {
	const template = ownValue(ownValue(translations.errors, locale), error.errorKey)
	const message = template ? formatter.interpolate(template, error.vars ?? {}, locale) : undefined
	const names = ownValue(translations.fieldNames, locale)
	const fields = names && Object.keys(error.fields).length > 0 ? translatedFields(error.fields, names) : undefined
	return message === undefined && fields === undefined ? error : copyOf(error, message, fields)
}

/** `error` in `locale`, as a copy; `error` itself when nothing translates. */
export function translateError(error: HoneyError, translations: ErrorTranslations, locale: string): HoneyError {
	return translateWith(new Formatter(), error, translations, locale)
}

/** The value `app.errorI18n(value)` carries; it keeps one Formatter, so plural rules are built once. */
export function errorI18n<TEnv = unknown>(config: ErrorI18nConfig<TEnv>): ErrorI18n<TEnv> {
	const formatter = new Formatter()
	const translations: ErrorTranslations = { errors: config.errors, fieldNames: config.fieldNames }
	return Object.freeze({
		resolveLocale: config.resolveLocale,
		translate: (error: HoneyError, locale: string) => translateWith(formatter, error, translations, locale),
	})
}
