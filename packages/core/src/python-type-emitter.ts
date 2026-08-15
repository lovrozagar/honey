import { schemaToIR } from "./codegen-ir.ts"
import type { IRField, IRSchema } from "./codegen-ir.ts"

const PY_RESERVED = new Set([
	"False", "None", "True", "and", "as", "assert", "async", "await",
	"break", "class", "continue", "def", "del", "elif", "else", "except",
	"finally", "for", "from", "global", "if", "import", "in", "is",
	"lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try",
	"while", "with", "yield",
])

/** Suffix reserved words with `_` per PEP 8 convention. */
export function pyIdent(name: string): string {
	if (PY_RESERVED.has(name)) return `${name}_`
	return name.replace(/[^a-zA-Z0-9_]/g, "_")
}

function primitiveToPy(t: string): string {
	if (t === "string") return "str"
	if (t === "integer") return "int"
	if (t === "number") return "float"
	if (t === "boolean") return "bool"
	if (t === "null") return "None"
	return "Any"
}

function formatConstPy(v: string | number | boolean): string {
	if (typeof v === "string") return JSON.stringify(v)
	if (typeof v === "boolean") return v ? "True" : "False"
	return String(v)
}

function emitScalarPy(ir: Extract<IRSchema, { kind: "scalar" }>): string {
	if (ir.enum) {
		const members = ir.enum
			.map((v) => (typeof v === "string" ? JSON.stringify(v) : String(v)))
			.join(", ")
		return `Literal[${members}]`
	}
	return primitiveToPy(ir.type)
}

function emitObjectPy(ir: Extract<IRSchema, { kind: "object" }>, depth: number): string {
	const { fields, additional } = ir

	if (fields.length === 0) {
		if (additional && additional !== false) {
			return `dict[str, ${irToPython(additional, depth + 1)}]`
		}
		return "dict[str, Any]"
	}

	const sortedFields = fields.slice().sort((a, b) => a.name.localeCompare(b.name))
	const entries = sortedFields.map((f) => {
		const pyType = irToPython(f.schema, depth + 1)
		const annotation = f.required ? pyType : `NotRequired[${pyType}]`
		return `${JSON.stringify(f.name)}: ${annotation}`
	})

	return `TypedDict("X", {${entries.join(", ")}})`
}

/**
 * Convert an IRSchema to a Python type string.
 * depth > 8 returns `Any` (mirrors TS `unknown` fallback).
 */
export function irToPython(ir: IRSchema, depth = 0): string {
	if (depth > 8) return "Any"

	switch (ir.kind) {
		case "scalar":
			return emitScalarPy(ir)

		case "const":
			return `Literal[${formatConstPy(ir.value)}]`

		case "object":
			return emitObjectPy(ir, depth)

		case "array":
			return `list[${irToPython(ir.items, depth + 1)}]`

		case "tuple":
			return `tuple[${ir.items.map((i) => irToPython(i, depth + 1)).join(", ")}]`

		case "union": {
			/* union-of-const → single Literal[...] to match mixed enum behavior */
			if (ir.variants.length > 0 && ir.variants.every((v) => v.kind === "const")) {
				const members = ir.variants
					.map((v) => formatConstPy((v as Extract<IRSchema, { kind: "const" }>).value))
					.join(", ")
				return `Literal[${members}]`
			}
			return ir.variants.map((v) => irToPython(v, depth + 1)).join(" | ")
		}

		case "allOf": {
			const allObjects = ir.parts.every((p) => p.kind === "object")
			if (!allObjects) return "Any"
			/* later parts overwrite earlier (mirrors Object.assign semantics in old jsonSchemaToPy) */
			const mergedMap = new Map<string, IRField>()
			const requiredSet = new Set<string>()
			for (const part of ir.parts) {
				const obj = part as Extract<IRSchema, { kind: "object" }>
				for (const f of obj.fields) {
					mergedMap.set(f.name, f)
					if (f.required) requiredSet.add(f.name)
				}
			}
			const mergedFields: IRField[] = Array.from(mergedMap.values()).map((f) => {
				const mf: IRField = Object.assign({}, f)
				mf.required = requiredSet.has(f.name)
				return mf
			})
			return emitObjectPy({ fields: mergedFields, kind: "object" }, depth)
		}

		case "ref":
			return ir.name

		case "nullable":
			return `${irToPython(ir.inner, depth + 1)} | None`

		/*
		 * binary kind arises from {type:"string", format:"binary"}.
		 * dominant case matches "str"; bare {format:"binary"} with no type is
		 * a deliberate 1-case divergence from old jsonSchemaToPy (see spec §binary).
		 */
		case "binary":
			return "str"

		case "unknown":
			return "Any"
	}
}

/** Thin shim — delegates to irToPython(schemaToIR(schema), depth). */
export function jsonSchemaToPy(
	schema: Record<string, unknown> | undefined,
	depth = 0,
): string {
	if (!schema || depth > 8) return "Any"
	return irToPython(schemaToIR(schema), depth)
}
