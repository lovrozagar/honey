/** `@lovrozagar/honey/i18n`: the error translations `app.errorI18n(value)` carries, and ICU interpolation. */
export { type ErrorI18nConfig, type ErrorTranslations, errorI18n, translateError } from "./error-i18n.ts"
export { createInterpolator, type ExtractICUVars, interpolate } from "./icu.ts"
export type { TranslationMap, TranslationSource } from "./i18n.ts"
