/* Rust type emitter — IR-based printer with raw-schema shims for backward compatibility. */

import { schemaToIR } from "./codegen-ir.ts"
import type { IRField, IRSchema } from "./codegen-ir.ts"
import {
	NameScope,
	RUST_KEYWORDS,
	cmpCodeUnit,
	pascalWords,
	rustPlainSnake,
	rustString,
	rustTypeIdent,
	rustValueIdent,
	snakeWords,
} from "./codegen-lang.ts"

export { RUST_KEYWORDS }

export function rustPascal(name: string): string {
	return rustTypeIdent(name)
}

export function rustSnake(name: string): string {
	return snakeWords(name) || "value"
}

/** Returns a safe Rust field identifier (snake_case; reserved keywords get `_` suffix). */
export function rustIdent(name: string): string {
	return rustPlainSnake(name)
}

/** Returns a safe Rust method identifier (snake_case; reserved keywords get `r#` raw-ident prefix). */
export function rustMethodIdent(name: string): string {
	return rustValueIdent(name)
}

/** Crate-level naming shared by every type the SDK emits. */
export type RustTypeNames = {
	ref: (schemaName: string) => string
	/** Unique crate-level type name; the same key always gets the same name. */
	hoist: (key: string, base: string) => string
	/** Component schemas on a by-value cycle; references to them are boxed. */
	cyclic: Set<string>
	resolve: (schema: IRSchema) => IRSchema
}

const DEFAULT_NAMES: RustTypeNames = {
	cyclic: new Set(),
	hoist: (_key, base) => base,
	ref: (name) => rustPascal(name),
	resolve: (s) => s,
}

export type RustRenderUseCtx = {
	parentName: string
	fieldName: string
	decls: Map<string, string>
	circularRefs?: Set<string>
	depth?: number
	names?: RustTypeNames
}

function variantName(raw: string, scope: NameScope): string {
	const base = raw === "" ? "Empty" : rustTypeIdent(raw)
	return scope.claim(base === "Self_" ? "SelfValue" : base)
}

function renderHoistedStringEnum(typeName: string, enumVals: unknown[]): string {
	const l: string[] = []
	l.push(`#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]`)
	l.push(`pub enum ${typeName} {`)
	const scope = new NameScope()
	const variants: string[] = []
	for (const raw of enumVals.filter((v) => v !== null).map(String)) {
		const variant = variantName(raw, scope)
		variants.push(variant)
		if (raw !== variant) l.push(`\t#[serde(rename = ${rustString(raw)})]`)
		l.push(`\t${variant},`)
	}
	l.push(`}`)
	/* Separate impl block so the derive list stays unchanged — derive(Default) would require
	 * #[default] on a variant, which breaks callers that assert the exact derive substring. */
	if (variants.length > 0) {
		l.push(``)
		l.push(`impl Default for ${typeName} {`)
		l.push(`\tfn default() -> Self {`)
		l.push(`\t\tSelf::${variants[0]}`)
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
		if (!Number.isInteger(n)) continue
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
		case "string":
			return "String"
		case "integer":
			return "i64"
		case "number":
			return "f64"
		case "boolean":
			return "bool"
		default:
			return null
	}
}

function constBaseType(val: unknown): string {
	if (typeof val === "boolean") return "bool"
	if (typeof val === "number") return Number.isInteger(val) ? "i64" : "f64"
	return "String"
}

function hoist(ctx: RustRenderUseCtx, render: (name: string) => string): string {
	const names = ctx.names ?? DEFAULT_NAMES
	const name = names.hoist(`${ctx.parentName}.${ctx.fieldName}`, hoistEnumName(ctx.parentName, ctx.fieldName))
	if (!ctx.decls.has(name)) {
		/* placeholder prevents infinite recursion on self-referential schemas */
		ctx.decls.set(name, "")
		ctx.decls.set(name, render(name))
	}
	return name
}

/**
 * Render an IR schema as a Rust type expression for a struct field position.
 * Mutates `ctx.decls` when hoisting enums or anonymous structs.
 */
