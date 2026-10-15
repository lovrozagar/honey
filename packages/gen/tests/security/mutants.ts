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
