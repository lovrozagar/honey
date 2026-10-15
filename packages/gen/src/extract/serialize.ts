/**
 * TypeScript types → type source text.
 *
 * A named type whose module exports it becomes an `import("…").Name<Args>` reference, a global one
 * its global name; everything else is written structurally. The structural writer keeps what a
 * reader relies on: optional and rest parameters, generic signatures, tuple rest and optional
 * elements, literal types, quoted keys and precedence (`(() => void)[]`, `(A | B) & C`). A type it
 * is still writing when it meets it again is written as `unknown` there, never expanded without end.
 */
import type { ts } from "ts-morph"
import { quoteKey } from "../emit/shared/literals.ts"
import { arrayOf, intersectionOf, unionOf } from "../emit/shared/type-emitter.ts"

export type Compiler = typeof ts

/** Lib types every program has in scope: written by name, never imported. */
export function isLibFile(fileName: string): boolean {
	return /(?:^|[\\/])lib\.[\w.-]*\.d\.ts$/.test(fileName) || /[\\/]typescript[\\/]lib[\\/]/.test(fileName)
}

/** Whether a declaring module exports `sym` (a declaration file's types are always reachable). */
function isExported(sym: ts.Symbol, file: ts.SourceFile, checker: ts.TypeChecker): boolean {
	if (file.isDeclarationFile) return true
	const module = checker.getSymbolAtLocation(file)
	return module !== undefined && checker.getExportsOfModule(module).some((e) => e.getName() === sym.getName())
}

/** A script file (no import or export): its top-level declarations are global. */
function isScript(file: ts.SourceFile): boolean {
	return (file as unknown as { externalModuleIndicator?: unknown }).externalModuleIndicator === undefined
}

/* checked in order: `boolean` is a union of its literals, so it is named before unions are split */
const KEYWORDS: readonly (readonly [keyof typeof ts.TypeFlags, string])[] = [
	["String", "string"],
	["Number", "number"],
	["Boolean", "boolean"],
	["BigInt", "bigint"],
	["ESSymbol", "symbol"],
	["UniqueESSymbol", "symbol"],
	["Void", "void"],
	["Undefined", "undefined"],
	["Null", "null"],
	["Never", "never"],
	["Unknown", "unknown"],
	["Any", "unknown"],
	["NonPrimitive", "object"],
	["TemplateLiteral", "string"],
	/* deferred generic forms (`T extends U ? X : Y`, `T[K]`, `keyof T`) are written as their bound */
	["StringMapping", "string"],
	["Conditional", "unknown"],
	["Substitution", "unknown"],
	["IndexedAccess", "unknown"],
	["Index", "unknown"],
]

export class Serializer {
	readonly checker: ts.TypeChecker
	readonly compiler: Compiler
	readonly #active = new Set<ts.Type>()
	/* type parameters of the signatures being written: inside them a parameter keeps its name */
	readonly #bound = new Set<ts.Symbol>()

	constructor(checker: ts.TypeChecker, compiler: Compiler) {
		this.checker = checker
		this.compiler = compiler
	}

	/** An annotation's named type (`x: Foo<Bar>`) as an `import()` reference, when its module exports it. */
	refFromDeclaration(decl: ts.Declaration | undefined): string | undefined {
		const { checker, compiler } = this
		const typeRef = (decl as { type?: ts.TypeNode } | undefined)?.type
		if (typeRef === undefined || !compiler.isTypeReferenceNode(typeRef)) return undefined
		let sym = checker.getSymbolAtLocation(typeRef.typeName)
		while (sym !== undefined && sym.flags & compiler.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym)
		const file = sym?.declarations?.[0]?.getSourceFile()
		if (sym === undefined || file === undefined || isLibFile(file.fileName) || !isExported(sym, file, checker)) {
			return undefined
		}
		const args = (typeRef.typeArguments ?? []).map((a) => this.text(checker.getTypeFromTypeNode(a)))
		return `import("${file.fileName}").${sym.getName()}${args.length > 0 ? `<${args.join(", ")}>` : ""}`
	}

	/** A reference if the type has a name to be written by, else its structure. */
	text(type: ts.Type): string {
		return this.asRef(type) ?? this.serialize(type)
	}

	/** `import("path").Name<Args>` (or a global's name) for a declared type name, else null; lib types are left to `serialize`. */
	asRef(type: ts.Type): string | null {
		const sym = type.aliasSymbol ?? type.getSymbol()
		const decl = sym?.declarations?.[0]
		if (sym === undefined || decl === undefined || !this.#isTypeName(sym)) return null
		const file = decl.getSourceFile()
		if (isLibFile(file.fileName)) return null
		const globalName = this.#globalName(sym, decl)
		if (globalName !== null) return this.#withArgs(globalName, type, decl)
		/* an ambient module's member has no import() path here, and import() of an unexported type is `any` */
		if (isScript(file) || !isExported(sym, file, this.checker)) return null
		return this.#withArgs(`import("${file.fileName}").${sym.getName()}`, type, decl)
	}

	/** A name a type position can use: an alias, interface, class or enum (never a function's or a variable's). */
	#isTypeName(sym: ts.Symbol): boolean {
		const S = this.compiler.SymbolFlags
		return (sym.flags & (S.TypeAlias | S.Interface | S.Class | S.Enum)) !== 0
	}