export function irRenderUseRust(ir: IRSchema, ctx: RustRenderUseCtx, depth = 0): string {
	if (depth > 12) return "serde_json::Value"
	const names = ctx.names ?? DEFAULT_NAMES

	switch (ir.kind) {
		case "ref": {
			const rustName = names.ref(ir.name)
			if (ctx.circularRefs?.has(rustName) || names.cyclic.has(ir.name)) return `Box<${rustName}>`
			return rustName
		}

		case "allOf": {
			if (ctx.names && ir.parts.length > 1) {
				return hoist(ctx, (name) => irRenderTopLevelRust(name, ir, ctx.decls, undefined, ctx.names))
			}
			const firstRef = ir.parts.find((p) => p.kind === "ref")
			if (firstRef && firstRef.kind === "ref") return names.ref(firstRef.name)
			if (ctx.names && ir.parts.length === 1) return irRenderUseRust(ir.parts[0], ctx, depth + 1)
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
			if (ctx.names) {
				return hoist(ctx, (name) => irRenderTopLevelRust(name, ir, ctx.decls, undefined, ctx.names))
			}
			/* union at use-position → always serde_json::Value */
			return "serde_json::Value"
		}

		case "scalar": {
			if (ir.enum) {
				if (ir.type === "string") return hoist(ctx, (name) => renderHoistedStringEnum(name, ir.enum as unknown[]))
				if (ir.type === "integer") return hoist(ctx, (name) => renderHoistedIntEnum(name, ir.enum as unknown[]))
			}
			const prim = primitiveFor(ir.type)
			if (prim) return prim
			return "serde_json::Value"
		}

		case "const": {
			return constBaseType(ir.value)
		}

		case "array": {
			const itemCtx = ctx.names ? { ...ctx, fieldName: `${ctx.fieldName}Item` } : ctx
			const el = irRenderUseRust(ir.items, itemCtx, depth + 1)
			/* a Vec already breaks a recursive cycle */
			return `Vec<${el.startsWith("Box<") ? el.slice(4, -1) : el}>`
		}

		case "tuple": {
			/* Rust emitter ignores tuple item types — always Vec<serde_json::Value> */
			return "Vec<serde_json::Value>"
		}

		case "object": {
			const { fields, additional } = ir

			if (fields.length === 0) {
				if (additional !== undefined && additional !== false) {
					const valType = irRenderUseRust(additional, { ...ctx, fieldName: `${ctx.fieldName}Value` }, depth + 1)
					return `HashMap<String, ${valType.startsWith("Box<") ? valType.slice(4, -1) : valType}>`
				}
				if (additional === false) return "serde_json::Value"
				return "HashMap<String, serde_json::Value>"
			}

			return hoist(ctx, (name) => irRenderTopLevelRust(name, ir, ctx.decls, undefined, ctx.names))
		}

		case "binary": {
			return "String"
		}

		case "unknown": {
			return "serde_json::Value"
		}
	}
}

type RustField = { ident: string; key: string; type: string; required: boolean }

function structFields(
	typeName: string,
	fields: IRField[],
	scope: NameScope,
	decls: Map<string, string>,
	circularRefs: Set<string>,
	names: RustTypeNames | undefined,
): RustField[] {
	return fields
		.slice()
		.sort((a, b) => cmpCodeUnit(a.name, b.name))
		.map((field) => {
			const ft = irRenderUseRust(field.schema, {
				circularRefs,
				decls,
				depth: 1,
				fieldName: field.name,
				names,
				parentName: typeName,
			})
			let type: string
			if (field.required) type = circularRefs.has(ft) && !ft.startsWith("Box<") ? `Box<${ft}>` : ft
			else type = ft.startsWith("Option<") ? ft : `Option<${ft}>`
			return { ident: claimField(field.name, scope), key: field.name, required: field.required, type }
		})
}

/** Field identifier unique in `scope`; a keyword gets a `_` suffix (`type` → `type_`). */
function claimField(key: string, scope: NameScope): string {
	return scope.claim(rustPlainSnake(key))
}

function pushField(l: string[], f: RustField): void {
	const bare = f.ident.startsWith("r#") ? f.ident.slice(2) : f.ident
	if (bare !== f.key) l.push(`\t#[serde(rename = ${rustString(f.key)})]`)
	if (!f.required) l.push(`\t#[serde(skip_serializing_if = "Option::is_none")]`)
	l.push(`\tpub ${f.ident}: ${f.type},`)
}

