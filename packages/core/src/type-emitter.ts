import type { StandardSchemaLike } from "./types.ts"

const SAFE_KEY_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/
const LAZY_ALIAS_CAP = 64

/** A property key in a type literal: bare when it is an identifier, a string literal otherwise. */
export function quoteKey(key: string): string {
	return SAFE_KEY_RE.test(key) ? key : JSON.stringify(key)
}

/** A TypeScript literal type for a runtime value; anything without one widens to its type. */
export function literalType(value: unknown): string {
	if (value === null) return "null"
	if (value === undefined) return "undefined"
	if (typeof value === "string") return JSON.stringify(value)
	if (typeof value === "boolean") return String(value)
	if (typeof value === "bigint") return `${value}n`
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "number"
	if (typeof value === "symbol") return "symbol"
	return "unknown"
}

/**
 * Does `type` contain `token` outside every bracket and string? `A | B` does; `{ a: A | B }`
 * and `Array<A | B>` do not. Used to parenthesize only where precedence needs it.
 */
function hasTopLevel(type: string, token: "|" | "&" | "=>"): boolean {
	let depth = 0
	let quote: string | null = null
	for (let i = 0; i < type.length; i++) {
		const c = type[i]
		if (quote !== null) {
			if (c === "\\") i++
			else if (c === quote) quote = null
			continue
		}
		if (c === '"' || c === "'" || c === "`") quote = c
		else if (c === "(" || c === "{" || c === "[" || c === "<") depth++
		else if (c === ")" || c === "}" || c === "]" || (c === ">" && type[i - 1] !== "=")) depth--
		else if (depth === 0 && type.startsWith(token, i)) return true
	}
	return false
}

/** Wrap element type in parens when union, intersection or function binds looser than `[]` */
export function arrayOf(el: string): string {
	return hasTopLevel(el, "|") || hasTopLevel(el, "&") || hasTopLevel(el, "=>") ? `(${el})[]` : `${el}[]`
}

export function unionOf(parts: string[]): string {
	const unique = [...new Set(parts)]
	if (unique.length === 0) return "never"
	return unique.map((p) => (hasTopLevel(p, "=>") ? `(${p})` : p)).join(" | ")
}

/** `(A | B) & C`, never `A | B & C` — `&` binds tighter than `|`. */
export function intersectionOf(parts: string[]): string {
	return parts.map((p) => (hasTopLevel(p, "|") || hasTopLevel(p, "=>") ? `(${p})` : p)).join(" & ")
}

/**
 * Collects named aliases for recursive schemas — `z.lazy`, and Zod 4 getter recursion
 * (`get children() { return z.array(Node) }`) — so `generateTypes` can hoist `type _LazyN = …`
 * before `Routes`.
 */
export type TypeEmitState = {
	aliases: Map<string, string>
	/** Schemas being emitted right now; re-entering one is recursion and gets a name */
	inProgress: Map<object, { name: string | null }>
	lazyNames: WeakMap<object, string>
	nextId: number
	reserved: Set<string>
}

