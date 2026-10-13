import { schemaToIR } from "./codegen-ir.ts"
import type { IRField, IRSchema } from "./codegen-ir.ts"
import {
	GO_KEYWORDS,
	cmpCodeUnit,
	goExported,
	goJsonTag,
	goJsonTagNameValid,
	goString,
	NameScope,
} from "./codegen-lang.ts"

export { GO_KEYWORDS }

/** Exported Go identifier from kebab-case, snake_case, dotted, camelCase or arbitrary text. */
export function goPascal(name: string): string {
	return goExported(name)
}

/**
 * Returns a safe Go identifier. PascalCase makes all exported identifiers safe
 * without keyword conflicts (Go keywords are all lowercase; Title casing avoids clashes).
 * For unexported uses the keyword check adds `_` suffix.
 */
export function goIdent(name: string, exported = true): string {
	const pascal = goPascal(name)
	if (exported) return pascal
	const lower = name.toLowerCase()
	if (GO_KEYWORDS.has(lower)) return `${lower}_`
	return name
}

export function goTag(jsonKey: string, omit: boolean | "omitzero"): string {
	return goJsonTag(jsonKey, omit)
}

/** An optional field that may also be null: absent, null and a value are three different requests. */
function isTriState(field: IRField): boolean {
	return !field.required && field.schema.kind === "nullable"
}

/** Go type of a struct field: `Nullable[T]` for optional + nullable, else a pointer when optional. */
function structFieldType(field: IRField, render: (schema: IRSchema) => string): string {
	if (isTriState(field) && field.schema.kind === "nullable") {
		/* a cyclic ref stays a pointer: Nullable holds its value inline */
		return `Nullable[${render(field.schema.inner)}]`
	}
	return fieldType(render(field.schema), field.required)
}

function fieldTag(field: IRField): string {
	return goTag(field.name, isTriState(field) ? "omitzero" : !field.required)
}

/** Package-level naming shared by every type the SDK emits. */
export type GoTypeNames = {
	/** Go type name for a component schema. */
	ref: (schemaName: string) => string
	/** Unique package-level name for a hoisted declaration; the same key always gets the same name. */
	hoist: (key: string, base: string) => string
	/** Unique package-level name for a constant. */
	claimConst: (base: string) => string
	/** Component schemas that reach themselves by value; references to them become pointers. */
	cyclic: Set<string>
	resolve: (schema: IRSchema) => IRSchema
}

const DEFAULT_NAMES: GoTypeNames = {
	claimConst: (base) => base,
	cyclic: new Set(),
	hoist: (_key, base) => base,
	ref: (name) => goPascal(name),
	resolve: (s) => s,
}

export type RenderUseCtx = {
	parentName: string
	fieldName: string
	decls: Map<string, string>
	circularRefs?: Set<string>
	depth?: number
	names?: GoTypeNames
}

export function isNullable(schema: Record<string, unknown>): boolean {
	if (schema.nullable === true) return true
	const t = schema.type
	if (Array.isArray(t) && t.includes("null")) return true
	const variants = (schema.anyOf ?? schema.oneOf) as Record<string, unknown>[] | undefined
	if (variants && variants.some((v) => v.type === "null")) return true
	return false
}

export function isStringEnum(schema: Record<string, unknown>): boolean {
	const e = schema.enum as unknown[] | undefined
	if (!e || e.length === 0) return false
	const t = schema.type
	if (t === "string") return true
	if (!t && e.every((v) => typeof v === "string")) return true
	return false
}

export function isIntEnum(schema: Record<string, unknown>): boolean {
	const e = schema.enum as unknown[] | undefined
	if (!e || e.length === 0) return false
	const t = schema.type
	if (t === "integer") return true
	if (!t && e.every((v) => typeof v === "number" && Number.isInteger(v))) return true
	return false
}

export function isLiteralConst(schema: Record<string, unknown>): boolean {
	return schema.const !== undefined
}

export function hoistEnumName(parentName: string, fieldName: string): string {
	return `${goPascal(parentName)}${goPascal(fieldName)}`
}

