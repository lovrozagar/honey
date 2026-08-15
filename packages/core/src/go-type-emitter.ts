import { schemaToIR } from "./codegen-ir.ts"
import type { IRSchema } from "./codegen-ir.ts"

export const GO_KEYWORDS = new Set([
	"break", "case", "chan", "const", "continue", "default", "defer",
	"else", "fallthrough", "for", "func", "go", "goto", "if", "import",
	"interface", "map", "package", "range", "return", "select", "struct",
	"switch", "type", "var",
])

/** Converts a string to PascalCase from kebab-case, snake_case, dotted, or camelCase. */
export function goPascal(name: string): string {
	return name
		.replace(/[-_.](.)/g, (_, c: string) => c.toUpperCase())
		.replace(/^(.)/, (_, c: string) => c.toUpperCase())
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

export function goTag(jsonKey: string, omitempty: boolean): string {
	return omitempty ? `\`json:"${jsonKey},omitempty"\`` : `\`json:"${jsonKey}"\``
}

export type RenderUseCtx = {
	parentName: string
	fieldName: string
	decls: Map<string, string>
	circularRefs?: Set<string>
	depth?: number
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

function renderHoistedStringEnum(typeName: string, enumVals: unknown[]): string {
	const l: string[] = []
	l.push(`type ${typeName} string`)
	l.push(`const (`)
	for (const v of enumVals) {
		const label = typeof v === "string" ? goPascal(v) : String(v)
		const val = typeof v === "string" ? JSON.stringify(v) : String(v)
		l.push(`\t${typeName}${label} ${typeName} = ${val}`)
	}
	l.push(`)`)
	return l.join("\n")
}

function renderHoistedIntEnum(typeName: string, enumVals: unknown[]): string {
	const l: string[] = []
	l.push(`type ${typeName} int`)
	l.push(`const (`)
	for (const v of enumVals) {
		l.push(`\t${typeName}${String(v)} ${typeName} = ${String(v)}`)
	}
	l.push(`)`)
	return l.join("\n")
}

function primitiveFor(t: string | undefined): string | null {
	switch (t) {
		case "string": return "string"
		case "integer": return "int64"
		case "number": return "float64"
		case "boolean": return "bool"
		default: return null
	}
}

function constBaseType(val: unknown): string {
	if (typeof val === "boolean") return "bool"
	if (typeof val === "number") return Number.isInteger(val) ? "int64" : "float64"
	return "string"
}

/** Mutates `ctx.decls` when hoisting enums. */
export function irRenderUse(ir: IRSchema, ctx: RenderUseCtx, depth = 0): string {
	if (depth > 12) return "json.RawMessage"

	switch (ir.kind) {
		case "ref": {
			const goName = goPascal(ir.name)
			if (ctx.circularRefs?.has(goName)) return `*${goName}`
			return goName
		}

		case "allOf": {
			const firstRef = ir.parts.find((p) => p.kind === "ref")
			if (firstRef && firstRef.kind === "ref") return goPascal(firstRef.name)
			return "json.RawMessage"
		}

		case "nullable": {
			const innerStr = irRenderUse(ir.inner, ctx, depth + 1)
			/* already-nilable forms need no pointer prefix */
			if (
				innerStr === "json.RawMessage" ||
				innerStr.startsWith("*") ||
				innerStr.startsWith("[]") ||
				innerStr.startsWith("map[")
			) return innerStr
			return `*${innerStr}`
		}

		case "union": {
			/* union at use-position → always json.RawMessage (Go has no native union type) */
			return "json.RawMessage"
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
			return "json.RawMessage"
		}

		case "const": {
			return constBaseType(ir.value)
		}

		case "array": {
			const el = irRenderUse(ir.items, ctx, depth + 1)
			return `[]${el}`
		}

		case "tuple": {
			return `[${ir.items.length}]interface{}`
		}

		case "object": {
			const { fields, additional } = ir

			if (fields.length === 0) {
				if (additional && additional !== false) {
					const valType = irRenderUse(additional, ctx, depth + 1)
					return `map[string]${valType}`
				}
				if (additional === false) return "struct{}"
				return "map[string]interface{}"
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

function irRenderAnonStruct(
	ir: Extract<IRSchema, { kind: "object" }>,
	ctx: RenderUseCtx,
	depth: number,
): string {
	const sorted = ir.fields.slice().sort((a, b) => a.name.localeCompare(b.name))
	const lines: string[] = []
	lines.push(`struct {`)
	for (const field of sorted) {
		const fieldGoName = goPascal(field.name)
		const childParent = `${ctx.parentName}${goPascal(ctx.fieldName)}`
		const childCtx: RenderUseCtx = {
			circularRefs: ctx.circularRefs,
			decls: ctx.decls,
			depth: depth + 1,
			fieldName: field.name,
			parentName: childParent,
		}
		const fieldType = irRenderUse(field.schema, childCtx, depth + 1)
		const alreadyNilable =
			fieldType.startsWith("*") ||
			fieldType.startsWith("[]") ||
			fieldType.startsWith("map[")
		const finalType = !field.required && !alreadyNilable ? `*${fieldType}` : fieldType
		const tag = goTag(field.name, !field.required)
		lines.push(`\t${fieldGoName} ${finalType} ${tag}`)
	}
	lines.push(`}`)
	return lines.join("\n")
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
): string {
	const typeName = goPascal(name)
	const circularRefs = new Set([typeName])

	if (ir.kind === "scalar" && ir.enum) {
		if (ir.type === "string") {
			return renderHoistedStringEnum(typeName, ir.enum as unknown[])
		}
		return renderHoistedIntEnum(typeName, ir.enum as unknown[])
	}

	if (ir.kind === "const") {
		const rawType = raw?.type as string | undefined
		const base = rawType ? (primitiveFor(rawType) ?? "string") : constBaseType(ir.value)
		const val = typeof ir.value === "string" ? JSON.stringify(ir.value) : String(ir.value)
		return [
			`type ${typeName} ${base}`,
			`const ${typeName}Value ${typeName} = ${val}`,
		].join("\n")
	}

	if (ir.kind === "allOf") {
		const l: string[] = []
		l.push(`type ${typeName} struct {`)
		for (const part of ir.parts) {
			if (part.kind === "ref") {
				l.push(`\t${goPascal(part.name)}`)
				continue
			}
			if (part.kind !== "object") continue
			const sorted = part.fields.slice().sort((a, b) => a.name.localeCompare(b.name))
			for (const field of sorted) {
				const fieldGoName = goPascal(field.name)
				const ft = irRenderUse(field.schema, {
					circularRefs,
					decls,
					fieldName: field.name,
					parentName: typeName,
				})
				const alreadyNilable =
					ft.startsWith("*") || ft.startsWith("[]") || ft.startsWith("map[")
				const finalType = !field.required && !alreadyNilable ? `*${ft}` : ft
				l.push(`\t${fieldGoName} ${finalType} ${goTag(field.name, !field.required)}`)
			}
		}
		l.push(`}`)
		return l.join("\n")
	}

	if (ir.kind === "union" && ir.discriminator) {
		const discProp = ir.discriminator.propertyName
		return [
			`type ${typeName} struct {`,
			`\tType string ${goTag(discProp, false)}`,
			`\tPayload json.RawMessage ${goTag("payload", false)}`,
			`}`,
		].join("\n")
	}

	if (ir.kind === "object") {
		const { fields, additional } = ir

		if (fields.length === 0 && additional && additional !== false) {
			const valType = irRenderUse(additional, {
				circularRefs,
				decls,
				fieldName: "Value",
				parentName: typeName,
			})
			return `type ${typeName} map[string]${valType}`
		}

		if (fields.length === 0) {
			if (additional === false) return `type ${typeName} struct{}`
			return `type ${typeName} map[string]interface{}`
		}

		const sorted = fields.slice().sort((a, b) => a.name.localeCompare(b.name))
		const l: string[] = []
		l.push(`type ${typeName} struct {`)
		for (const field of sorted) {
			const fieldGoName = goPascal(field.name)
			const ft = irRenderUse(field.schema, {
				circularRefs,
				decls,
				fieldName: field.name,
				parentName: typeName,
			})
			const alreadyNilable =
				ft.startsWith("*") || ft.startsWith("[]") || ft.startsWith("map[")
			let finalType = !field.required && !alreadyNilable ? `*${ft}` : ft
			/* self-ref → pointer (circular) */
			if (circularRefs.has(ft.replace(/^\*/, "")) && !finalType.startsWith("*")) {
				finalType = `*${ft}`
			}
			l.push(`\t${fieldGoName} ${finalType} ${goTag(field.name, !field.required)}`)
		}

		if (additional && additional !== false) {
			const valType = irRenderUse(additional, {
				circularRefs,
				decls,
				fieldName: "Extra",
				parentName: typeName,
			})
			l.push(`\tExtra map[string]${valType} \`json:"-"\``)
			l.push(`}`)
			l.push(``)
			l.push(`func (s *${typeName}) UnmarshalJSON(data []byte) error {`)
			l.push(`\ttype plain ${typeName}`)
			l.push(`\tvar base plain`)
			l.push(`\tif err := json.Unmarshal(data, &base); err != nil {`)
			l.push(`\t\treturn err`)
			l.push(`\t}`)
			l.push(`\t*s = ${typeName}(base)`)
			l.push(`\treturn nil`)
			l.push(`}`)
			l.push(``)
			l.push(`func (s ${typeName}) MarshalJSON() ([]byte, error) {`)
			l.push(`\ttype plain ${typeName}`)
			l.push(`\treturn json.Marshal(plain(s))`)
			l.push(`}`)
			return l.join("\n")
		}

		l.push(`}`)
		return l.join("\n")
	}

	const aliased = irRenderUse(ir, {
		circularRefs,
		decls,
		fieldName: "Value",
		parentName: typeName,
	})
	return `type ${typeName} = ${aliased}`
}

export function renderUse(
	schema: Record<string, unknown> | undefined,
	ctx: RenderUseCtx,
): string {
	return irRenderUse(schemaToIR(schema), ctx, ctx.depth ?? 0)
}

export function renderTopLevel(
	name: string,
	schema: Record<string, unknown>,
	decls: Map<string, string>,
): string {
	return irRenderTopLevel(name, schemaToIR(schema), decls, schema)
}