export function createTypeEmitState(): TypeEmitState {
	return {
		aliases: new Map(),
		inProgress: new Map(),
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
	if (vendor === "valibot") return emitValibot(schema, 0)
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
		t === "catch" ||
		t === "ZodReadonly" ||
		t === "readonly"
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

/** Values of a TS enum object, without the reverse mappings numeric enums carry (`{ A: 0, "0": "A" }`). */
function enumValues(entries: Record<string, unknown>): unknown[] {
	return Object.keys(entries)
		.filter((k) => typeof entries[entries[k] as string] !== "number")
		.map((k) => entries[k])
}

/**
 * Recursion guard for schemas that refer to themselves without `z.lazy` (Zod 4 getters). The
 * first visit emits the body; a visit while the body is still being emitted names the schema,
 * and the finished body becomes that alias.
 */
function emitZod(schema: unknown, state: TypeEmitState): string {
	if (schema === null || typeof schema !== "object") return emitZodNode(schema, state)
	/* a z.lazy names itself before emitting its body */
	const known = state.lazyNames.get(schema)
	if (known !== undefined) return known
	const active = state.inProgress.get(schema)
	if (active !== undefined) {
		if (active.name === null) {
			if (state.nextId >= LAZY_ALIAS_CAP) return "unknown"
			active.name = `_Lazy${state.nextId++}`
			state.reserved.add(active.name)
		}
		return active.name
	}
	const entry: { name: string | null } = { name: null }
	state.inProgress.set(schema, entry)
	try {
		const body = emitZodNode(schema, state)
		if (entry.name === null) return body
		state.aliases.set(entry.name, body)
		state.lazyNames.set(schema, entry.name)
		return entry.name
	} finally {
		state.inProgress.delete(schema)
	}
}

function emitZodNode(schema: unknown, state: TypeEmitState): string {
	const stamped = zodTsTypeMeta(schema)
	if (stamped) return stamped

	const def = zodDef(schema)
	if (!def) return "unknown"
	const typeName = (def.typeName ?? def.type) as string

	switch (typeName) {
		case "ZodString":
		case "string":
		case "template_literal":
			return "string"
		case "ZodNumber":
		case "number":
		case "nan":
			return "number"
		case "ZodBoolean":
		case "boolean":
		case "success":
			return "boolean"
		case "ZodBigInt":
		case "bigint":
			return "bigint"
		case "ZodSymbol":
		case "symbol":
			return "symbol"
		case "ZodDate":
		case "date":
			return "Date"
		case "file":
			return "File"
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
		case "custom":
			return "unknown"
		case "ZodNever":
		case "never":
			return "never"
		case "ZodLiteral":
		case "literal": {
			/* v4: values array, v3: single value */
			const values = Array.isArray(def.values) ? (def.values as unknown[]) : [def.value]
			return unionOf(values.map(literalType))
		}
		case "ZodEnum":
		case "enum": {
			/* v4: entries record, v3: values array */
			const vals = (def.values ?? def.entries) as unknown
			const list = Array.isArray(vals) ? vals : enumValues(vals as Record<string, unknown>)
			return unionOf(list.map(literalType))
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
		case "ZodSet":
		case "set":
			return `Set<${emitZod(def.valueType as unknown, state)}>`
		case "ZodMap":
		case "map":
			return `Map<${emitZod(def.keyType as unknown, state)}, ${emitZod(def.valueType as unknown, state)}>`
		case "ZodPromise":
		case "promise":
			return `Promise<${emitZod(def.innerType as unknown, state)}>`
		case "ZodFunction":
		case "function":
			return "(...args: never[]) => unknown"
		case "ZodOptional":
		case "optional":
			return unionOf([emitZod(def.innerType as unknown, state), "undefined"])
		case "nonoptional":
			return `Exclude<${emitZod(def.innerType as unknown, state)}, undefined>`
		case "ZodNullable":
		case "nullable":
			return unionOf([emitZod(def.innerType as unknown, state), "null"])
		case "ZodUnion":
		case "ZodDiscriminatedUnion":
		case "union":
			return unionOf((def.options as unknown[]).map((o) => emitZod(o, state)))
		case "ZodIntersection":
		case "intersection":
			return intersectionOf([emitZod(def.left as unknown, state), emitZod(def.right as unknown, state)])
		case "ZodRecord":
		case "record":
			return emitZodRecord(emitZod(def.keyType as unknown, state), emitZod(def.valueType as unknown, state), state)
		case "ZodTuple":
		case "tuple": {
			const items = (def.items as unknown[]).map((i) => emitZod(i, state))
			if (def.rest) items.push(`...${arrayOf(emitZod(def.rest as unknown, state))}`)
			return `[${items.join(", ")}]`
		}
		case "ZodDefault":
		case "ZodCatch":
		case "default":
		case "prefault":
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
			/* a transform's output is whatever the function returns — the schema cannot say */
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

const VALIBOT_OPTIONAL = new Set(["exact_optional", "nullish", "optional", "undefinedable"])
/** Lazy schemas can recurse without end; past this depth a node is `unknown`. */
const VALIBOT_MAX_DEPTH = 32

function emitValibot(schema: unknown, depth: number): string {
	if (depth > VALIBOT_MAX_DEPTH) return "unknown"
	const s = schema as Record<string, unknown>
	const type = s.type as string | undefined
	if (!type) return "unknown"
	const walk = (child: unknown): string => emitValibot(child, depth + 1)

	switch (type) {
		case "string":
			return "string"
		case "number":
		case "nan":
			return "number"
		case "boolean":
			return "boolean"
		case "bigint":
			return "bigint"
		case "symbol":
			return "symbol"
		case "date":
			return "Date"
		case "file":
			return "File"
		case "blob":
			return "Blob"
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
		case "literal":
			return literalType(s.literal)
		case "enum":
			return unionOf(enumValues(s.enum as Record<string, unknown>).map(literalType))
		case "picklist":
			return unionOf((s.options as unknown[]).map(literalType))
		case "object":
		case "strict_object":
		case "loose_object":
		case "object_with_rest": {
			const entries = s.entries as Record<string, unknown>
			const keys = Object.keys(entries)
			const fields = keys.map((k) => {
				const propType = (entries[k] as Record<string, unknown>).type as string | undefined
				const isOpt = propType !== undefined && VALIBOT_OPTIONAL.has(propType)
				return `${quoteKey(k)}${isOpt ? "?" : ""}: ${walk(entries[k])}`
			})
			if (type === "loose_object") fields.push("[key: string]: unknown")
			if (type === "object_with_rest") fields.push(`[key: string]: ${unionOf([walk(s.rest), "unknown"])}`)
			if (fields.length === 0) return "{}"
			return `{ ${fields.join("; ")} }`
		}
		case "array":
			return arrayOf(walk(s.item))
		case "set":
			return `Set<${walk(s.value)}>`
		case "map":
			return `Map<${walk(s.key)}, ${walk(s.value)}>`
		case "optional":
		case "exact_optional":
		case "undefinedable":
			return unionOf([walk(s.wrapped), "undefined"])
		case "nullable":
			return unionOf([walk(s.wrapped), "null"])
		case "nullish":
			return unionOf([walk(s.wrapped), "null", "undefined"])
		case "non_optional":
			return `Exclude<${walk(s.wrapped)}, undefined>`
		case "non_nullable":
			return `Exclude<${walk(s.wrapped)}, null>`
		case "non_nullish":
			return `NonNullable<${walk(s.wrapped)}>`
		case "union":
		case "variant":
			return unionOf((s.options as unknown[]).map(walk))
		case "intersect":
			return intersectionOf((s.options as unknown[]).map(walk))
		case "record":
			return `Record<${walk(s.key)}, ${walk(s.value)}>`
		case "tuple":
		case "strict_tuple":
		case "loose_tuple":
		case "tuple_with_rest": {
			const items = (s.items as unknown[]).map(walk)
			if (type === "tuple_with_rest") items.push(`...${arrayOf(walk(s.rest))}`)
			if (type === "loose_tuple") items.push("...unknown[]")
			return `[${items.join(", ")}]`
		}
		case "lazy": {
			const getter = s.getter as ((input: unknown) => unknown) | undefined
			return typeof getter === "function" ? walk(getter(undefined)) : "unknown"
		}
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
		return unionOf(node.map((n) => emitArkJson(n)))
	}

	const obj = node as Record<string, unknown>

	if ("unit" in obj) {
		const val = obj.unit
		/* arktype serializes undefined as the string "undefined" in JSON */
		if (val === "undefined") return "undefined"
		return literalType(val)
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
	const base = emitYupBase(desc)
	return desc.nullable ? unionOf([base, "null"]) : base
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
			if (desc.oneOf && desc.oneOf.length > 0) return unionOf(desc.oneOf.map(literalType))
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
		name: string | symbol
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
		case "Literal":
			return literalType(ast.literal)
		case "Union":
			return unionOf((ast.types ?? []).map((t) => emitEffectAst(t)))
		case "TypeLiteral": {
			const props = ast.propertySignatures ?? []
			const idxSigs = ast.indexSignatures ?? []
			if (props.length === 0 && idxSigs.length === 0) return "{}"
			if (props.length === 0 && idxSigs.length === 1) {
				return `Record<${emitEffectAst(idxSigs[0].parameter)}, ${emitEffectAst(idxSigs[0].type)}>`
			}
			const parts = props
				.filter((p) => typeof p.name === "string")
				.map((p) => {
					const opt = p.isOptional ? "?" : ""
					return `${quoteKey(p.name as string)}${opt}: ${emitEffectAst(p.type)}`
				})
			return `{ ${parts.join("; ")} }`
		}
		case "TupleType": {
			const elems = ast.elements ?? []
			const rest = ast.rest ?? []
			const items = elems.map((e) => `${emitEffectAst(e.type)}${e.isOptional ? "?" : ""}`)
			if (rest.length > 0) {
				if (items.length === 0 && rest.length === 1) return arrayOf(emitEffectAst(rest[0].type))
				items.push(`...${arrayOf(emitEffectAst(rest[0].type))}`)
				for (const tail of rest.slice(1)) items.push(emitEffectAst(tail.type))
			}
			return `[${items.join(", ")}]`
		}
		case "Declaration":
			return "unknown"
		case "Suspend":
			return "unknown"
		default:
			return "unknown"
	}
}
