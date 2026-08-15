/* Rust type emitter — IR-based printer with raw-schema shims for backward compatibility. */

import { schemaToIR } from "./codegen-ir.ts"
import type { IRSchema } from "./codegen-ir.ts"
import { goPascal } from "./go-type-emitter.ts"

export const RUST_KEYWORDS = new Set([
	"as", "break", "const", "continue", "crate", "else", "enum", "extern",
	"false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod",
	"move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct",
	"super", "trait", "true", "type", "unsafe", "use", "where", "while",
	"async", "await", "dyn",
	/* reserved / future */
	"abstract", "become", "box", "do", "final", "macro", "override", "priv",
	"typeof", "unsized", "virtual", "yield", "try",
])

export function rustPascal(name: string): string {
	return goPascal(name)
}

export function rustSnake(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.replace(/[-\s]+/g, "_")
		.replace(/[^a-zA-Z0-9_]/g, "_")
		.toLowerCase()
}

/** Returns a safe Rust field identifier (snake_case; reserved keywords get `_` suffix). */
export function rustIdent(name: string): string {
	const snake = rustSnake(name)
	if (RUST_KEYWORDS.has(snake)) return `${snake}_`
	return snake
}

/** Returns a safe Rust method identifier (snake_case; reserved keywords get `r#` raw-ident prefix). */
export function rustMethodIdent(name: string): string {
	const snake = rustSnake(name)
	/* raw identifiers are the only valid escape for fn names — `_` suffix changes the API */
	if (RUST_KEYWORDS.has(snake)) return `r#${snake}`
	return snake
}

export type RustRenderUseCtx = {
	parentName: string
	fieldName: string
	decls: Map<string, string>
	circularRefs?: Set<string>
	depth?: number
}

function renderHoistedStringEnum(typeName: string, enumVals: unknown[]): string {
	const l: string[] = []
	l.push(`#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]`)
	l.push(`pub enum ${typeName} {`)
	for (const raw of enumVals.map(String)) {
		const variant = rustPascal(raw)
		if (raw !== variant) {
			l.push(`\t#[serde(rename = ${JSON.stringify(raw)})]`)
		}
		l.push(`\t${variant},`)
	}
	l.push(`}`)
	/* Separate impl block so the derive list stays unchanged — derive(Default) would require
	 * #[default] on a variant, which breaks callers that assert the exact derive substring. */
	if (enumVals.length > 0) {
		const firstVariant = rustPascal(String(enumVals[0]))
		l.push(``)
		l.push(`impl Default for ${typeName} {`)
		l.push(`\tfn default() -> Self {`)
		l.push(`\t\tSelf::${firstVariant}`)
		l.push(`\t}`)
		l.push(`}`)
	}
	return l.join("\n")
}

function renderHoistedIntEnum(typeName: string, enumVals: unknown[]): string {
	const l: string[] = []
	l.push(`#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize_repr, Deserialize_repr)]`)
	l.push(`#[repr(i64)]`)
	l.push(`pub enum ${typeName} {`)
	for (const v of enumVals) {
		const n = Number(v)
		const label = n >= 0 ? `L${n}` : `Neg${Math.abs(n)}`
		l.push(`\t${label} = ${n},`)
	}
	l.push(`}`)
	return l.join("\n")
}

function hoistEnumName(parentName: string, fieldName: string): string {
	return `${rustPascal(parentName)}${rustPascal(fieldName)}`
}

function primitiveFor(t: string | undefined): string | null {
	switch (t) {
		case "string": return "String"
		case "integer": return "i64"
		case "number": return "f64"
		case "boolean": return "bool"
		default: return null
	}
}

function constBaseType(val: unknown): string {
	if (typeof val === "boolean") return "bool"
	if (typeof val === "number") return Number.isInteger(val) ? "i64" : "f64"
	return "String"
}

/**
 * Render an IR schema as a Rust type expression for a struct field position.
 * Mutates `ctx.decls` when hoisting enums or anonymous structs.
 */