function enumLabel(v: unknown): string {
	if (typeof v === "string") return v === "" ? "Empty" : goExported(v)
	if (typeof v === "number") return v < 0 ? `Neg${String(-v).replace(/\./g, "_")}` : String(v).replace(/\./g, "_")
	return goExported(String(v))
}

function renderHoistedStringEnum(typeName: string, enumVals: unknown[], names: GoTypeNames): string {
	const l: string[] = []
	l.push(`type ${typeName} string`)
	l.push(`const (`)
	const local = new NameScope()
	for (const v of enumVals) {
		if (v === null) continue
		const constName = names.claimConst(local.claim(`${typeName}${enumLabel(v)}`))
		l.push(`\t${constName} ${typeName} = ${goString(String(v))}`)
	}
	l.push(`)`)
	return l.join("\n")
}

function renderHoistedIntEnum(typeName: string, enumVals: unknown[], names: GoTypeNames): string {
	const l: string[] = []
	l.push(`type ${typeName} int`)
	l.push(`const (`)
	const local = new NameScope()
	for (const v of enumVals) {
		if (typeof v !== "number" || !Number.isInteger(v)) continue
		const constName = names.claimConst(local.claim(`${typeName}${enumLabel(v)}`))
		l.push(`\t${constName} ${typeName} = ${String(v)}`)
	}
	l.push(`)`)
	return l.join("\n")
}

function primitiveFor(t: string | undefined): string | null {
	switch (t) {
		case "string":
			return "string"
		case "integer":
			return "int64"
		case "number":
			return "float64"
		case "boolean":
			return "bool"
		default:
			return null
	}
}

function constBaseType(val: unknown): string {
	if (typeof val === "boolean") return "bool"
	if (typeof val === "number") return Number.isInteger(val) ? "int64" : "float64"
	return "string"
}

function isNilable(t: string): boolean {
	return (
		t === "json.RawMessage" ||
		t.startsWith("*") ||
		t.startsWith("[]") ||
		t.startsWith("map[") ||
		t === "any" ||
		t === "interface{}"
	)
}

/** Mutates `ctx.decls` when hoisting enums. */
export function irRenderUse(ir: IRSchema, ctx: RenderUseCtx, depth = 0): string {
	if (depth > 12) return "json.RawMessage"
	const names = ctx.names ?? DEFAULT_NAMES

	switch (ir.kind) {
		case "ref": {
			const goName = names.ref(ir.name)
			if (ctx.circularRefs?.has(goName) || names.cyclic.has(ir.name)) return `*${goName}`
			return goName
		}

		case "allOf": {
			const firstRef = ir.parts.find((p) => p.kind === "ref")
			if (ir.parts.length > 1 && ctx.names) {
				/* several parts: hoist a struct that embeds/inlines them all */
				const name = names.hoist(`${ctx.parentName}.${ctx.fieldName}`, hoistEnumName(ctx.parentName, ctx.fieldName))
				if (!ctx.decls.has(name)) {
					ctx.decls.set(name, "")
					ctx.decls.set(name, irRenderTopLevel(name, ir, ctx.decls, undefined, names))
				}
				return name
			}
			if (firstRef && firstRef.kind === "ref") return names.ref(firstRef.name)
			return "json.RawMessage"
		}

		case "nullable": {
			const innerStr = irRenderUse(ir.inner, ctx, depth + 1)
			/* already-nilable forms need no pointer prefix */
			if (isNilable(innerStr)) return innerStr
			return `*${innerStr}`
		}

		case "union": {
			/* union at use-position → always json.RawMessage (Go has no native union type) */
			return "json.RawMessage"
		}

		case "scalar": {
			if (ir.enum) {
				const name = names.hoist(`${ctx.parentName}.${ctx.fieldName}`, hoistEnumName(ctx.parentName, ctx.fieldName))
				if (!ctx.decls.has(name)) {
					if (ir.type === "string") {
						ctx.decls.set(name, renderHoistedStringEnum(name, ir.enum as unknown[], names))
					} else if (ir.type === "integer") {
						ctx.decls.set(name, renderHoistedIntEnum(name, ir.enum as unknown[], names))
					} else {
						return primitiveFor(ir.type) ?? "json.RawMessage"
					}
				}
				return name
			}
			const prim = primitiveFor(ir.type)
			if (prim) return prim
			return "json.RawMessage"
		}

		case "const": {
			return constBaseType(ir.value)
		}

		case "array": {
			const itemCtx = ctx.names ? { ...ctx, fieldName: `${ctx.fieldName}Item` } : ctx
			const el = irRenderUse(ir.items, itemCtx, depth + 1)
			/* a slice already breaks a recursive cycle */
			return `[]${el.startsWith("*") && ir.items.kind === "ref" ? el.slice(1) : el}`
		}

		case "tuple": {
			return `[${ir.items.length}]interface{}`
		}

		case "object": {
			const { fields, additional } = ir

			if (fields.length === 0) {
				if (additional) {
					const valType = irRenderUse(additional, ctx, depth + 1)
					return `map[string]${valType.startsWith("*") && additional.kind === "ref" ? valType.slice(1) : valType}`
				}
				if (additional === false) return "struct{}"
				return "map[string]interface{}"
			}

			if (ctx.names) {
				/* a named type: callers can construct it, and it can carry (un)marshal methods */
				const name = names.hoist(`${ctx.parentName}.${ctx.fieldName}`, hoistEnumName(ctx.parentName, ctx.fieldName))
				if (!ctx.decls.has(name)) {
					ctx.decls.set(name, "")
					ctx.decls.set(name, irRenderTopLevel(name, ir, ctx.decls, undefined, names))
				}
				return name
			}
			return irRenderAnonStruct(ir, ctx, depth)
		}

		case "binary": {
			/*
			 * dominant case: {type:"string", format:"binary"} → IR binary → "string".
			 * bare {format:"binary"} no-type is a 1-case deliberate divergence from raw
			 * (raw returns "json.RawMessage", IR returns "string"). Documented in spec §binary.
			 */
			return "string"
		}

		case "unknown": {
			return "json.RawMessage"
		}
	}
}

