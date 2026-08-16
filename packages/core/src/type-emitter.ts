import type { StandardSchemaLike } from "./types.ts"

const SAFE_KEY_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/
const LAZY_ALIAS_CAP = 64

function quoteKey(key: string): string {
	return SAFE_KEY_RE.test(key) ? key : `"${key}"`
}

/** Wrap element type in parens when it contains union/intersection before appending [] */
function arrayOf(el: string): string {
	return el.includes("|") || el.includes("&") ? `(${el})[]` : `${el}[]`
}

/**
 * Collects named aliases for recursive `z.lazy` schemas so `generateTypes`
 * can hoist `type _LazyN = …` before `Routes`.
 */
export type TypeEmitState = {
	aliases: Map<string, string>
	lazyNames: WeakMap<object, string>
	nextId: number
	reserved: Set<string>
}

export function createTypeEmitState(): TypeEmitState {
	return {
		aliases: new Map(),
		lazyNames: new WeakMap(),
		nextId: 0,
		reserved: new Set(),
	}
}

/**
 * Emit a TypeScript type string from a Standard Schema compatible schema.
 * Supports Zod (+ mini), Valibot, ArkType, Yup, and Effect.
 * Unknown vendors return "unknown".
 *
 * Pass a shared `TypeEmitState` from `generateTypes` so recursive lazy
 * aliases are hoisted once and reused across routes.
 */
export function emitSchemaType(schema: StandardSchemaLike, state?: TypeEmitState): string {
	const vendor = schema["~standard"].vendor
	if (vendor === "zod") return emitZod(schema, state ?? createTypeEmitState())
	if (vendor === "valibot") return emitValibot(schema)
	if (vendor === "arktype") return emitArkType(schema)
	if (vendor === "yup") return emitYup(schema)
	if (vendor === "effect") return emitEffect(schema)
	return "unknown"
}

/* ---- Zod emitter (handles both full zod and zod/mini) ---- */

/** Unwrap nullable/default/catch wrappers to detect if optional is nested inside */
function zodIsOptional(def: Record<string, unknown>): boolean {
	const t = (def.typeName as string) ?? (def.type as string)
	if (t === "ZodOptional" || t === "optional") return true
	if (
		t === "ZodNullable" ||
		t === "nullable" ||
		t === "ZodDefault" ||
		t === "default" ||
		t === "ZodCatch" ||
		t === "catch"
	) {
		const inner = def.innerType as unknown
		if (inner) return zodIsOptional(zodDef(inner))
	}
	return false
}

function zodDef(schema: unknown): Record<string, unknown> {
	const s = schema as Record<string, unknown>
	return (s._def ?? s.def) as Record<string, unknown>
}

/** `.meta({ tsType })` is a vendor-agnostic override; emit it verbatim. */
function zodTsTypeMeta(schema: unknown): string | undefined {
	const s = schema as { meta?: () => unknown }
	if (typeof s.meta !== "function") return undefined
	let bag: unknown
	try {
		bag = s.meta()
	} catch {
		return undefined
	}
	if (!bag || typeof bag !== "object") return undefined
	const tsType = (bag as { tsType?: unknown }).tsType
	return typeof tsType === "string" && tsType.length > 0 ? tsType : undefined
}

function resolveLazyInner(def: Record<string, unknown>, schema: unknown): unknown {
	if (typeof def.getter === "function") {
		try {
			return (def.getter as () => unknown)()
		} catch {
			return undefined
		}
	}
	const s = schema as { unwrap?: () => unknown; _zod?: { innerType?: unknown } }
	if (typeof s.unwrap === "function") {
		try {
			return s.unwrap()
		} catch {
			return undefined
		}
	}
	if (s._zod && "innerType" in s._zod) return s._zod.innerType
	return undefined
}

function typeRefersTo(body: string, name: string): boolean {
	return new RegExp(`(?:^|[^A-Za-z0-9_$])${name}(?:[^A-Za-z0-9_$]|$)`).test(body)
}

