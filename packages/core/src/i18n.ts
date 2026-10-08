import { registerI18nRuntime } from "./i18n-slot.ts"

/**
 * Extracts {varName} patterns from ICU MessageFormat string literals at the type level.
 * "cause" is excluded (reserved by HoneyError).
 * Returns {} when no variables found — makes `vars` optional at call site.
 */
export type ExtractICUVars<T extends string> = T extends `${string}{${infer Var}}${infer Rest}`
	? Var extends "cause"
		? ExtractICUVars<Rest>
		: { [K in Var | keyof ExtractICUVars<Rest>]: string | number }
	: {}

type TranslationMap = Record<string, string>

export type TranslationSource = (() => Promise<TranslationMap> | TranslationMap) | TranslationMap

export class TranslationRegistry {
	private cache = new Map<string, TranslationMap>()
	private sources: Record<string, TranslationSource>

	constructor(sources: Record<string, TranslationSource>) {
		this.sources = sources
	}

	async get(locale: string): Promise<TranslationMap | undefined> {
		if (this.cache.has(locale)) {
			return this.cache.get(locale)
		}

		const source = Object.hasOwn(this.sources, locale) ? this.sources[locale] : undefined
		if (source === undefined) {
			return undefined
		}

		const map = typeof source === "function" ? await source() : source
		this.cache.set(locale, map)
		return map
	}
}

/* ---- ICU MessageFormat parser ---- */

const pluralRulesCache = new Map<string, Intl.PluralRules>()

/** CLDR plural category for `n` in `locale` ("one", "few", "many", ...); English rules when the locale is unknown. */
function getPluralCategory(n: number, locale?: string): Intl.LDMLPluralRule {
	const cacheKey = locale ?? "en"
	let rules = pluralRulesCache.get(cacheKey)
	if (rules === undefined) {
		try {
			rules = new Intl.PluralRules(cacheKey)
		} catch {
			rules = new Intl.PluralRules("en")
		}
		if (pluralRulesCache.size < 256) pluralRulesCache.set(cacheKey, rules)
	}
	return rules.select(n)
}

/** Own-property lookup: message branches and variables are keyed by data, so `constructor` must not hit the prototype. */
function own<T>(record: Record<string, T>, key: string): T | undefined {
	return Object.hasOwn(record, key) ? record[key] : undefined
}

function formatNumber(n: number, locale?: string): string {
	try {
		return new Intl.NumberFormat(locale).format(n)
	} catch {
		return String(n)
	}
}

type ParsedBlock = { branches: Record<string, string>; type: "plural" | "select"; varName: string }
type ParsedNumber = { type: "number"; varName: string }
type ParsedSimple = { type: "simple"; varName: string }
type ParsedToken = ParsedBlock | ParsedNumber | ParsedSimple | string

function findMatchingBrace(str: string, start: number): number {
	let depth = 0
	for (let i = start; i < str.length; i++) {
		if (str[i] === "{") depth++
		else if (str[i] === "}") {
			depth--
			if (depth === 0) return i
		}
	}
	return -1
}

function parseBranches(content: string): Record<string, string> {
	const branches: Record<string, string> = Object.create(null) as Record<string, string>
	let i = 0
	while (i < content.length) {
		while (i < content.length && /\s/.test(content[i] ?? "")) i++
		if (i >= content.length) break

		let category = ""
		while (i < content.length && content[i] !== "{" && !/\s/.test(content[i] ?? "")) {
			category += content[i]
			i++
		}
		if (!category) break

		while (i < content.length && /\s/.test(content[i] ?? "")) i++
		if (i >= content.length || content[i] !== "{") break

		const end = findMatchingBrace(content, i)
		if (end === -1) break

		branches[category] = content.slice(i + 1, end)
		i = end + 1
	}
	return branches
}

function tokenize(message: string): ParsedToken[] {
	const tokens: ParsedToken[] = []
	let i = 0

	while (i < message.length) {
		const braceIdx = message.indexOf("{", i)
		if (braceIdx === -1) {
			tokens.push(message.slice(i))
			break
		}

		if (braceIdx > i) {
			tokens.push(message.slice(i, braceIdx))
		}

		const endBrace = findMatchingBrace(message, braceIdx)
		if (endBrace === -1) {
			tokens.push(message.slice(braceIdx))
			break
		}

		const inner = message.slice(braceIdx + 1, endBrace)
		const commaIdx = inner.indexOf(",")

		if (commaIdx === -1) {
			tokens.push({ type: "simple", varName: inner.trim() })
		} else {
			const varName = inner.slice(0, commaIdx).trim()
			const rest = inner.slice(commaIdx + 1).trim()
			const secondComma = rest.indexOf(",")

			if (secondComma === -1) {
				const formatType = rest.trim()
				if (formatType === "number") {
					tokens.push({ type: "number", varName })
				} else {
					tokens.push({ type: "simple", varName })
				}
			} else {
				const formatType = rest.slice(0, secondComma).trim()
				const branchContent = rest.slice(secondComma + 1).trim()
				const branches = parseBranches(branchContent)

				if (formatType === "plural" || formatType === "select") {
					tokens.push({ branches, type: formatType, varName })
				} else {
					tokens.push({ type: "simple", varName })
				}
			}
		}

		i = endBrace + 1
	}

	return tokens
}

function resolveToken(token: ParsedToken, values: Record<string, unknown>, locale?: string): string {
	if (typeof token === "string") return token

	if (token.type === "simple") {
		const val = own(values, token.varName)
		return val !== undefined && val !== null ? String(val) : `{${token.varName}}`
	}

	if (token.type === "number") {
		const val = own(values, token.varName)
		if (val === undefined || val === null) return `{${token.varName}}`
		return formatNumber(Number(val), locale)
	}

	/* plural or select */
	const val = own(values, token.varName)

	if (token.type === "plural") {
		const num = Number(val ?? 0)
		const exactKey = `=${num}`
		const category = getPluralCategory(num, locale)
		const template =
			own(token.branches, exactKey) ?? own(token.branches, category) ?? own(token.branches, "other") ?? ""
		/* ICU formats `#` for the locale; without one, keep the plain digits (host locale would make output vary). */
		const resolved = template.replace(/#/g, locale === undefined ? String(num) : formatNumber(num, locale))
		return interpolate(resolved, values, locale)
	}

	/* select */
	const strVal = val !== undefined && val !== null ? String(val) : ""
	const template = own(token.branches, strVal) ?? own(token.branches, "other") ?? ""
	return interpolate(template, values, locale)
}

/**
 * ICU MessageFormat interpolation.
 * Supports: {var}, {var, plural, one{...} other{...}}, {var, select, ...}, {var, number}
 */
export function interpolate(template: string, vars: Record<string, unknown>, locale?: string): string {
	if (!template) return template
	const tokens = tokenize(template)
	return tokens.map((t) => resolveToken(t, vars, locale)).join("")
}

export async function resolveTranslation(
	registry: TranslationRegistry,
	locale: string,
	key: string,
	vars: Record<string, string | number>,
): Promise<string> {
	const map = await registry.get(locale)
	if (map === undefined) return key
	const template = own(map, key)
	if (template === undefined) return key
	return interpolate(template, vars, locale)
}

export async function resolveFieldName(
	registry: TranslationRegistry,
	locale: string,
	fieldPath: string,
): Promise<string> {
	const map = await registry.get(locale)
	if (map === undefined) return fieldPath
	return own(map, fieldPath) ?? fieldPath
}

export function enableI18n(): void {
	registerI18nRuntime({ interpolate })
}

enableI18n()