function sortFields(fields: IRField[]): IRField[] {
	return fields.slice().sort((a, b) => cmpCodeUnit(a.name, b.name))
}

function fieldType(ft: string, required: boolean): string {
	return !required && !isNilable(ft) ? `*${ft}` : ft
}

function irRenderAnonStruct(ir: Extract<IRSchema, { kind: "object" }>, ctx: RenderUseCtx, depth: number): string {
	const lines: string[] = []
	lines.push(`struct {`)
	const scope = new NameScope()
	for (const field of sortFields(ir.fields)) {
		const fieldGoName = scope.claim(goPascal(field.name))
		const childParent = `${ctx.parentName}${goPascal(ctx.fieldName)}`
		const childCtx: RenderUseCtx = {
			circularRefs: ctx.circularRefs,
			decls: ctx.decls,
			depth: depth + 1,
			fieldName: field.name,
			names: ctx.names,
			parentName: childParent,
		}
		const type = structFieldType(field, (schema) => irRenderUse(schema, childCtx, depth + 1))
		lines.push(`\t${fieldGoName} ${type} ${fieldTag(field)}`)
	}
	lines.push(`}`)
	return lines.join("\n")
}

type StructField = {
	goName: string
	key: string
	type: string
	required: boolean
	tagged: boolean
	/** Optional + nullable: `Nullable[T]` under `omitzero`. */
	triState: boolean
}

