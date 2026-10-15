/**
 * IR → TypeScript type text: the type every TS emitter writes for a schema. Keys and literals go
 * through the one escape layer (F2); a ref is named by the caller, which owns the declarations.
 */
import type { IRSchema } from "../../ir/model.ts"
import { compareCodeUnits } from "./lang.ts"
import { literalType, quoteKey } from "./literals.ts"

export type TypeOptions = {
	/** the type of a binary string: `string` in JSON (the default), `Blob` in a multipart form */
	readonly binary?: string
	/** the name a component ref is declared under; without it a ref is `unknown` */
	readonly refName?: (name: string) => string
}

/* a cycle guard only: resolved documents carry no cycles, so legitimately deep nesting is kept */
const MAX_DEPTH = 64

/** Whether `type` holds `token` outside every bracket and string: `A | B` does, `{ a: A | B }` does not. */
function topLevel(type: string, token: "&" | "=>" | "|"): boolean {
	let depth = 0
	let quote: string | null = null
	for (let at = 0; at < type.length; at++) {
		const c = type[at] as string
		if (quote !== null) {
			if (c === "\\") at++
			else if (c === quote) quote = null
		} else if (c === '"' || c === "'" || c === "`") quote = c
		else if ("({[<".includes(c)) depth++
		else if (")}]".includes(c) || (c === ">" && type[at - 1] !== "=")) depth--
		else if (depth === 0 && type.startsWith(token, at)) return true
	}
	return false
}

/** `el[]`, parenthesised when a union, intersection or function binds looser than `[]`. */
export function arrayOf(el: string): string {
	return topLevel(el, "|") || topLevel(el, "&") || topLevel(el, "=>") ? `(${el})[]` : `${el}[]`
}

/** `A | B`, each part once; `never` for none. */
export function unionOf(parts: readonly string[]): string {
	const unique = [...new Set(parts)]
	if (unique.length === 0) return "never"
	return unique.map((part) => (topLevel(part, "=>") ? `(${part})` : part)).join(" | ")
}

/** `(A | B) & C`, never `A | B & C`: `&` binds tighter than `|`. */
export function intersectionOf(parts: readonly string[]): string {
	return parts.map((part) => (topLevel(part, "|") || topLevel(part, "=>") ? `(${part})` : part)).join(" & ")
}

type Emit = (ir: IRSchema) => string

function scalarOf(ir: Extract<IRSchema, { kind: "scalar" }>): string {
	if (ir.enum !== undefined) return unionOf(ir.enum.map(literalType))
	return ir.type === "integer" ? "number" : ir.type
}

function objectOf(ir: Extract<IRSchema, { kind: "object" }>, emit: Emit): string {
	const extra = ir.additional === undefined || ir.additional === false ? null : emit(ir.additional)
	if (ir.fields.length === 0) return `Record<string, ${extra ?? "unknown"}>`
	const fields = [...ir.fields]
		.sort((a, b) => compareCodeUnits(a.name, b.name))
		.map((field) => `${quoteKey(field.name)}${field.required ? "" : "?"}: ${emit(field.schema)}`)
	const shape = `{ ${fields.join("; ")} }`
	/* an index signature beside fields of other types is TS2411; an intersection says the same */
	return extra === null ? shape : `${shape} & { [k: string]: ${extra} }`
}

function tupleOf(ir: Extract<IRSchema, { kind: "tuple" }>, emit: Emit): string {
	const required = ir.required ?? ir.items.length
	const items = ir.items.map((item, at) => `${emit(item)}${at < required ? "" : "?"}`)
	if (ir.rest !== undefined) items.push(`...${arrayOf(emit(ir.rest))}`)
	return `[${items.join(", ")}]`
}

function emitAt(ir: IRSchema, options: TypeOptions, depth: number): string {
	if (depth > MAX_DEPTH) return "unknown"
	const emit: Emit = (child) => emitAt(child, options, depth + 1)
	switch (ir.kind) {
		case "scalar":
			return scalarOf(ir)
		case "const":
			return literalType(ir.value)
		case "object":
			return objectOf(ir, emit)
		case "array":
			return arrayOf(emit(ir.items))
		case "tuple":
			return tupleOf(ir, emit)
		case "union":
			return unionOf(ir.variants.map(emit))
		case "allOf":
			return intersectionOf(ir.parts.map(emit))
		case "nullable":
			return unionOf([emit(ir.inner), "null"])
		case "ref":
			return options.refName?.(ir.name) ?? "unknown"
		case "binary":
			return options.binary ?? "string"
		default:
			return "unknown"
	}
}

/** The TypeScript type of `ir`. */
export function irToTs(ir: IRSchema, options: TypeOptions = {}): string {
	return emitAt(ir, options, 0)
}