function emitZodRecord(keyType: string, valueType: string, state: TypeEmitState): string {
	/* Partial<Record> adds `| undefined` and is not assignable to a recursive `Record<string, T>`. */
	if (typeRefersToReserved(valueType, state)) {
		return `Record<${keyType}, ${valueType}>`
	}
	return `Partial<Record<${keyType}, ${valueType}>>`
}

function typeRefersToReserved(typeStr: string, state: TypeEmitState): boolean {
	for (const name of state.reserved) {
		if (typeRefersTo(typeStr, name)) return true
	}
	return false
}

function emitZod(schema: unknown, state: TypeEmitState): string {
	const stamped = zodTsTypeMeta(schema)
	if (stamped) return stamped

	const def = zodDef(schema)
	if (!def) return "unknown"
	const typeName = (def.typeName ?? def.type) as string

	switch (typeName) {
		case "ZodString":
		case "string":
			return "string"
		case "ZodNumber":
		case "number":
			return "number"
		case "ZodBoolean":
		case "boolean":
			return "boolean"
		case "ZodBigInt":
		case "bigint":
			return "bigint"
		case "ZodDate":
		case "date":
			return "Date"
		case "ZodUndefined":
		case "undefined":
			return "undefined"
		case "ZodNull":
		case "null":
			return "null"
		case "ZodVoid":
		case "void":
			return "void"
		case "ZodAny":
		case "ZodUnknown":
		case "any":
		case "unknown":
			return "unknown"
		case "ZodNever":
		case "never":
			return "never"
		case "ZodLiteral":
		case "literal": {
			/* v4: single value, v3: values array */
			const val = def.value as unknown
			if (val !== undefined) return typeof val === "string" ? `"${val}"` : String(val)
			const values = def.values as unknown[]
			if (values.length === 1) {
				const v0 = values[0]
				return typeof v0 === "string" ? `"${v0}"` : String(v0)
			}
			return values.map((v0) => (typeof v0 === "string" ? `"${v0}"` : String(v0))).join(" | ")
		}
		case "ZodEnum":
		case "enum": {
			/* v4: values array, v3/mini: entries record */
			const vals = (def.values ?? def.entries) as unknown
			if (Array.isArray(vals)) return vals.map((v0) => `"${v0}"`).join(" | ")
			return Object.values(vals as Record<string, string>)
				.map((v0) => `"${v0}"`)
				.join(" | ")
		}
		case "ZodObject":
		case "object": {
			const rawShape = def.shape as Record<string, unknown> | (() => Record<string, unknown>)
			const shape = typeof rawShape === "function" ? rawShape() : rawShape
			const keys = Object.keys(shape)
			if (keys.length === 0) return "{}"
			return `{ ${keys
				.map((k) => {
					const propDef = zodDef(shape[k])
					const isOpt = propDef && zodIsOptional(propDef)
					return `${quoteKey(k)}${isOpt ? "?" : ""}: ${emitZod(shape[k], state)}`
				})
				.join("; ")} }`
		}
		case "ZodArray":
			/* v4: _def.type is the element schema */
			return arrayOf(emitZod((def.type ?? def.element) as unknown, state))
		case "array":
			return arrayOf(emitZod(def.element as unknown, state))
		case "ZodOptional":
		case "optional":
			return `${emitZod(def.innerType as unknown, state)} | undefined`
		case "ZodNullable":
		case "nullable":
			return `${emitZod(def.innerType as unknown, state)} | null`
		case "ZodUnion":
		case "ZodDiscriminatedUnion":
		case "union":
			return (def.options as unknown[]).map((o) => emitZod(o, state)).join(" | ")
		case "ZodIntersection":
		case "intersection":
			return `${emitZod(def.left as unknown, state)} & ${emitZod(def.right as unknown, state)}`
		case "ZodRecord":
		case "record":
			return emitZodRecord(emitZod(def.keyType as unknown, state), emitZod(def.valueType as unknown, state), state)
		case "ZodTuple":
		case "tuple":
			return `[${(def.items as unknown[]).map((i) => emitZod(i, state)).join(", ")}]`
		case "ZodDefault":
		case "ZodCatch":
		case "default":
		case "catch":
			return emitZod(def.innerType as unknown, state)
		case "ZodReadonly":
		case "readonly":
			return `Readonly<${emitZod(def.innerType as unknown, state)}>`
		case "ZodPipeline":
		case "pipe":
			return emitZod(def.out as unknown, state)
		case "ZodBranded":
			return emitZod(def.type as unknown, state)
		case "ZodLazy":
		case "lazy":
			return emitZodLazy(schema, def, state)
		default:
			return "unknown"
	}
}