/** A struct plus, when needed, (un)marshal methods for keys encoding/json cannot tag and for extra keys. */
function renderStruct(
	typeName: string,
	embeds: string[],
	fields: StructField[],
	extra: { goName: string; valueType: string } | undefined,
): string {
	const l: string[] = []
	l.push(`type ${typeName} struct {`)
	for (const e of embeds) l.push(`\t${e}`)
	for (const f of fields) {
		const tag = f.tagged ? goTag(f.key, f.triState ? "omitzero" : !f.required) : '`json:"-"`'
		l.push(`\t${f.goName} ${f.type} ${tag}`)
	}
	if (extra) l.push(`\t${extra.goName} map[string]${extra.valueType} \`json:"-"\``)
	l.push(`}`)

	const untagged = fields.filter((f) => !f.tagged)
	/* a required slice or map left nil would encode as null, which the schema does not allow */
	const emptyWhenNil = fields.filter(
		(f) => f.required && !f.triState && (f.type.startsWith("[]") || f.type.startsWith("map[")),
	)
	const fillNil = (target: string): void => {
		for (const f of emptyWhenNil) {
			l.push(`\tif ${target}.${f.goName} == nil {`)
			l.push(`\t\t${target}.${f.goName} = ${f.type}{}`)
			l.push(`\t}`)
		}
	}
	if (untagged.length === 0 && !extra) {
		if (emptyWhenNil.length === 0) return l.join("\n")
		l.push(``)
		l.push(`func (s ${typeName}) MarshalJSON() ([]byte, error) {`)
		l.push(`\ttype plain ${typeName}`)
		l.push(`\tp := plain(s)`)
		fillNil("p")
		l.push(`\treturn json.Marshal(p)`)
		l.push(`}`)
		return l.join("\n")
	}
	const known = fields.map((f) => goString(f.key))
	l.push(``)
	l.push(`func (s *${typeName}) UnmarshalJSON(data []byte) error {`)
	l.push(`\ttype plain ${typeName}`)
	l.push(`\tvar base plain`)
	l.push(`\tif err := json.Unmarshal(data, &base); err != nil {`)
	l.push(`\t\treturn err`)
	l.push(`\t}`)
	l.push(`\tvar raw map[string]json.RawMessage`)
	l.push(`\tif err := json.Unmarshal(data, &raw); err != nil {`)
	l.push(`\t\treturn err`)
	l.push(`\t}`)
	for (const f of untagged) {
		l.push(`\tif v, ok := raw[${goString(f.key)}]; ok {`)
		l.push(`\t\tif err := json.Unmarshal(v, &base.${f.goName}); err != nil {`)
		l.push(`\t\t\treturn err`)
		l.push(`\t\t}`)
		l.push(`\t}`)
	}
	if (extra) {
		l.push(`\tknown := map[string]bool{${known.map((k) => `${k}: true`).join(", ")}}`)
		l.push(`\tfor k, v := range raw {`)
		l.push(`\t\tif known[k] {`)
		l.push(`\t\t\tcontinue`)
		l.push(`\t\t}`)
		l.push(`\t\tvar item ${extra.valueType}`)
		l.push(`\t\tif err := json.Unmarshal(v, &item); err != nil {`)
		l.push(`\t\t\treturn err`)
		l.push(`\t\t}`)
		l.push(`\t\tif base.${extra.goName} == nil {`)
		l.push(`\t\t\tbase.${extra.goName} = map[string]${extra.valueType}{}`)
		l.push(`\t\t}`)
		l.push(`\t\tbase.${extra.goName}[k] = item`)
		l.push(`\t}`)
	}
	l.push(`\t*s = ${typeName}(base)`)
	l.push(`\treturn nil`)
	l.push(`}`)
	l.push(``)
	l.push(`func (s ${typeName}) MarshalJSON() ([]byte, error) {`)
	l.push(`\ttype plain ${typeName}`)
	l.push(`\tp := plain(s)`)
	fillNil("p")
	l.push(`\tencoded, err := json.Marshal(p)`)
	l.push(`\tif err != nil {`)
	l.push(`\t\treturn nil, err`)
	l.push(`\t}`)
	l.push(`\tvar out map[string]json.RawMessage`)
	l.push(`\tif err := json.Unmarshal(encoded, &out); err != nil {`)
	l.push(`\t\treturn nil, err`)
	l.push(`\t}`)
	if (extra) {
		l.push(`\tfor k, v := range p.${extra.goName} {`)
		l.push(`\t\tif _, taken := out[k]; taken {`)
		l.push(`\t\t\tcontinue`)
		l.push(`\t\t}`)
		l.push(`\t\tb, err := json.Marshal(v)`)
		l.push(`\t\tif err != nil {`)
		l.push(`\t\t\treturn nil, err`)
		l.push(`\t\t}`)
		l.push(`\t\tout[k] = b`)
		l.push(`\t}`)
	}
	for (const f of untagged) {
		const nilable = isNilable(f.type)
		const guarded = nilable || f.triState
		const indent = guarded ? "\t\t" : "\t"
		if (f.triState) l.push(`\tif !p.${f.goName}.IsZero() {`)
		else if (nilable) l.push(`\tif p.${f.goName} != nil {`)
		l.push(`${indent}b, err := json.Marshal(p.${f.goName})`)
		l.push(`${indent}if err != nil {`)
		l.push(`${indent}\treturn nil, err`)
		l.push(`${indent}}`)
		l.push(`${indent}out[${goString(f.key)}] = b`)
		if (guarded) l.push(`\t}`)
	}
	l.push(`\treturn json.Marshal(out)`)
	l.push(`}`)
	return l.join("\n")
}

