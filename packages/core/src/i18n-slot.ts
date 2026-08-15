export type I18nRuntime = {
	interpolate: (template: string, vars: Record<string, unknown>, locale?: string) => string
}

const MISSING = 'Honey.errorI18n() requires `import "honey/i18n"` in the app entry.'

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
