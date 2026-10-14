/**
 * Translations by locale: a `TranslationRegistry` loads each locale's map once (a map, or a sync or
 * async loader) and keeps it, and `resolveTranslation` / `resolveFieldName` read through it. A
 * registry owns a `Formatter`, so the plural rules and number formats its messages need are built
 * once for as long as it lives. Keys and locales are own keys only: a `constructor` misses.
 */
import { Formatter } from "./icu.ts"

export type TranslationMap = Record<string, string>

export type TranslationSource = (() => Promise<TranslationMap> | TranslationMap) | TranslationMap

export class TranslationRegistry {
	readonly #loaded = new Map<string, TranslationMap>()
	readonly #sources: Record<string, TranslationSource>
	/** The formatter this registry's translations interpolate with. */
	readonly formatter = new Formatter()

	constructor(sources: Record<string, TranslationSource>) {
		this.#sources = sources
	}

	/** `locale`'s map, loaded on first ask; `undefined` for a locale it has no source for. A loader's failure rejects. */
	async get(locale: string): Promise<TranslationMap | undefined> {
		const loaded = this.#loaded.get(locale)
		if (loaded !== undefined) return loaded
		if (!Object.hasOwn(this.#sources, locale)) return undefined
		const source = this.#sources[locale] as TranslationSource
		const map = typeof source === "function" ? await source() : source
		this.#loaded.set(locale, map)
		return map
	}
}

/** `key`'s message in `locale` with `vars` filled in; the key itself when the locale or the key is unknown. */
export async function resolveTranslation(
	registry: TranslationRegistry,
	locale: string,
	key: string,
	vars: Record<string, number | string>,
): Promise<string> {
	const map = await registry.get(locale)
	if (map === undefined || !Object.hasOwn(map, key)) return key
	return registry.formatter.interpolate(map[key] as string, vars, locale)
}

/** `fieldPath`'s display name in `locale`; the path itself when there is none. */
export async function resolveFieldName(
	registry: TranslationRegistry,
	locale: string,
	fieldPath: string,
): Promise<string> {
	const map = await registry.get(locale)
	return map !== undefined && Object.hasOwn(map, fieldPath) ? (map[fieldPath] as string) : fieldPath
}
