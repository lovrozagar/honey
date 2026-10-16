/**
 * The orders ruff checks (contract 28 §2.3), so the post-pass never has to reorder: `from x import (…)`
 * members as I001 sorts them and `__all__` as RUF022 does. Both group constants (every cased character upper),
 * then classes (a leading capital), then the rest, each group in natural order (a digit run by its number):
 * case-insensitive for imports, case-sensitive for `__all__`.
 */

/** `text` as natural order compares it: each digit run whole, every other character alone. */
const chunks = (text: string) => Array.from(text.matchAll(/\d+|\D/g), (match) => match[0])

/** Natural order: a digit run against a digit run by its number, any other character by its code unit. */
function natural(a: string, b: string): number {
	const [left, right] = [chunks(a), chunks(b)]
	for (let i = 0; i < Math.min(left.length, right.length); i++) {
		const [x, y] = [left[i] as string, right[i] as string]
		const numeric = /^\d/.test(x) && /^\d/.test(y)
		const order = numeric ? Number(BigInt(x) - BigInt(y)) : x < y ? -1 : x > y ? 1 : 0
		if (order !== 0) return Math.sign(order)
	}
	return left.length - right.length
}

/** A member's group: 0 a constant, 1 a class, 2 anything else. */
function group(name: string): number {
	if (name.toUpperCase() === name && name.toLowerCase() !== name) return 0
	return /^[A-Z]/.test(name) ? 1 : 2
}

const ordered = (names: readonly string[], fold: (name: string) => string) =>
	[...new Set(names)].sort((a, b) => group(a) - group(b) || natural(fold(a), fold(b)) || natural(a, b))

/** Import members as ruff's isort orders them. */
export const isortMembers = (names: readonly string[]): string[] => ordered(names, (name) => name.toLowerCase())

/** `__all__` entries as RUF022 orders them. */
export const allOrder = (names: readonly string[]): string[] => ordered(names, (name) => name)

/** One `from <module> import …` line, its members in isort order; none without members. */
export function importLine(module: string, names: Iterable<string>): string[] {
	const members = isortMembers([...names])
	return members.length > 0 ? [`from ${module} import ${members.join(", ")}`] : []
}

/** Import sections (each a list of lines) a blank line apart, the empty ones dropped. */
export const importBlock = (sections: readonly (readonly string[])[]): string[] =>
	sections.filter((lines) => lines.length > 0).flatMap((lines, i) => [...(i > 0 ? [""] : []), ...lines])
