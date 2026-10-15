/**
 * One text per schema, the same on every machine: object keys in UTF-16 code-unit order, never a
 * locale's, so two schemas that differ only in key order canonicalize alike and dedupe as one.
 */

/** Locale-independent string order: UTF-16 code units. */
export function compareCodeUnits(a: string, b: string): number {
	if (a === b) return 0
	return a < b ? -1 : 1
}

/** `schema` as JSON text, every object's keys sorted at every depth; array order kept. */
export function canonicalizeSchema(schema: Record<string, unknown>): string {
	return JSON.stringify(schema, (_key, value: unknown) => {
		if (value === null || typeof value !== "object" || Array.isArray(value)) return value
		/* fromEntries defines each key as its own property: a `__proto__` key stays a key */
		return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compareCodeUnits(a, b)))
	})
}
