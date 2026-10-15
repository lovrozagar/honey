/**
 * TypeScript text for JSON values: property keys and literal types. Strings go through the one
 * escape layer (F2), never `JSON.stringify` alone.
 */
import { tsString } from "./escape.ts"

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** A property key in a type or object literal: bare when it is an identifier, a string literal otherwise. */
export function quoteKey(key: string): string {
	return IDENTIFIER.test(key) ? key : tsString(key)
}

/** The TypeScript literal type of `value`; one without a literal type widens to its type, or `unknown`. */
export function literalType(value: unknown): string {
	if (value === null) return "null"
	if (value === undefined) return "undefined"
	if (typeof value === "string") return tsString(value)
	if (typeof value === "boolean") return String(value)
	if (typeof value === "bigint") return `${value}n`
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "number"
	return "unknown"
}