function emitZodLazy(schema: unknown, def: Record<string, unknown>, state: TypeEmitState): string {
	if (schema && typeof schema === "object") {
		const existing = state.lazyNames.get(schema)
		if (existing) return existing
	}

	const inner = resolveLazyInner(def, schema)
	if (inner === undefined || inner === schema) return "unknown"

	if (!schema || typeof schema !== "object") {
		return emitZod(inner, state)
	}

	if (state.nextId >= LAZY_ALIAS_CAP) return "unknown"

	const name = `_Lazy${state.nextId++}`
	state.lazyNames.set(schema, name)
	state.reserved.add(name)
	const body = emitZod(inner, state)
	if (!typeRefersTo(body, name)) {
		state.lazyNames.delete(schema)
		state.reserved.delete(name)
		return body
	}
	state.aliases.set(name, body)
	return name
}

/* ---- Valibot emitter ---- */

function emitValibot(schema: unknown): string {
	const s = schema as Record<string, unknown>
	const type = s.type as string | undefined
	if (!type) return "unknown"

	switch (type) {
		case "string":
			return "string"
		case "number":
			return "number"
		case "boolean":
			return "boolean"
		case "bigint":
			return "bigint"
		case "date":
			return "Date"
		case "undefined":
			return "undefined"
		case "null":
			return "null"
		case "void":
			return "void"
		case "any":
		case "unknown":
			return "unknown"
		case "never":
			return "never"
		case "literal": {
			const val = s.literal as unknown
			return typeof val === "string" ? `"${val}"` : String(val)
		}
		case "enum": {
			const enumObj = s.enum as Record<string, string>
			return Object.values(enumObj)
				.map((val) => `"${val}"`)
				.join(" | ")
		}
		case "picklist": {
			const options = s.options as unknown[]
			return options.map((val) => (typeof val === "string" ? `"${val}"` : String(val))).join(" | ")
		}
		case "object": {
			const entries = s.entries as Record<string, unknown>
			const keys = Object.keys(entries)
			if (keys.length === 0) return "{}"
			return `{ ${keys
				.map((k) => {
					const propType = (entries[k] as Record<string, unknown>).type as string | undefined
					const isOpt = propType === "optional" || propType === "nullish"
					return `${quoteKey(k)}${isOpt ? "?" : ""}: ${emitValibot(entries[k])}`
				})
				.join("; ")} }`
		}
		case "array":
			return arrayOf(emitValibot(s.item as unknown))
		case "optional":
			return `${emitValibot(s.wrapped as unknown)} | undefined`
		case "nullable":
			return `${emitValibot(s.wrapped as unknown)} | null`
		case "nullish":
			return `${emitValibot(s.wrapped as unknown)} | null | undefined`
		case "union":
			return (s.options as unknown[]).map((o) => emitValibot(o)).join(" | ")
		case "intersect":
			return (s.options as unknown[]).map((o) => emitValibot(o)).join(" & ")
		case "record":
			return `Record<${emitValibot(s.key as unknown)}, ${emitValibot(s.value as unknown)}>`
		case "tuple":
			return `[${(s.items as unknown[]).map((i) => emitValibot(i)).join(", ")}]`
		default:
			return "unknown"
	}
}

