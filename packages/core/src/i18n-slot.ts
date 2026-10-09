import type { HoneyError } from "./error.ts"

/** The translations `errorI18n()` holds, keyed by locale. */
export type ErrorTranslations = {
	errors?: Record<string, Record<string, string>>
	fieldNames?: Record<string, Record<string, string>>
}

export type I18nRuntime = {
	interpolate: (template: string, vars: Record<string, unknown>, locale?: string) => string
	/** `error` in `locale`, or `error` itself when nothing translates */
	translateError: (error: HoneyError, translations: ErrorTranslations, locale: string) => HoneyError
}

const MISSING = 'Honey.errorI18n() requires `import "@lovrozagar/honey/i18n"` in the app entry.'

let runtime: I18nRuntime | undefined

export function registerI18nRuntime(next: I18nRuntime): void {
	runtime = next
}

export function resetI18nRuntime(): void {
	runtime = undefined
}

export function getI18nRuntime(): I18nRuntime {
	if (!runtime) throw new Error(MISSING)
	return runtime
}
