/** JSON Schema IR → TypeScript type string emitter. Mirrors jsonSchemaToTS logic case-for-case. */

import type { IRSchema } from "./codegen-ir.ts"
import { arrayOf, intersectionOf, literalType, unionOf } from "./type-emitter.ts"

/* a cycle guard only — resolved specs carry no cycles, so legitimately deep nesting is kept */
const MAX_DEPTH = 64

/* TS keywords that are valid identifiers but require quoting as object property keys */
const TS_RESERVED = new Set([
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"import",
	"in",
	"instanceof",
	"new",
	"null",
	"return",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"var",
	"void",
	"while",
	"with",
	"yield",
	"let",
	"static",
	"implements",
	"interface",
	"package",
	"private",
	"protected",
	"public",
	"abstract",
	"as",
	"async",
	"await",
	"constructor",
	"declare",
	"from",
	"get",
	"infer",
	"is",
	"keyof",
	"module",
	"namespace",
	"never",
	"of",
	"readonly",
	"require",
	"set",
	"satisfies",
	"symbol",
	"type",
	"unique",
	"unknown",
	"override",
])

/**
 * `binary` is the TS type for {type:"string", format:"binary"}: a string inside JSON, a Blob
 * (File included) inside a multipart form body.
 */
export function irToTs(ir: IRSchema, depth = 0, binary = "string"): string {
	if (depth > MAX_DEPTH) return "unknown"

	switch (ir.kind) {
		case "scalar":
			return emitScalar(ir)

		case "const":
			return literalType(ir.value)

		case "object":
			return emitObject(ir, depth, binary)

		case "array": {
			return arrayOf(irToTs(ir.items, depth + 1, binary))
		}

		case "tuple":
			return `[${ir.items.map((i) => irToTs(i, depth + 1, binary)).join(", ")}]`

		case "union":
			return unionOf(ir.variants.map((v) => irToTs(v, depth + 1, binary)))

		case "allOf":
			/* `(A | B) & C`, never `A | B & C` */
			return intersectionOf(ir.parts.map((p) => irToTs(p, depth + 1, binary)))

		/* refs are resolved before emit; one left over names nothing this file declares */
		case "ref":
			return "unknown"

		case "nullable": {
			return unionOf([irToTs(ir.inner, depth + 1, binary), "null"])
		}

		/* binary kind arises from {type: "string", format: "binary"}; see `binary` above */
		case "binary":
			return binary

		case "unknown":
			return "unknown"
	}
}

function emitScalar(ir: Extract<IRSchema, { kind: "scalar" }>): string {
	if (ir.enum) {
		return unionOf(ir.enum.map(literalType))
	}

	if (ir.type === "string") return "string"
	if (ir.type === "number" || ir.type === "integer") return "number"
	if (ir.type === "boolean") return "boolean"
	if (ir.type === "null") return "null"
	return "unknown"
}

function emitObject(ir: Extract<IRSchema, { kind: "object" }>, depth: number, binary: string): string {
	const { fields, additional } = ir

	if (fields.length === 0) {
		if (additional) {
			return `Record<string, ${irToTs(additional, depth + 1, binary)}>`
		}
		return "Record<string, unknown>"
	}

	/* code-unit order: the same output on every machine, whatever its locale */
	const sortedFields = fields.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

	const entries = sortedFields.map((field) => {
		const opt = field.required ? "" : "?"
		const needsQuote = !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(field.name) || TS_RESERVED.has(field.name)
		const key = needsQuote ? JSON.stringify(field.name) : field.name
		return `${key}${opt}: ${irToTs(field.schema, depth + 1, binary)}`
	})

	/* an index signature beside fields of other types is TS2411; an intersection says the same thing */
	if (additional) {
		return `{ ${entries.join("; ")} } & { [k: string]: ${irToTs(additional, depth + 1, binary)} }`
	}

	return `{ ${entries.join("; ")} }`
}
