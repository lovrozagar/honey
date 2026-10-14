/**
 * The ICU MessageFormat subset honey speaks: `{var}`, `{var, number}`, `{var, plural, =N{…}
 * category{…} other{…}}` with `#`, and `{var, select, …}`, nested to any depth. A missing var stays
 * the literal `{var}`, unbalanced braces pass through as text, and nothing throws. Branches and vars
 * are looked up as own keys only, so a `constructor` or `__proto__` branch or var is plain data.
 *
 * Building an `Intl.PluralRules` or `Intl.NumberFormat` costs some 9 µs, using one well under 1 µs,
 * so a `Formatter` keeps them per locale for as long as it lives (bounded, never module state,
 * H23): the error-i18n value and each registry own one, `createInterpolator()` hands one out, and
 * the free `interpolate` builds one per call.
 */

/**
 * The `{var}` names of an ICU message literal, as a vars type (`cause` is HoneyError's own); `{}`
 * when it has none, so `vars` can be left out.
 */
export type ExtractICUVars<T extends string> = T extends `${string}{${infer Var}}${infer Rest}`
	? Var extends "cause"
		? ExtractICUVars<Rest>
		: { [K in Var | keyof ExtractICUVars<Rest>]: number | string }
	: {}

/* past this many locales a Formatter stops remembering new ones: a locale from request data cannot grow it */
const MAX_LOCALES = 256

type Block = { readonly branches: Record<string, string>; readonly type: "plural" | "select"; readonly varName: string }
type Token = Block | string | { readonly type: "number" | "simple"; readonly varName: string }

/** Own-key lookup: branches and vars are keyed by data, so `constructor` must not reach the prototype. */
function own<T>(record: Record<string, T>, key: string): T | undefined {
	return Object.hasOwn(record, key) ? record[key] : undefined
}

function matchingBrace(text: string, start: number): number {
	let depth = 0
	for (let i = start; i < text.length; i++) {
		if (text[i] === "{") depth++
		else if (text[i] === "}" && --depth === 0) return i
	}
	return -1
}

const SPACE = /\s/

function skipSpace(text: string, from: number): number {
	let i = from
	while (i < text.length && SPACE.test(text[i] as string)) i++
	return i
}

/** `one {…} other {…}` as a null-prototype record of category → template. */
function parseBranches(content: string): Record<string, string> {
	const branches = Object.create(null) as Record<string, string>
	let i = 0
	for (;;) {
		i = skipSpace(content, i)
		let category = ""
		while (i < content.length && content[i] !== "{" && !SPACE.test(content[i] as string)) category += content[i++]
		if (category === "") return branches
		i = skipSpace(content, i)
		if (content[i] !== "{") return branches
		/* a block is tokenized only once its braces match, so its content is balanced: this brace closes */
		const end = matchingBrace(content, i)
		branches[category] = content.slice(i + 1, end)
		i = end + 1
	}
}

/** One `{…}`'s inside as a token: a simple var, a number, or a plural/select block. */
function blockOf(inner: string): Token {
	const comma = inner.indexOf(",")
	if (comma === -1) return { type: "simple", varName: inner.trim() }
	const varName = inner.slice(0, comma).trim()
	const rest = inner.slice(comma + 1).trim()
	const second = rest.indexOf(",")
	if (second === -1) return { type: rest === "number" ? "number" : "simple", varName }
	const format = rest.slice(0, second).trim()
	if (format !== "plural" && format !== "select") return { type: "simple", varName }
	return { branches: parseBranches(rest.slice(second + 1).trim()), type: format, varName }
}

function tokenize(message: string): Token[] {
	const tokens: Token[] = []
	let i = 0
	while (i < message.length) {
		const open = message.indexOf("{", i)
		if (open === -1) {
			tokens.push(message.slice(i))
			break
		}
		if (open > i) tokens.push(message.slice(i, open))
		const close = matchingBrace(message, open)
		if (close === -1) {
			tokens.push(message.slice(open))
			break
		}
		tokens.push(blockOf(message.slice(open + 1, close)))
		i = close + 1
	}
	return tokens
}

/** Interpolates ICU messages, keeping each locale's plural rules and number format while it lives. */
export class Formatter {
	readonly #numbers = new Map<string, Intl.NumberFormat | null>()
	readonly #plurals = new Map<string, Intl.PluralRules>()

	/** CLDR plural category of `n` in `locale` ("one", "few", "other"…); English rules for an unknown locale. */
	#category(n: number, locale: string | undefined): Intl.LDMLPluralRule {
		const key = locale ?? "en"
		let rules = this.#plurals.get(key)
		if (rules === undefined) {
			try {
				rules = new Intl.PluralRules(key)
			} catch {
				/* the answer, not a failure: a locale Intl does not know takes English plural rules */
				rules = new Intl.PluralRules("en")
			}
			if (this.#plurals.size < MAX_LOCALES) this.#plurals.set(key, rules)
		}
		return rules.select(n)
	}

	/** `n` formatted for `locale` (the host's own when unset); plain digits for a locale Intl rejects. */
	#number(n: number, locale: string | undefined): string {
		const key = locale ?? ""
		let format = this.#numbers.get(key)
		if (format === undefined) {
			try {
				format = new Intl.NumberFormat(locale)
			} catch {
				/* the answer, not a failure: a locale Intl rejects formats as plain digits */
				format = null
			}
			if (this.#numbers.size < MAX_LOCALES) this.#numbers.set(key, format)
		}
		return format === null ? String(n) : format.format(n)
	}

	/* a plural block: the exact `=N` branch, else the CLDR category, else `other`; `#` is the count */
	#plural(block: Block, value: unknown, vars: Record<string, unknown>, locale: string | undefined): string {
		const n = Number(value ?? 0)
		const { branches } = block
		const template = own(branches, `=${n}`) ?? own(branches, this.#category(n, locale)) ?? own(branches, "other") ?? ""
		/* ICU formats `#` for the locale; without one, plain digits (the host's locale would make output vary) */
		return this.interpolate(
			template.replaceAll("#", locale === undefined ? String(n) : this.#number(n, locale)),
			vars,
			locale,
		)
	}

	#resolve(token: Token, vars: Record<string, unknown>, locale: string | undefined): string {
		if (typeof token === "string") return token
		const value = own(vars, token.varName)
		const missing = value === undefined || value === null
		switch (token.type) {
			case "simple":
				return missing ? `{${token.varName}}` : String(value)
			case "number":
				return missing ? `{${token.varName}}` : this.#number(Number(value), locale)
			case "select":
				return this.interpolate(
					own(token.branches, missing ? "" : String(value)) ?? own(token.branches, "other") ?? "",
					vars,
					locale,
				)
			default:
				return this.#plural(token, value, vars, locale)
		}
	}

	interpolate(template: string, vars: Record<string, unknown>, locale?: string): string {
		if (!template) return template
		let out = ""
		for (const token of tokenize(template)) out += this.#resolve(token, vars, locale)
		return out
	}
}

/** An `interpolate` that keeps plural rules and number formats between calls: for a caller formatting in a loop. */
export function createInterpolator(): {
	interpolate: (template: string, vars: Record<string, unknown>, locale?: string) => string
} {
	const formatter = new Formatter()
	return { interpolate: (template, vars, locale) => formatter.interpolate(template, vars, locale) }
}

/** Fill an ICU message's vars for `locale`. Each call builds the formatters it needs; `createInterpolator` keeps them. */
export function interpolate(template: string, vars: Record<string, unknown>, locale?: string): string {
	return new Formatter().interpolate(template, vars, locale)
}
