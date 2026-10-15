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