export function irRenderUseRust(ir: IRSchema, ctx: RustRenderUseCtx, depth = 0): string {
	if (depth > 12) return "serde_json::Value"

	switch (ir.kind) {
		case "ref": {
			const rustName = rustPascal(ir.name)
			if (ctx.circularRefs?.has(rustName)) return `Box<${rustName}>`
			return rustName
		}

		case "allOf": {
			const firstRef = ir.parts.find((p) => p.kind === "ref")
			if (firstRef && firstRef.kind === "ref") return rustPascal(firstRef.name)
			return "serde_json::Value"
		}

		case "nullable": {
			const innerStr = irRenderUseRust(ir.inner, ctx, depth + 1)
			/* inner is already serde_json::Value — don't wrap in Option */
			if (innerStr === "serde_json::Value") return "serde_json::Value"
			/* idempotent: don't double-wrap */
			if (innerStr.startsWith("Option<")) return innerStr
			return `Option<${innerStr}>`
		}

		case "union": {
			/* union at use-position → always serde_json::Value */
			return "serde_json::Value"
		}

		case "scalar": {
			if (ir.enum) {
				const name = hoistEnumName(ctx.parentName, ctx.fieldName)
				if (!ctx.decls.has(name)) {
					if (ir.type === "string") {
						ctx.decls.set(name, renderHoistedStringEnum(name, ir.enum as unknown[]))
					} else {
						ctx.decls.set(name, renderHoistedIntEnum(name, ir.enum as unknown[]))
					}
				}
				return name
			}
			const prim = primitiveFor(ir.type)
			if (prim) return prim
			return "serde_json::Value"
		}

		case "const": {
			return constBaseType(ir.value)
		}

		case "array": {
			const el = irRenderUseRust(ir.items, ctx, depth + 1)
			return `Vec<${el}>`
		}

		case "tuple": {
			/* Rust emitter ignores tuple item types — always Vec<serde_json::Value> */
			return "Vec<serde_json::Value>"
		}

		case "object": {
			const { fields, additional } = ir

			if (fields.length === 0) {
				if (additional !== undefined && additional !== false) {
					const valType = irRenderUseRust(additional, ctx, depth + 1)
					return `HashMap<String, ${valType}>`
				}
				if (additional === false) return "serde_json::Value"
				return "HashMap<String, serde_json::Value>"
			}

			const hoistedName = hoistEnumName(ctx.parentName, ctx.fieldName)
			if (!ctx.decls.has(hoistedName)) {
				/* placeholder prevents infinite recursion on self-referential schemas */
				ctx.decls.set(hoistedName, "")
				const hoisted = irRenderTopLevelRust(hoistedName, ir, ctx.decls)
				ctx.decls.set(hoistedName, hoisted)
			}
			return hoistedName
		}

		case "binary": {
			return "String"
		}

		case "unknown": {
			return "serde_json::Value"
		}
	}
}

/**
 * `raw` 4th arg is for the const-with-declared-type branch only: IR `const` kind
 * strips the type field; `raw.type` provides the override.
 */