	/** `ref` with the type's arguments; a class or interface reference carries its `this` type last, dropped here. */
	#withArgs(ref: string, type: ts.Type, decl: ts.Declaration): string {
		const all = (type.aliasSymbol ? type.aliasTypeArguments : (type as ts.TypeReference).typeArguments) ?? []
		const declared = (decl as { typeParameters?: readonly unknown[] }).typeParameters?.length ?? all.length
		const args = all.slice(0, declared).map((arg) => this.text(arg))
		return args.length > 0 ? `${ref}<${args.join(", ")}>` : ref
	}

	/** The name a global declaration is reachable by (`Cloudflare.Env`), or null if it is module-scoped. */
	#globalName(sym: ts.Symbol, decl: ts.Declaration): string | null {
		const { compiler } = this
		let global = false
		for (let n: ts.Node | undefined = decl.parent; n !== undefined; n = n.parent) {
			if (compiler.isModuleDeclaration(n) && n.flags & compiler.NodeFlags.GlobalAugmentation) {
				global = true
				break
			}
			if (compiler.isSourceFile(n)) global = isScript(n)
		}
		/* a `declare global` member is qualified as `global.Name`; in scope it is `Name` */
		const name = this.checker.getFullyQualifiedName(sym).replace(/^global\./, "")
		return global && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(name) ? name : null
	}

	serialize(type: ts.Type): string {
		if (this.#active.has(type)) return "unknown"
		this.#active.add(type)
		try {
			return this.#serialize(type)
		} finally {
			this.#active.delete(type)
		}
	}

	#serialize(type: ts.Type): string {
		const { compiler } = this
		/* an enum is nominal: its name when it can be referenced */
		const enumRef = (type.getSymbol()?.flags ?? 0) & compiler.SymbolFlags.Enum ? this.asRef(type) : null
		return (
			enumRef ??
			this.#keyword(type) ??
			this.#literal(type) ??
			this.#typeParameter(type) ??
			this.#composite(type) ??
			this.#named(type) ??
			this.#object(type)
		)
	}

	#keyword(type: ts.Type): string | null {
		const flags = this.compiler.TypeFlags
		return KEYWORDS.find(([flag]) => type.flags & (flags[flag] as number))?.[1] ?? null
	}

	#literal(type: ts.Type): string | null {
		const F = this.compiler.TypeFlags
		if (type.isStringLiteral()) return JSON.stringify(type.value)
		if (type.isNumberLiteral()) return `${type.value}`
		if (type.flags & F.BigIntLiteral) {
			const { base10Value, negative } = (type as ts.BigIntLiteralType).value
			return `${negative ? "-" : ""}${base10Value}n`
		}
		return type.flags & F.BooleanLiteral ? this.checker.typeToString(type) : null
	}

	/** By name inside the signature that declares it, else its constraint, else unknown. */
	#typeParameter(type: ts.Type): string | null {
		if (!(type.flags & this.compiler.TypeFlags.TypeParameter)) return null
		if (this.#bound.has(type.symbol)) return type.symbol.getName()
		const constraint = this.checker.getBaseConstraintOfType(type)
		return constraint !== undefined && constraint !== type ? this.serialize(constraint) : "unknown"
	}

	#composite(type: ts.Type): string | null {
		const { checker } = this
		if (type.isUnion()) return unionOf(type.types.map((t) => this.serialize(t)))
		if (type.isIntersection()) return intersectionOf(type.types.map((t) => this.serialize(t)))
		if (checker.isArrayType(type)) {
			const [element] = checker.getTypeArguments(type as ts.TypeReference) as [ts.Type]
			const text = arrayOf(this.serialize(element))
			return type.getSymbol()?.getName() === "ReadonlyArray" ? `readonly ${text}` : text
		}
		if (checker.isTupleType(type)) return this.#tuple(type as ts.TypeReference)
		const sigs = type.getCallSignatures()
		if (sigs.length === 0 || type.getProperties().length > 0) return null
		const parts = sigs.map((sig) => this.#signature(sig))
		return parts.length === 1 ? (parts[0] as string) : parts.map((p) => `(${p})`).join(" & ")
	}

	#tuple(ref: ts.TypeReference): string {
		const E = this.compiler.ElementFlags
		const target = ref.target as ts.TupleType
		const parts = this.checker.getTypeArguments(ref).map((arg, i) => {
			const flags = target.elementFlags[i] as number
			if (flags & E.Rest) return `...${arrayOf(this.serialize(arg))}`
			if (flags & E.Variadic) return `...${this.serialize(arg)}`
			return flags & E.Optional ? `${this.optional(arg)}?` : this.serialize(arg)
		})
		return `${target.readonly ? "readonly " : ""}[${parts.join(", ")}]`
	}

	/** A lib type by its name with its arguments; another named type by reference. */
	#named(type: ts.Type): string | null {
		const sym = type.getSymbol()
		const decl = sym?.declarations?.[0]
		if (sym === undefined || decl === undefined || !isLibFile(decl.getSourceFile().fileName)) return this.asRef(type)
		if (!this.#isTypeName(sym)) return null
		const args = (type as ts.TypeReference).typeArguments ?? []
		const declared = (decl as { typeParameters?: readonly unknown[] }).typeParameters?.length ?? args.length
		const kept = args.slice(0, declared).map((arg) => this.serialize(arg))
		return kept.length > 0 ? `${sym.getName()}<${kept.join(", ")}>` : sym.getName()
	}

	#object(type: ts.Type): string {
		const { checker, compiler } = this
		const index = type.getStringIndexType()
		const props = type.getProperties().filter((p) => isPublicName(p.getName()))
		if (index !== undefined && props.length === 0 && type.getCallSignatures().length === 0) {
			return `Record<string, ${this.serialize(index)}>`
		}
		const M = compiler.ModifierFlags
		const entries: string[] = []
		for (const p of props) {
			/* a mapped type's prop has no declaration */
			const decls = p.getDeclarations() ?? []
			if (decls.some((d) => compiler.getCombinedModifierFlags(d) & (M.Private | M.Protected))) continue
			const readonly = decls.some((d) => compiler.getCombinedModifierFlags(d) & M.Readonly)
			const optional = (p.flags & compiler.SymbolFlags.Optional) !== 0
			const member = checker.getTypeOfSymbol(p)
			const value = optional ? this.optional(member) : this.serialize(member)
			entries.push(`${readonly ? "readonly " : ""}${quoteKey(p.getName())}${optional ? "?" : ""}: ${value}`)
		}
		if (index !== undefined) entries.push(`[key: string]: ${this.serialize(index)}`)
		for (const sig of type.getCallSignatures()) entries.push(this.#signature(sig, true))
		return entries.length > 0 ? `{ ${entries.join("; ")} }` : "{}"
	}

	/** An object type written out member by member, never by its alias name: a core-internal alias stays out of the output. */
	shape(type: ts.Type): string {
		return this.#object(type)
	}

	/** An optional member's type, without the `| undefined` its `?` already says (a `null` stays). */
	optional(type: ts.Type): string {
		const kept = type.isUnion() ? type.types.filter((t) => !(t.flags & this.compiler.TypeFlags.Undefined)) : [type]
		return kept.length === 1 ? this.text(kept[0] as ts.Type) : unionOf(kept.map((t) => this.text(t)))
	}

	/** `<T extends X>(a: A, b?: B, ...rest: C[]) => R`, or the call-signature member form. */
	#signature(sig: ts.Signature, member = false): string {
		const params = sig.getTypeParameters() ?? []
		const added = params.map((t) => t.symbol).filter((s) => !this.#bound.has(s))
		for (const s of added) this.#bound.add(s)
		try {
			return this.#signatureText(sig, params, member)
		} finally {
			for (const s of added) this.#bound.delete(s)
		}
	}

	#signatureText(sig: ts.Signature, typeParams: readonly ts.TypeParameter[], member: boolean): string {
		const { checker } = this
		const generics = typeParams.map((t) => {
			const constraint = t.getConstraint()
			return `${t.symbol.getName()}${constraint === undefined ? "" : ` extends ${this.text(constraint)}`}`
		})
		const params = sig.getParameters().map((p) => {
			const type = checker.getTypeOfSymbol(p)
			const param = p.valueDeclaration as ts.ParameterDeclaration | undefined
			const rest = param?.dotDotDotToken !== undefined
			const optional = !rest && param !== undefined && checker.isOptionalParameter(param)
			const text = optional ? this.optional(type) : this.text(type)
			return `${rest ? "..." : ""}${p.getName()}${optional ? "?" : ""}: ${text}`
		})
		const head = `${generics.length > 0 ? `<${generics.join(", ")}>` : ""}(${params.join(", ")})`
		const ret = this.text(checker.getReturnTypeOfSignature(sig))
		return member ? `${head}: ${ret}` : `${head} => ${ret}`
	}
}

/** A property name a type literal can spell: `#secret` fields surface as `__#123@#secret`, symbol keys as `__@name@1`. */
export function isPublicName(name: string): boolean {
	return !name.startsWith("#") && !name.startsWith("__#") && !name.startsWith("__@")
}
