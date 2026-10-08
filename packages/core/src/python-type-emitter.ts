import { schemaToIR } from "./codegen-ir.ts"
import type { IRField, IRSchema } from "./codegen-ir.ts"
import { cmpCodeUnit, pyClassName, pyString } from "./codegen-lang.ts"

/** Attribute-safe name that keeps the original casing (`apiKeys` stays `apiKeys`).
 * Non-identifier characters become `_`; keywords get a `_` suffix per PEP 8. */
export function pyIdent(name: string): string {
	let out = name.replace(/[^A-Za-z0-9_]/g, "_")
	if (out === "") out = "value"
	if (/^[0-9]/.test(out)) out = `_${out}`
	if (PY_HARD_KEYWORDS.has(out) || out === "self") return `${out}_`
	return out
}

const PY_HARD_KEYWORDS = new Set(
	"False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(
		" ",
	),
)

function primitiveToPy(t: string): string {
	if (t === "string") return "str"
	if (t === "integer") return "int"
	if (t === "number") return "float"
	if (t === "boolean") return "bool"
	if (t === "null") return "None"
	return "Any"
}

function formatConstPy(v: string | number | boolean): string {
	if (typeof v === "string") return pyString(v)
	if (typeof v === "boolean") return v ? "True" : "False"
	return String(v)
}

function emitScalarPy(ir: Extract<IRSchema, { kind: "scalar" }>): string {
	if (ir.enum) {
		const members = ir.enum
			.filter((v) => v !== null)
			.map((v) => (typeof v === "string" ? pyString(v) : typeof v === "boolean" ? (v ? "True" : "False") : String(v)))
			.join(", ")
		if (members === "") return primitiveToPy(ir.type)
		return `Literal[${members}]`
	}
	return primitiveToPy(ir.type)
}

/** Module-level naming for generated types. Without it, nested objects render inline. */
export type PyTypeNames = {
	ref: (schemaName: string) => string
	/** Hoists an object schema to a named TypedDict and returns its name. */
	hoist: (key: string, base: string, schema: Extract<IRSchema, { kind: "object" }>) => string
}

type Ctx = { names?: PyTypeNames; parent: string; field: string }

function emitObjectPy(ir: Extract<IRSchema, { kind: "object" }>, depth: number, ctx: Ctx): string {
	const { fields, additional } = ir

	if (fields.length === 0) {
		if (additional) {
			return `dict[str, ${irToPythonCtx(additional, depth + 1, { ...ctx, field: `${ctx.field}Value` })}]`
		}
		return "dict[str, Any]"
	}

	if (ctx.names) {
		const base = ctx.field === "" ? ctx.parent : `${ctx.parent}${pyClassName(ctx.field)}`
		return ctx.names.hoist(`${ctx.parent}.${ctx.field}`, base, ir)
	}

	const sortedFields = fields.slice().sort((a, b) => cmpCodeUnit(a.name, b.name))
	const entries = sortedFields.map((f) => {
		const pyType = irToPythonCtx(f.schema, depth + 1, ctx)
		const annotation = f.required ? pyType : `NotRequired[${pyType}]`
		return `${pyString(f.name)}: ${annotation}`
	})

	return `TypedDict("X", {${entries.join(", ")}})`
}

/**
 * Convert an IRSchema to a Python type string.
 * depth > 8 returns `Any` (mirrors TS `unknown` fallback).
 */
export function irToPython(ir: IRSchema, depth = 0): string {
	return irToPythonCtx(ir, depth, { field: "Value", parent: "Model" })
}

/** `irToPython` with module naming: refs map to emitted class names, nested objects are hoisted. */
export function irToPythonNamed(ir: IRSchema, names: PyTypeNames, parent: string, field: string): string {
	return irToPythonCtx(ir, 0, { field, names, parent })
}

function irToPythonCtx(ir: IRSchema, depth: number, ctx: Ctx): string {
	if (depth > 8) return "Any"

	switch (ir.kind) {
		case "scalar":
			return emitScalarPy(ir)

		case "const":
			return `Literal[${formatConstPy(ir.value)}]`

		case "object":
			return emitObjectPy(ir, depth, ctx)

		case "array":
			return `list[${irToPythonCtx(ir.items, depth + 1, { ...ctx, field: `${ctx.field}Item` })}]`

		case "tuple":
			return ir.items.length === 0
				? "tuple[()]"
				: `tuple[${ir.items.map((i, n) => irToPythonCtx(i, depth + 1, { ...ctx, field: `${ctx.field}${n}` })).join(", ")}]`

		case "union": {
			/* union-of-const → single Literal[...] to match mixed enum behavior */
			if (ir.variants.length > 0 && ir.variants.every((v) => v.kind === "const")) {
				const members = ir.variants
					.map((v) => formatConstPy((v as Extract<IRSchema, { kind: "const" }>).value))
					.join(", ")
				return `Literal[${members}]`
			}
			return ir.variants
				.map((v, n) => irToPythonCtx(v, depth + 1, { ...ctx, field: `${ctx.field}Variant${n}` }))
				.join(" | ")
		}

		case "allOf": {
			const allObjects = ir.parts.every((p) => p.kind === "object")
			if (!allObjects) {
				if (ctx.names && ir.parts.length === 1) return irToPythonCtx(ir.parts[0], depth + 1, ctx)
				return "Any"
			}
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
			return emitObjectPy({ fields: mergedFields, kind: "object" }, depth, ctx)
		}

		case "ref":
			return ctx.names ? ctx.names.ref(ir.name) : ir.name

		case "nullable":
			return `${irToPythonCtx(ir.inner, depth + 1, ctx)} | None`

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
export function jsonSchemaToPy(schema: Record<string, unknown> | undefined, depth = 0): string {
	if (!schema || depth > 8) return "Any"
	return irToPython(schemaToIR(schema), depth)
}

/** A key usable as a TypedDict class-syntax attribute (else the functional syntax is used). */
export function isPyAttributeKey(key: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !PY_HARD_KEYWORDS.has(key) && !key.startsWith("__")
}