export function irRenderTopLevelRust(
	name: string,
	ir: IRSchema,
	decls: Map<string, string>,
	raw?: Record<string, unknown>,
): string {
	const typeName = rustPascal(name)
	const circularRefs = new Set([typeName])

	if (ir.kind === "scalar" && ir.enum) {
		if (ir.type === "string") {
			return renderHoistedStringEnum(typeName, ir.enum as unknown[])
		}
		return renderHoistedIntEnum(typeName, ir.enum as unknown[])
	}

	if (ir.kind === "const") {
		const rawType = raw?.type as string | undefined
		const base = rawType ? (primitiveFor(rawType) ?? "String") : constBaseType(ir.value)
		return [
			`#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]`,
			`pub struct ${typeName}(pub ${base});`,
		].join("\n")
	}

	if (ir.kind === "allOf") {
		const l: string[] = []
		l.push(`#[derive(Debug, Clone, Serialize, Deserialize)]`)
		l.push(`pub struct ${typeName} {`)
		for (const part of ir.parts) {
			if (part.kind === "ref") {
				const refName = rustPascal(part.name)
				l.push(`\t#[serde(flatten)]`)
				l.push(`\tpub ${rustIdent(refName.toLowerCase())}: ${refName},`)
				continue
			}
			if (part.kind !== "object") continue
			const sorted = part.fields.slice().sort((a, b) => a.name.localeCompare(b.name))
			for (const field of sorted) {
				const fieldIdent = rustIdent(field.name)
				const ft = irRenderUseRust(field.schema, {
					circularRefs,
					decls,
					depth: 1,
					fieldName: field.name,
					parentName: typeName,
				})
				const finalType = !field.required && !ft.startsWith("Option<") ? `Option<${ft}>` : ft
				const needsRename = fieldIdent !== field.name
				const needsSkip = !field.required
				if (needsRename) {
					l.push(`\t#[serde(rename = ${JSON.stringify(field.name)})]`)
				}
				if (needsSkip) {
					l.push(`\t#[serde(skip_serializing_if = "Option::is_none")]`)
				}
				l.push(`\tpub ${fieldIdent}: ${finalType},`)
			}
		}
		l.push(`}`)
		return l.join("\n")
	}

	if (ir.kind === "union" && ir.discriminator) {
		const discProp = ir.discriminator.propertyName
		const l: string[] = []
		l.push(`#[derive(Debug, Clone, Serialize, Deserialize)]`)
		l.push(`#[serde(tag = ${JSON.stringify(discProp)})]`)
		l.push(`pub enum ${typeName} {`)
		for (const v of ir.variants) {
			if (v.kind === "ref") {
				const refName = rustPascal(v.name)
				l.push(`\t${refName}(${refName}),`)
			} else {
				l.push(`\tVariant(serde_json::Value),`)
			}
		}
		l.push(`}`)
		return l.join("\n")
	}

	if (ir.kind === "union") {
		const l: string[] = []
		l.push(`#[derive(Debug, Clone, Serialize, Deserialize)]`)
		l.push(`#[serde(untagged)]`)
		l.push(`pub enum ${typeName} {`)
		for (let i = 0; i < ir.variants.length; i++) {
			const v = ir.variants[i]
			if (v.kind === "ref") {
				const refName = rustPascal(v.name)
				l.push(`\tVariant${i}(${refName}),`)
			} else {
				const inner = irRenderUseRust(v, {
					circularRefs,
					decls,
					depth: 1,
					fieldName: `variant${i}`,
					parentName: typeName,
				})
				const finalType = inner === "serde_json::Value" ? "serde_json::Value" : inner
				l.push(`\tVariant${i}(${finalType}),`)
			}
		}
		l.push(`}`)
		return l.join("\n")
	}

	if (ir.kind === "object") {
		const { fields, additional } = ir

		if (fields.length === 0 && additional !== undefined && additional !== false) {
			const valType = irRenderUseRust(additional, {
				circularRefs,
				decls,
				fieldName: "Value",
				parentName: typeName,
			})
			return `pub type ${typeName} = HashMap<String, ${valType}>;`
		}

		if (fields.length === 0) {
			if (additional === false) return `#[derive(Debug, Clone, Serialize, Deserialize)]\npub struct ${typeName};`
			return `pub type ${typeName} = HashMap<String, serde_json::Value>;`
		}

		const sorted = fields.slice().sort((a, b) => a.name.localeCompare(b.name))
		const l: string[] = []
		l.push(`#[derive(Debug, Clone, Serialize, Deserialize)]`)
		l.push(`pub struct ${typeName} {`)
		for (const field of sorted) {
			const fieldIdent = rustIdent(field.name)
			const ft = irRenderUseRust(field.schema, {
				circularRefs,
				decls,
				depth: 1,
				fieldName: field.name,
				parentName: typeName,
			})
			let finalType: string
			if (field.required) {
				finalType = circularRefs.has(ft) && !ft.startsWith("Box<") ? `Box<${ft}>` : ft
			} else {
				finalType = ft.startsWith("Option<") ? ft : `Option<${ft}>`
			}
			const needsRename = fieldIdent !== field.name
			const needsSkip = !field.required
			if (needsRename) {
				l.push(`\t#[serde(rename = ${JSON.stringify(field.name)})]`)
			}
			if (needsSkip) {
				l.push(`\t#[serde(skip_serializing_if = "Option::is_none")]`)
			}
			l.push(`\tpub ${fieldIdent}: ${finalType},`)
		}

		if (additional && additional !== false) {
			const valType = irRenderUseRust(additional, {
				circularRefs,
				decls,
				depth: 1,
				fieldName: "Extra",
				parentName: typeName,
			})
			l.push(`\t#[serde(flatten)]`)
			l.push(`\tpub extra: HashMap<String, ${valType}>,`)
		}

		l.push(`}`)
		return l.join("\n")
	}

	const aliased = irRenderUseRust(ir, {
		circularRefs,
		decls,
		fieldName: "Value",
		parentName: typeName,
	})
	return `pub type ${typeName} = ${aliased};`
}

/**
 * Render a schema as a Rust type expression for a struct field position.
 * Mutates `ctx.decls` when hoisting enums or anonymous structs.
 */
export function renderUseRust(
	schema: Record<string, unknown> | undefined,
	ctx: RustRenderUseCtx,
): string {
	return irRenderUseRust(schemaToIR(schema), ctx, ctx.depth ?? 0)
}

export function renderTopLevelRust(
	name: string,
	schema: Record<string, unknown>,
	decls: Map<string, string>,
): string {
	return irRenderTopLevelRust(name, schemaToIR(schema), decls, schema)
}
