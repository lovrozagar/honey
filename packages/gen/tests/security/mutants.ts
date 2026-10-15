/**
 * The mutants the gen mutation harness swaps in for a guard: each is the guarded export with the one
 * defense it exists for taken out.
 */

/** A literal written as JSON writes it: no per-target policy, so U+2028, U+2029 and the BOM go raw. */
const asJson = (text: string): string => JSON.stringify(text)

/** escape.ts's literal writers without the policy table. */
export const bypassedEscapes = {
	goString: asJson,
	pyString: asJson,
	rustString: asJson,
	stringLiteral: asJson,
	tsString: asJson,
}

/** An ordering that depends on the machine's locale, not on code units. */
export const localeOrder = (a: string, b: string): number => a.localeCompare(b)

/** An object key written as the spec spelled it, never quoted. */
export const rawKey = (key: string): string => key

/* each language's constant-time digest compare, and the value compare a careless helper writes instead */
const VALUE_COMPARE: readonly (readonly [RegExp, string])[] = [
	[/CryptographicOperations\.FixedTimeEquals\(expected, given\)/, "expected.SequenceEqual(given)"],
	[/hmac\.Equal\(expected, given\)/, "bytes.Equal(expected, given)"],
	[/MessageDigest\.isEqual\(expected, given\)/, "java.util.Arrays.equals(expected, given)"],
	[/hmac\.compare_digest\(expected, given\)/, "expected == given"],
	[/expected\.ct_eq\(&given\)\.into\(\)/, "expected == given"],
	[/timingSafeEqual\(expected, given\)/, "expected.equals(given)"],
]

/** A verify helper whose digest compare stops at the first differing byte: a timing oracle. */
export function variableTimeHelper(verifyHelper: (language: string) => string): (language: string) => string {
	return (language) =>
		VALUE_COMPARE.reduce((text, [constantTime, value]) => text.replace(constantTime, value), verifyHelper(language))
}

/** `runtimeSource` with each `[from, to]` applied to the text; a patch that no longer matches throws (a stale mutant is red). */
export function patchedRuntime(
	runtimeSource: () => string,
	patches: readonly (readonly [string, string])[],
): () => string {
	return () =>
		patches.reduce((text, [from, to]) => {
			if (!text.includes(from)) throw new Error(`stale runtime mutant: ${JSON.stringify(from)} is not in the runtime`)
			return text.replace(from, to)
		}, runtimeSource())
}

/* a cross-origin hop that keeps every header, credentials and the auth header included */
export const KEEP_CROSS_ORIGIN_HEADERS = [
	[
		"if (crossOrigin) next.headers = crossOriginHeaders(next.headers as Headers)",
		"if (crossOrigin) next.headers = new Headers(next.headers as Headers)",
	],
] as const

/* a path param written as it came: no percent-encoding, no refusal of a dot segment */
export const RAW_PATH_PARAMS = [
	['if (value === "" || value === "." || value === "..") {', "if (false) {"],
	["return encodeURIComponent(value)\n}", "return value\n}"],
] as const

/* an onLog entry naming the full request URL and the auth header instead of the path template */
export const LEAKY_LOG = [
	[
		"exchangeLog(this.#config.onLog, `${method.toUpperCase()} ${path}`)",
		'exchangeLog(this.#config.onLog, `${method.toUpperCase()} ${url.toString()} ${headers.get("authorization") ?? ""}`)',
	],
] as const