/* ---- ArkType emitter ---- */

function emitArkType(schema: unknown): string {
	const s = schema as Record<string, unknown>
	const json = s.json as unknown
	if (json === undefined || json === null) return "unknown"
	return emitArkJson(json)
}

type ArkEntry = { key: string; value: unknown }

function isBooleanUnion(node: unknown[]): boolean {
	if (node.length !== 2) return false
	const units = node.map((n) => {
		if (typeof n === "object" && n !== null && "unit" in n) {
			return (n as Record<string, unknown>).unit
		}
		return undefined
	})
	return (units[0] === false && units[1] === true) || (units[0] === true && units[1] === false)
}

function emitArkJson(node: unknown): string {
	if (typeof node === "string") return mapArkDomain(node)

	if (Array.isArray(node)) {
		if (node.length === 0) return "never"
		if (isBooleanUnion(node)) return "boolean"
		return node.map((n) => emitArkJson(n)).join(" | ")
	}

	const obj = node as Record<string, unknown>

	if ("unit" in obj) {
		const val = obj.unit
		if (val === null) return "null"
		/* arktype serializes undefined as the string "undefined" in JSON */
		if (val === "undefined") return "undefined"
		return typeof val === "string" ? `"${val}"` : String(val)
	}

	if ("sequence" in obj) {
		return arrayOf(emitArkJson(obj.sequence))
	}

	if ("proto" in obj) {
		return mapArkProto(obj.proto as string)
	}

	if ("domain" in obj) {
		const domain = obj.domain as string

		if (domain === "object") {
			const required = (obj.required as ArkEntry[] | undefined) ?? []
			const optional = (obj.optional as ArkEntry[] | undefined) ?? []
			if (required.length === 0 && optional.length === 0) return "{}"
			const parts: string[] = []
			for (const entry of required) {
				parts.push(`${quoteKey(String(entry.key))}: ${emitArkJson(entry.value)}`)
			}
			for (const entry of optional) {
				parts.push(`${quoteKey(String(entry.key))}?: ${emitArkJson(entry.value)}`)
			}
			return `{ ${parts.join("; ")} }`
		}

		return mapArkDomain(domain)
	}

	return "unknown"
}

function mapArkDomain(domain: string): string {
	switch (domain) {
		case "string":
			return "string"
		case "number":
		case "integer":
			return "number"
		case "boolean":
			return "boolean"
		case "bigint":
			return "bigint"
		case "symbol":
			return "symbol"
		case "undefined":
			return "undefined"
		case "null":
			return "null"
		case "object":
			return "object"
		default:
			return "unknown"
	}
}

function mapArkProto(proto: string): string {
	switch (proto) {
		case "Date":
			return "Date"
		case "Array":
			return "unknown[]"
		case "RegExp":
			return "RegExp"
		case "Map":
			return "Map<unknown, unknown>"
		case "Set":
			return "Set<unknown>"
		default:
			return "unknown"
	}
}

/* ---- Yup emitter ---- */

type YupDesc = {
	fields?: Record<string, YupDesc>
	innerType?: YupDesc | YupDesc[]
	nullable?: boolean
	oneOf?: unknown[]
	optional?: boolean
	type: string
}

function emitYup(schema: unknown): string {
	const s = schema as Record<string, unknown>
	if (typeof s.describe !== "function") return "unknown"
	const desc = s.describe() as YupDesc
	return emitYupDesc(desc)
}

function emitYupDesc(desc: YupDesc): string {
	let base = emitYupBase(desc)
	if (desc.nullable) base = `${base} | null`
	return base
}

