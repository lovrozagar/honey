/**
 * Java declaration text (bit 16 phase c1): the layout rules google-java-format applies to the shapes the emitter writes,
 * so the emitted text is its canonical form (format.test.ts holds every file to it). A list of items after a prefix
 * stays on one line when it fits in 100 columns; else its items share one continuation line at +4 when they fit there,
 * else each takes its own line. The suffix closes the last line. An assignment whose right side does not fit breaks
 * after `=` first.
 */

/** The longest line google-java-format keeps. */
const WIDTH = 100

/** A list of `items` after `prefix` and before `suffix`, at `indent`: the one-line, shared-line, or one-per-line form. */
export function layout(prefix: string, items: readonly string[], suffix: string, indent = ""): string[] {
	const one = `${indent}${prefix}${items.join(", ")}${suffix}`
	if (one.length <= WIDTH || items.length === 0) return [one]
	const inner = `${indent}    ${items.join(", ")}${suffix}`
	if (inner.length <= WIDTH) return [`${indent}${prefix}`, inner]
	const last = items.length - 1
	return [`${indent}${prefix}`, ...items.map((item, i) => `${indent}    ${item}${i < last ? "," : suffix}`)]
}

/** An assignment's right side: `items` between `prefix` and `suffix`. */
export type Rhs = { readonly prefix: string; readonly items: readonly string[]; readonly suffix: string }

/** `lhs = prefix items suffix` at `indent`: one line when it fits, else broken after `=` with the right side laid out. */
export function assigned(indent: string, lhs: string, { items, prefix, suffix }: Rhs): string[] {
	const one = `${indent}${lhs} = ${prefix}${items.join(", ")}${suffix}`
	if (one.length <= WIDTH) return [one]
	return [`${indent}${lhs} =`, ...layout(prefix, items, suffix, `${indent}    `)]
}

/** A `/** … *\/` doc comment of one line at `indent`. */
export const docOf = (text: string, indent = "  "): string => `${indent}/** ${text} */`
