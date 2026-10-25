/**
 * A JSON value as a TypeScript literal (bit 18): every string through the shared escape (F2), a key quoted when it is
 * no identifier, and `__proto__` as a computed key, which defines an own property where a plain `__proto__:` in an
 * object literal would set the object's prototype. Keys keep their order.
 */
import { tsString } from "../shared/escape.ts"
import { quoteKey } from "../shared/literals.ts"

/** `key` as an object literal's key: `__proto__` computed, so it is a property and never the prototype. */
const keyOf = (key: string) => (key === "__proto__" ? `[${tsString(key)}]` : quoteKey(key))

/** `value` as a TypeScript literal, nested lines indented after `indent`. */
export function literal(value: unknown, indent = ""): string {
	if (value === null) return "null"
	if (typeof value === "string") return tsString(value)
	if (typeof value === "boolean") return String(value)
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`no literal for ${value}`)
		return String(value)
	}
	const inner = `${indent}\t`
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]"
		return `[\n${value.map((item) => `${inner}${literal(item, inner)},`).join("\n")}\n${indent}]`
	}
	const entries = Object.entries(value as Record<string, unknown>)
	if (entries.length === 0) return "{}"
	return `{\n${entries.map(([key, item]) => `${inner}${keyOf(key)}: ${literal(item, inner)},`).join("\n")}\n${indent}}`
}