function emitYupBase(desc: YupDesc): string {
	switch (desc.type) {
		case "string":
			return "string"
		case "number":
			return "number"
		case "boolean":
			return "boolean"
		case "date":
			return "Date"
		case "object": {
			if (!desc.fields) return "{}"
			const keys = Object.keys(desc.fields)
			if (keys.length === 0) return "{}"
			const parts = keys.map((k) => {
				const field = desc.fields?.[k]
				if (!field) return `${quoteKey(k)}: unknown`
				const opt = field.optional ? "?" : ""
				return `${quoteKey(k)}${opt}: ${emitYupDesc(field)}`
			})
			return `{ ${parts.join("; ")} }`
		}
		case "array": {
			if (!desc.innerType || Array.isArray(desc.innerType)) return "unknown[]"
			return arrayOf(emitYupDesc(desc.innerType))
		}
		case "tuple": {
			if (!Array.isArray(desc.innerType)) return "unknown"
			return `[${desc.innerType.map((i) => emitYupDesc(i)).join(", ")}]`
		}
		case "mixed": {
			if (desc.oneOf && desc.oneOf.length > 0) {
				return desc.oneOf.map((val) => (typeof val === "string" ? `"${val}"` : String(val))).join(" | ")
			}
			return "unknown"
		}
		case "lazy":
			return "unknown"
		default:
			return "unknown"
	}
}

/* ---- Effect Schema emitter ---- */

type EffectAST = {
	_tag: string
	elements?: Array<{ isOptional: boolean; type: EffectAST }>
	indexSignatures?: Array<{ parameter: EffectAST; type: EffectAST }>
	literal?: unknown
	propertySignatures?: Array<{
		isOptional: boolean
		name: string
		type: EffectAST
	}>
	rest?: Array<{ type: EffectAST }>
	types?: EffectAST[]
}

function emitEffect(schema: unknown): string {
	const s = schema as Record<string, unknown>
	const ast = s.ast as EffectAST | undefined
	if (!ast) return "unknown"
	return emitEffectAst(ast)
}

function emitEffectAst(ast: EffectAST): string {
	switch (ast._tag) {
		case "StringKeyword":
			return "string"
		case "NumberKeyword":
			return "number"
		case "BooleanKeyword":
			return "boolean"
		case "BigIntKeyword":
			return "bigint"
		case "SymbolKeyword":
			return "symbol"
		case "UndefinedKeyword":
			return "undefined"
		case "VoidKeyword":
			return "void"
		case "UnknownKeyword":
		case "AnyKeyword":
			return "unknown"
		case "NeverKeyword":
			return "never"
		case "ObjectKeyword":
			return "object"
		case "Literal": {
			const val = ast.literal
			if (val === null) return "null"
			return typeof val === "string" ? `"${val}"` : String(val)
		}
		case "Union":
			return (ast.types ?? []).map((t) => emitEffectAst(t)).join(" | ")
		case "TypeLiteral": {
			const props = ast.propertySignatures ?? []
			const idxSigs = ast.indexSignatures ?? []
			if (props.length === 0 && idxSigs.length === 0) return "{}"
			if (props.length === 0 && idxSigs.length === 1) {
				return `Record<${emitEffectAst(idxSigs[0].parameter)}, ${emitEffectAst(idxSigs[0].type)}>`
			}
			const parts = props.map((p) => {
				const opt = p.isOptional ? "?" : ""
				return `${quoteKey(p.name as string)}${opt}: ${emitEffectAst(p.type)}`
			})
			return `{ ${parts.join("; ")} }`
		}
		case "TupleType": {
			const elems = ast.elements ?? []
			const rest = ast.rest
			if (elems.length === 0 && rest && rest.length === 1) {
				return arrayOf(emitEffectAst(rest[0].type))
			}
			if (elems.length > 0 && (!rest || rest.length === 0)) {
				return `[${elems.map((e) => emitEffectAst(e.type)).join(", ")}]`
			}
			if (elems.length === 0) return "unknown[]"
			return `[${elems.map((e) => emitEffectAst(e.type)).join(", ")}]`
		}
		case "Declaration":
			return "unknown"
		case "Suspend":
			return "unknown"
		default:
			return "unknown"
	}
}