function discriminatorValues(
	variant: IRSchema,
	propertyName: string,
	mapping: Record<string, string> | undefined,
	names: RustTypeNames,
): string[] {
	if (variant.kind === "ref") {
		const mapped = mapping
			? Object.entries(mapping)
					.filter(([, t]) => t === variant.name)
					.map(([k]) => k)
			: []
		if (mapped.length > 0) return mapped
	}
	const resolved = names.resolve(variant)
	if (resolved.kind === "object") {
		const f = resolved.fields.find((x) => x.name === propertyName)
		if (f?.schema.kind === "const" && typeof f.schema.value === "string") return [f.schema.value]
		if (f?.schema.kind === "scalar" && f.schema.enum) return f.schema.enum.map(String)
	}
	return variant.kind === "ref" ? [variant.name] : []
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
	names?: RustTypeNames,
): string {
	const n = names ?? DEFAULT_NAMES
	const typeName = names ? name : rustPascal(name)
	const circularRefs = new Set([typeName])

	if (ir.kind === "scalar" && ir.enum) {
		if (ir.type === "string") return renderHoistedStringEnum(typeName, ir.enum as unknown[])
		if (ir.type === "integer") return renderHoistedIntEnum(typeName, ir.enum as unknown[])
	}

	if (ir.kind === "const") {
		const rawType = ir.type ?? (raw?.type as string | undefined)
		const base = rawType ? (primitiveFor(rawType) ?? "String") : constBaseType(ir.value)
		return [`#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]`, `pub struct ${typeName}(pub ${base});`].join(
			"\n",
		)
	}

	if (ir.kind === "allOf") {
		const l: string[] = []
		l.push(`#[derive(Debug, Clone, Serialize, Deserialize)]`)
		l.push(`pub struct ${typeName} {`)
		const scope = new NameScope()
		for (const part of ir.parts) {
			if (part.kind === "ref") {
				const refName = n.ref(part.name)
				l.push(`\t#[serde(flatten)]`)
				l.push(`\tpub ${claimField(refName, scope)}: ${refName},`)
				continue
			}
			if (part.kind !== "object") continue
			for (const f of structFields(typeName, part.fields, scope, decls, circularRefs, names)) pushField(l, f)
		}
		l.push(`}`)
		return l.join("\n")
	}

	if (ir.kind === "union" && ir.discriminator && names) {
		const prop = ir.discriminator.propertyName
		const scope = new NameScope(["Unknown"])
		const variants: Array<{ variant: string; type: string; values: string[] }> = []
		ir.variants.forEach((v, i) => {
			const values = discriminatorValues(v, prop, ir.discriminator?.mapping, n)
			let type: string
			if (v.kind === "ref") type = n.ref(v.name)
			else if (v.kind === "object") {
				type = n.hoist(`${typeName}.variant${i}`, `${typeName}${rustPascal(values[0] ?? `Variant${i}`)}`)
				if (!decls.has(type)) {
					decls.set(type, "")
					decls.set(type, irRenderTopLevelRust(type, v, decls, undefined, names))
				}
			} else return
			variants.push({ type, values, variant: variantName(values[0] ?? type, scope) })
		})
		const l: string[] = []
		l.push(`/// ${typeName} holds exactly one variant, selected by the ${rustString(prop)} property.`)
		l.push(`/// A tag no variant declares deserializes to \`Unknown\` with the raw payload.`)
		l.push(`#[derive(Debug, Clone)]`)
		l.push(`pub enum ${typeName} {`)
		for (const v of variants) l.push(`\t${v.variant}(${v.type}),`)
		l.push(`\tUnknown(serde_json::Value),`)
		l.push(`}`)
		l.push(``)
		l.push(`impl Serialize for ${typeName} {`)
		l.push(`\tfn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {`)
		l.push(`\t\tmatch self {`)
		for (const v of variants) l.push(`\t\t\t${typeName}::${v.variant}(v) => v.serialize(s),`)
		l.push(`\t\t\t${typeName}::Unknown(v) => v.serialize(s),`)
		l.push(`\t\t}`)
		l.push(`\t}`)
		l.push(`}`)
		l.push(``)
		l.push(`impl<'de> Deserialize<'de> for ${typeName} {`)
		l.push(`\tfn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {`)
		l.push(`\t\tlet v = serde_json::Value::deserialize(d)?;`)
		l.push(`\t\tlet tag = v.get(${rustString(prop)}).and_then(|t| t.as_str()).unwrap_or_default().to_string();`)
		l.push(`\t\tmatch tag.as_str() {`)
		for (const v of variants) {
			if (v.values.length === 0) continue
			l.push(
				`\t\t\t${v.values.map(rustString).join(" | ")} => serde_json::from_value(v).map(${typeName}::${v.variant}).map_err(serde::de::Error::custom),`,
			)
		}
		l.push(`\t\t\t_ => Ok(${typeName}::Unknown(v)),`)
		l.push(`\t\t}`)
		l.push(`\t}`)
		l.push(`}`)
		return l.join("\n")
	}

	if (ir.kind === "union" && ir.discriminator) {
		/* legacy shim path (no naming context): serde's internal tagging */
		const l: string[] = []
		l.push(`#[derive(Debug, Clone, Serialize, Deserialize)]`)
		l.push(`#[serde(tag = ${rustString(ir.discriminator.propertyName)})]`)
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
		const consts = ir.variants.filter(
			(v): v is Extract<IRSchema, { kind: "const" }> => v.kind === "const" && typeof v.value === "string",
		)
		if (names && consts.length > 0 && consts.length === ir.variants.length) {
			return renderHoistedStringEnum(
				typeName,
				consts.map((c) => c.value),
			)
		}
		const l: string[] = []
		l.push(`#[derive(Debug, Clone, Serialize, Deserialize)]`)
		l.push(`#[serde(untagged)]`)
		l.push(`pub enum ${typeName} {`)
		const others = names ? ir.variants.filter((v) => !consts.includes(v as never)) : ir.variants
		if (names && consts.length > 0) {
			/* const strings as one string enum, tried first: a unit variant cannot match a string */
			const literal = n.hoist(`${typeName}.literal`, `${typeName}Literal`)
			if (!decls.has(literal))
				decls.set(
					literal,
					renderHoistedStringEnum(
						literal,
						consts.map((c) => c.value),
					),
				)
			l.push(`\tLiteral(${literal}),`)
		}
		for (let i = 0; i < others.length; i++) {
			const v = others[i]
			const index = ir.variants.indexOf(v)
			if (v.kind === "ref") {
				const refName = n.ref(v.name)
				l.push(`\tVariant${index}(${n.cyclic.has(v.name) ? `Box<${refName}>` : refName}),`)
			} else {
				const inner = irRenderUseRust(v, {
					circularRefs,
					decls,
					depth: 1,
					fieldName: `variant${index}`,
					names,
					parentName: typeName,
				})
				l.push(`\tVariant${index}(${inner}),`)
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
				names,
				parentName: typeName,
			})
			return `pub type ${typeName} = HashMap<String, ${valType}>;`
		}

		if (fields.length === 0) {
			if (additional === false) return `#[derive(Debug, Clone, Serialize, Deserialize)]\npub struct ${typeName};`
			return `pub type ${typeName} = HashMap<String, serde_json::Value>;`
		}

		const scope = new NameScope()
		const extraIdent = additional ? scope.claim("extra") : ""
		const l: string[] = []
		l.push(`#[derive(Debug, Clone, Serialize, Deserialize)]`)
		l.push(`pub struct ${typeName} {`)
		for (const f of structFields(typeName, fields, scope, decls, circularRefs, names)) pushField(l, f)

		if (additional) {
			const valType = irRenderUseRust(additional, {
				circularRefs,
				decls,
				depth: 1,
				fieldName: "Extra",
				names,
				parentName: typeName,
			})
			l.push(`\t#[serde(flatten)]`)
			l.push(`\tpub ${extraIdent}: HashMap<String, ${valType}>,`)
		}

		l.push(`}`)
		return l.join("\n")
	}

	const aliased = irRenderUseRust(ir, {
		circularRefs,
		decls,
		fieldName: "Value",
		names,
		parentName: typeName,
	})
	return `pub type ${typeName} = ${aliased};`
}

/**
 * Render a schema as a Rust type expression for a struct field position.
 * Mutates `ctx.decls` when hoisting enums or anonymous structs.
 */
export function renderUseRust(schema: Record<string, unknown> | undefined, ctx: RustRenderUseCtx): string {
	return irRenderUseRust(schemaToIR(schema), ctx, ctx.depth ?? 0)
}

export function renderTopLevelRust(name: string, schema: Record<string, unknown>, decls: Map<string, string>): string {
	return irRenderTopLevelRust(name, schemaToIR(schema), decls, schema)
}

export { pascalWords }
