/** JSON Schema IR → TypeScript type string emitter. Mirrors jsonSchemaToTS logic case-for-case. */

import type { IRSchema } from "./codegen-ir.ts"

/* TS keywords that are valid identifiers but require quoting as object property keys */
const TS_RESERVED = new Set([
	"break", "case", "catch", "class", "const", "continue", "debugger",
	"default", "delete", "do", "else", "enum", "export", "extends", "false",
	"finally", "for", "function", "if", "import", "in", "instanceof", "new",
	"null", "return", "super", "switch", "this", "throw", "true", "try",
	"typeof", "var", "void", "while", "with", "yield", "let", "static",
	"implements", "interface", "package", "private", "protected", "public",
	"abstract", "as", "async", "await", "constructor", "declare", "from",
	"get", "infer", "is", "keyof", "module", "namespace", "never", "of",
	"readonly", "require", "set", "satisfies", "symbol", "type", "unique",
	"unknown", "override",
])

export function irToTs(ir: IRSchema, depth = 0): string {
	if (depth > 8) return "unknown"

	switch (ir.kind) {
		case "scalar":
			return emitScalar(ir)

		case "const":
			return typeof ir.value === "string" ? JSON.stringify(ir.value) : String(ir.value)

		case "object":
			return emitObject(ir, depth)

		case "array": {
			const el = irToTs(ir.items, depth + 1)
			return el.includes("|") || el.includes("&") ? `(${el})[]` : `${el}[]`
		}

		case "tuple":
			return `[${ir.items.map((i) => irToTs(i, depth + 1)).join(", ")}]`

		case "union":
			return ir.variants.map((v) => irToTs(v, depth + 1)).join(" | ")

		case "allOf":
			return ir.parts.map((p) => irToTs(p, depth + 1)).join(" & ")

		case "ref":
			return ir.name

		case "nullable": {
			const inner = irToTs(ir.inner, depth + 1)
			return `${inner} | null`
		}

		/*
		 * binary kind arises from {type: "string", format: "binary"}.
		 * jsonSchemaToTS falls through to effectiveType "string" → returns "string".
		 * We must match that behavior for byte-equivalence.
		 */
		case "binary":
			return "string"

		case "unknown":
			return "unknown"
	}
}

function emitScalar(ir: Extract<IRSchema, { kind: "scalar" }>): string {
	if (ir.enum) {
		return ir.enum
			.map((v) => (typeof v === "string" ? JSON.stringify(v) : String(v)))
			.join(" | ")
	}

	if (ir.type === "string") return "string"
	if (ir.type === "number" || ir.type === "integer") return "number"
	if (ir.type === "boolean") return "boolean"
	if (ir.type === "null") return "null"
	return "unknown"
}

function emitObject(ir: Extract<IRSchema, { kind: "object" }>, depth: number): string {
	const { fields, additional } = ir

	if (fields.length === 0) {
		if (additional && additional !== false) {
			return `Record<string, ${irToTs(additional, depth + 1)}>`
		}
		return "Record<string, unknown>"
	}

	const sortedFields = fields.slice().sort((a, b) => a.name.localeCompare(b.name))

	const entries = sortedFields.map((field) => {
		const opt = field.required ? "" : "?"
		const needsQuote =
			!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(field.name) || TS_RESERVED.has(field.name)
		const key = needsQuote ? JSON.stringify(field.name) : field.name
		return `${key}${opt}: ${irToTs(field.schema, depth + 1)}`
	})

	if (additional && additional !== false) {
		entries.push(`[k: string]: ${irToTs(additional, depth + 1)}`)
	}

	return `{ ${entries.join("; ")} }`
}