function discriminatorValues(
	variant: IRSchema,
	propertyName: string,
	mapping: Record<string, string> | undefined,
	names: GoTypeNames,
): string[] {
	if (variant.kind === "ref") {
		const mapped = mapping
			? Object.entries(mapping)
					.filter(([, target]) => target === variant.name)
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
export function irRenderTopLevel(
	name: string,
	ir: IRSchema,
	decls: Map<string, string>,
	raw?: Record<string, unknown>,
	names?: GoTypeNames,
): string {
	const n = names ?? DEFAULT_NAMES
	/* the schema name is already a Go identifier when the caller passes `names` */
	const typeName = names ? name : goPascal(name)
	const circularRefs = new Set([typeName])
	const useCtx = (fieldName: string): RenderUseCtx => ({
		circularRefs,
		decls,
		fieldName,
		names,
		parentName: typeName,
	})

	if (ir.kind === "scalar" && ir.enum) {
		if (ir.type === "string") return renderHoistedStringEnum(typeName, ir.enum as unknown[], n)
		if (ir.type === "integer") return renderHoistedIntEnum(typeName, ir.enum as unknown[], n)
	}

	if (ir.kind === "const") {
		const rawType = ir.type ?? (raw?.type as string | undefined)
		const base = rawType ? (primitiveFor(rawType) ?? "string") : constBaseType(ir.value)
		const val = typeof ir.value === "string" ? goString(ir.value) : String(ir.value)
		return [`type ${typeName} ${base}`, `const ${n.claimConst(`${typeName}Value`)} ${typeName} = ${val}`].join("\n")
	}

	if (ir.kind === "allOf") {
		const embeds: string[] = []
		const fields: StructField[] = []
		const scope = new NameScope(["UnmarshalJSON", "MarshalJSON"])
		for (const part of ir.parts) {
			if (part.kind === "ref") {
				const embedded = n.ref(part.name)
				scope.reserve(embedded)
				embeds.push(n.cyclic.has(part.name) ? `*${embedded}` : embedded)
			}
		}
		for (const part of ir.parts) {
			const obj = part.kind === "object" ? part : undefined
			if (!obj) continue
			for (const field of sortFields(obj.fields)) {
				if (fields.some((f) => f.key === field.name)) continue
				fields.push({
					goName: scope.claim(goPascal(field.name)),
					key: field.name,
					required: field.required,
					tagged: goJsonTagNameValid(field.name),
					triState: isTriState(field),
					type: structFieldType(field, (schema) => irRenderUse(schema, useCtx(field.name))),
				})
			}
		}
		return renderStruct(typeName, embeds, fields, undefined)
	}

	if (ir.kind === "union" && ir.discriminator) {
		const prop = ir.discriminator.propertyName
		const scope = new NameScope(["Raw", "UnmarshalJSON", "MarshalJSON"])
		const variants: Array<{ field: string; type: string; values: string[] }> = []
		ir.variants.forEach((v, i) => {
			const values = discriminatorValues(v, prop, ir.discriminator?.mapping, n)
			let type: string
			if (v.kind === "ref") {
				type = n.ref(v.name)
			} else if (v.kind === "object") {
				const hoisted = n.hoist(`${typeName}.variant${i}`, `${typeName}${goPascal(values[0] ?? `Variant${i}`)}`)
				if (!decls.has(hoisted)) {
					decls.set(hoisted, "")
					decls.set(hoisted, irRenderTopLevel(hoisted, v, decls, undefined, names))
				}
				type = hoisted
			} else {
				return
			}
			variants.push({ field: scope.claim(goPascal(values[0] ?? type)), type, values })
		})
		const l: string[] = []
		l.push(`// ${typeName} holds exactly one variant, selected by the ${goString(prop)} property.`)
		l.push(`type ${typeName} struct {`)
		for (const v of variants) l.push(`\t${v.field} *${v.type}`)
		l.push(`\t// Raw keeps a payload whose discriminator matches no known variant.`)
		l.push(`\tRaw json.RawMessage`)
		l.push(`}`)
		l.push(``)
		l.push(`func (u *${typeName}) UnmarshalJSON(data []byte) error {`)
		l.push(`\tvar probe map[string]json.RawMessage`)
		l.push(`\tif err := json.Unmarshal(data, &probe); err != nil {`)
		l.push(`\t\treturn err`)
		l.push(`\t}`)
		l.push(`\tvar tag string`)
		l.push(`\tif v, ok := probe[${goString(prop)}]; ok {`)
		l.push(`\t\t_ = json.Unmarshal(v, &tag)`)
		l.push(`\t}`)
		l.push(`\t*u = ${typeName}{}`)
		l.push(`\tswitch tag {`)
		for (const v of variants) {
			if (v.values.length === 0) continue
			l.push(`\tcase ${v.values.map(goString).join(", ")}:`)
			l.push(`\t\tu.${v.field} = new(${v.type})`)
			l.push(`\t\treturn json.Unmarshal(data, u.${v.field})`)
		}
		l.push(`\t}`)
		l.push(`\tu.Raw = append(json.RawMessage(nil), data...)`)
		l.push(`\treturn nil`)
		l.push(`}`)
		l.push(``)
		l.push(`func (u ${typeName}) MarshalJSON() ([]byte, error) {`)
		for (const v of variants) {
			l.push(`\tif u.${v.field} != nil {`)
			l.push(`\t\treturn json.Marshal(u.${v.field})`)
			l.push(`\t}`)
		}
		l.push(`\tif u.Raw != nil {`)
		l.push(`\t\treturn u.Raw, nil`)
		l.push(`\t}`)
		l.push(`\treturn []byte("null"), nil`)
		l.push(`}`)
		return l.join("\n")
	}

	if (ir.kind === "object") {
		const { fields, additional } = ir

		if (fields.length === 0 && additional) {
			const valType = irRenderUse(additional, useCtx("Value"))
			return `type ${typeName} map[string]${valType}`
		}

		if (fields.length === 0) {
			if (additional === false) return `type ${typeName} struct{}`
			return `type ${typeName} map[string]interface{}`
		}

		const scope = new NameScope(["UnmarshalJSON", "MarshalJSON"])
		const extraName = additional ? scope.claim("Extra") : ""
		const out: StructField[] = []
		for (const field of sortFields(fields)) {
			let finalType: string
			if (isTriState(field)) {
				finalType = structFieldType(field, (schema) => irRenderUse(schema, useCtx(field.name)))
			} else {
				const ft = irRenderUse(field.schema, useCtx(field.name))
				finalType = fieldType(ft, field.required)
				/* self-ref → pointer (circular) */
				if (circularRefs.has(ft.replace(/^\*/, "")) && !finalType.startsWith("*")) finalType = `*${ft}`
			}
			out.push({
				goName: scope.claim(goPascal(field.name)),
				key: field.name,
				required: field.required,
				tagged: goJsonTagNameValid(field.name),
				triState: isTriState(field),
				type: finalType,
			})
		}
		const extra = additional ? { goName: extraName, valueType: irRenderUse(additional, useCtx("Extra")) } : undefined
		return renderStruct(typeName, [], out, extra)
	}

	const aliased = irRenderUse(ir, useCtx("Value"))
	return `type ${typeName} = ${aliased}`
}

export function renderUse(schema: Record<string, unknown> | undefined, ctx: RenderUseCtx): string {
	return irRenderUse(schemaToIR(schema), ctx, ctx.depth ?? 0)
}

export function renderTopLevel(name: string, schema: Record<string, unknown>, decls: Map<string, string>): string {
	return irRenderTopLevel(name, schemaToIR(schema), decls, schema)
}
