import { existsSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import type { ts } from "ts-morph"
import { canonical, expandOptional, joinPatterns, parsePattern } from "./pattern.ts"
import { quoteKey } from "./type-emitter.ts"

export type ExtractedBaseCtx = {
	envType: string
	middlewareType: string | null
	tapsType: string | null
}

/**
 * The tsconfig that governs the entry: the nearest one walking up, but never past the
 * project root (the nearest directory with a package.json) — a stray tsconfig in a parent
 * directory or the home folder is not this project's.
 */
function findTsConfig(fromPath: string): string | undefined {
	let dir = dirname(resolve(fromPath))
	let prev = ""
	while (dir !== prev) {
		const p = resolve(dir, "tsconfig.json")
		if (existsSync(p)) return p
		if (existsSync(resolve(dir, "package.json"))) return undefined
		prev = dir
		dir = dirname(dir)
	}
	return undefined
}

/* ts-morph bundles a different TS version — structurally identical at runtime */
function bridge<T>(value: unknown): T {
	return value as T
}

type LoadedEntry = {
	/** The app's type */
	appType: ts.Type
	checker: ts.TypeChecker
	compiler: typeof ts
	/** A node inside the entry, for type lookups that need a location */
	node: ts.Node
	project: import("ts-morph").Project
	sourceFile: import("ts-morph").SourceFile
}

/**
 * Load the entry and find the app export: `export const app = …`, any other exported
 * declaration of that name, or `export default honey()` for `exportName: "default"`.
 */
async function loadEntry(options: {
	entryPath: string
	exportName: string
	tsconfigPath?: string
}): Promise<LoadedEntry> {
	const { Project, ts: tsLib } = await import("ts-morph")
	const tsConfigFilePath = options.tsconfigPath ?? findTsConfig(options.entryPath)
	const project = new Project({ skipAddingFilesFromTsConfig: true, tsConfigFilePath })
	project.addSourceFilesAtPaths(options.entryPath)
	project.resolveSourceFileDependencies()

	const sourceFile = project.getSourceFileOrThrow(options.entryPath)
	const declarations = sourceFile.getExportedDeclarations().get(options.exportName)
	const decl = declarations?.[0] ?? sourceFile.getVariableDeclaration(options.exportName)
	if (!decl) {
		throw new Error(`Export "${options.exportName}" not found in ${options.entryPath}`)
	}
	const checker: ts.TypeChecker = bridge(project.getTypeChecker().compilerObject)
	const node: ts.Node = bridge(decl.compilerNode)
	const compiler: typeof ts = bridge(tsLib)
	/* `export default <expr>` declares an ExportAssignment; its type is the expression's */
	const target = compiler.isExportAssignment(node) ? node.expression : node
	const appType = checker.getTypeAtLocation(target)
	return { appType, checker, compiler, node: target, project, sourceFile }
}

/**
 * Uses ts-morph to extract the middleware context type from a Honey app export.
 * Returns inline type strings so the gen file has zero imports from user code.
 */
export async function extractBaseCtx(options: {
	entryPath: string
	exportName: string
	outputDir?: string
	tsconfigPath?: string
}): Promise<ExtractedBaseCtx> {
	const { appType, checker, compiler, node } = await loadEntry(options)
	const ser = new Serializer(checker, node, compiler)

	const typeOfProp = (name: string): ts.Type | null => {
		const sym = appType.getProperty(name)
		return sym ? checker.getTypeOfSymbolAtLocation(sym, node) : null
	}

	/* extract $env */
	const envT = typeOfProp("$env")
	const envType = envT ? ser.serialize(envT) : "Record<string, unknown>"

	/* extract $ctx and isolate middleware additions */
	const ctxType = typeOfProp("$ctx")
	if (!ctxType) {
		throw new Error(`Export "${options.exportName}" has no $ctx — not a Honey instance`)
	}
	const middlewareType = propsType(extractMiddlewareProps(ctxType, ser))

	/* extract $taps — typed tap payloads declared via .taps<T>() */
	let tapsType: string | null = null
	const tapsT = typeOfProp("$taps")
	if (tapsT) {
		const tapsStr = ser.serialize(tapsT)
		if (tapsStr !== "{}" && tapsStr !== "Record<string, unknown>") tapsType = tapsStr
	}

	const sanitize = (s: string) => sanitizeImportPaths(s, options.outputDir)
	return {
		envType: sanitize(envType),
		middlewareType: middlewareType ? sanitize(middlewareType) : null,
		tapsType: tapsType ? sanitize(tapsType) : null,
	}
}

/* properties that live on HoneyContext — everything else is middleware-added */
const HONEY_CTX_PROPS = new Set([
	"background",
	"cookies",
	"env",
	"errors",
	"executionCtx",
	"headers",
	"meta",
	"params",
	"path",
	"req",
	"res",
	"routePattern",
	"search",
	"searchAll",
	"tap",
])

type MwPropEntry = { name: string; opt: boolean; type: string }

function propsType(props: readonly MwPropEntry[]): string | null {
	if (props.length === 0) return null
	return `{ ${props.map((p) => `${quoteKey(p.name)}${p.opt ? "?" : ""}: ${p.type}`).join("; ")} }`
}

/** Is a property name something a type literal can spell and a consumer can see? */
function isPublicName(name: string): boolean {
	/* `#secret` private fields surface as `__#123@#secret` — never part of a type */
	return !name.startsWith("#") && !name.startsWith("__#")
}

function extractMiddlewareProps(ctxType: ts.Type, ser: Serializer): MwPropEntry[] {
	const { checker, compiler, node } = ser
	const mwProps = ctxType.getProperties().filter((p) => {
		const name = p.getName()
		if (HONEY_CTX_PROPS.has(name)) return false
		/* skip internal/private properties (underscore-prefixed) */
		if (name.startsWith("_")) return false
		return isPublicName(name)
	})

	return mwProps.map((p) => {
		const t = checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration ?? node)
		const opt = (p.flags & compiler.SymbolFlags.Optional) !== 0

		/* 1. try declaration-site TypeReference (explicit annotation on property or variable) */
		let typeStr: string | undefined
		const mwDecl = p.valueDeclaration ?? p.declarations?.[0]
		typeStr = ser.refFromDeclaration(mwDecl)

		/* 1b. shorthand property — trace to the underlying variable's type annotation */
		if (!typeStr && mwDecl && compiler.isShorthandPropertyAssignment(mwDecl)) {
			const varSym = checker.getShorthandAssignmentValueSymbol(mwDecl)
			if (varSym) {
				const varDecl = varSym.valueDeclaration ?? varSym.declarations?.[0]
				typeStr = ser.refFromDeclaration(varDecl)

				/* 1c. destructured binding (e.g. const { shardDb } = openShardSession(...))
				 * — trace through the function return type to find the original type annotation */
				if (!typeStr && varDecl && compiler.isBindingElement(varDecl)) {
					let parent: ts.Node = varDecl.parent
					while (parent && !compiler.isVariableDeclaration(parent)) parent = parent.parent
					if (parent && compiler.isVariableDeclaration(parent)) {
						const initializer = (parent as ts.VariableDeclaration).initializer
						if (initializer) {
							const initType = checker.getTypeAtLocation(initializer)
							const retProp = initType.getProperty(p.getName())
							if (retProp?.valueDeclaration && compiler.isShorthandPropertyAssignment(retProp.valueDeclaration)) {
								const innerSym = checker.getShorthandAssignmentValueSymbol(retProp.valueDeclaration)
								if (innerSym) {
									const innerDecl = innerSym.valueDeclaration ?? innerSym.declarations?.[0]
									typeStr = ser.refFromDeclaration(innerDecl)
								}
							}
						}
					}
				}
			}
		}

		/* 2. a named type as an import() reference; 3. structural */
		typeStr ??= ser.asRef(t) ?? ser.serialize(t)

		return { name: p.getName(), opt, type: typeStr }
	})
}

/** Check if a symbol is exported from its source file */
function isExportedFromFile(sym: ts.Symbol, sf: ts.SourceFile, checker: ts.TypeChecker): boolean {
	/* .d.ts module types are always accessible */
	if (sf.isDeclarationFile) return true
	const moduleSym = checker.getSymbolAtLocation(sf)
	if (!moduleSym) return false
	const exports = checker.getExportsOfModule(moduleSym)
	return exports.some((e) => e.getName() === sym.getName())
}

/** Lib types every program has in scope; their names are written as is, never imported. */
function isLibFile(fileName: string): boolean {
	return /(?:^|[\\/])lib\.[\w.-]*\.d\.ts$/.test(fileName) || /[\\/]typescript[\\/]lib[\\/]/.test(fileName)
}

/**
 * TypeScript types → type source text.
 *
 * Named types become `import("…").Name<Args>` references when the declaring module exports
 * them; everything else is written structurally. The structural writer is precise about the
 * things a reader relies on: optional and rest parameters, generic signatures, tuple rest and
 * optional elements, literal types (quoted), boolean literals, quoted keys, and precedence
 * (`(() => void)[]`, `(A | B) & C`). A type it is still expanding when it meets itself again
 * is written as `unknown` there, never expanded without end.
 */
class Serializer {
	readonly checker: ts.TypeChecker
	readonly compiler: typeof ts
	readonly node: ts.Node
	readonly #active = new Set<ts.Type>()

	constructor(checker: ts.TypeChecker, node: ts.Node, compiler: typeof ts) {
		this.checker = checker
		this.node = node
		this.compiler = compiler
	}

	/** An `import()` reference with type arguments for an annotation like `x: Foo<Bar>`. */
	refFromDeclaration(decl: ts.Declaration | undefined): string | undefined {
		const { checker, compiler } = this
		if (!decl) return undefined
		const typeRef = (decl as { type?: ts.TypeNode }).type
		if (!typeRef || !compiler.isTypeReferenceNode(typeRef)) return undefined
		let refSym = checker.getSymbolAtLocation(typeRef.typeName)
		while (refSym && refSym.flags & compiler.SymbolFlags.Alias) refSym = checker.getAliasedSymbol(refSym)
		if (!refSym?.declarations?.length) return undefined
		const srcFile = refSym.declarations[0].getSourceFile()
		if (isLibFile(srcFile.fileName)) return undefined
		if (!isExportedFromFile(refSym, srcFile, checker)) return undefined
		const args = typeRef.typeArguments?.map((a) => {
			const t = checker.getTypeFromTypeNode(a)
			return this.asRef(t) ?? this.serialize(t)
		})
		const argText = args && args.length > 0 ? `<${args.join(", ")}>` : ""
		return `import("${srcFile.fileName}").${refSym.getName()}${argText}`
	}

	/**
	 * `import("path").TypeName<Args>` for a named type whose module exports it, else null.
	 * Globals (Promise, Map, …) are left to `serialize`.
	 */
	asRef(type: ts.Type, depth = 0): string | null {
		const { checker, compiler } = this
		if (depth > 6) return null

		/* union with never members (from intersection narrowing) — simplify first */
		if (type.isUnion()) {
			const nonNever = type.types.filter((t) => !(t.flags & compiler.TypeFlags.Never))
			if (nonNever.length === 1) return this.asRef(nonNever[0], depth)
		}

		const sym = type.aliasSymbol ?? type.getSymbol()
		if (!sym) return null
		const name = sym.getName()
		if (!name || name.startsWith("__") || name === "Object") return null
		const decls = sym.declarations
		if (!decls?.length) return null
		const sf = decls[0].getSourceFile()
		if (isLibFile(sf.fileName)) return null

		const named =
			(sym.flags &
				(compiler.SymbolFlags.TypeAlias |
					compiler.SymbolFlags.Interface |
					compiler.SymbolFlags.Class |
					compiler.SymbolFlags.Enum)) !==
			0
		/* only reference .d.ts symbols or explicitly declared named types from .ts files */
		if (!sf.isDeclarationFile && !named) return null
		/* skip ambient .d.ts scripts (no exports) — import() can't resolve them */
		if (sf.isDeclarationFile && !(sf as unknown as { externalModuleIndicator?: unknown }).externalModuleIndicator) {
			return null
		}
		/* skip non-exported symbols — import() on them resolves to `any` */
		if (!isExportedFromFile(sym, sf, checker)) return null

		const typeArgs = type.aliasSymbol ? type.aliasTypeArguments : (type as ts.TypeReference).typeArguments
		/* a class or interface reference carries its `this` type as a trailing argument */
		const declared = sym.declarations?.[0]
		const paramCount =
			declared && "typeParameters" in declared
				? ((declared as { typeParameters?: unknown[] }).typeParameters?.length ?? 0)
				: (typeArgs?.length ?? 0)
		const args = (typeArgs ?? []).slice(0, paramCount)
		if (args.length > 0) {
			const text = args.map((arg) => this.asRef(arg, depth + 1) ?? this.serialize(arg))
			return `import("${sf.fileName}").${name}<${text.join(", ")}>`
		}
		return `import("${sf.fileName}").${name}`
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
		const { checker, compiler, node } = this
		const F = compiler.TypeFlags
		const next = (t: ts.Type) => this.serialize(t)

		/* an enum is nominal: keep its name when it can be referenced */
		const enumSym = type.getSymbol()
		if (enumSym && enumSym.flags & compiler.SymbolFlags.Enum) {
			const ref = this.asRef(type)
			if (ref) return ref
		}

		/* primitives */
		if (type.flags & F.String) return "string"
		if (type.flags & F.Number) return "number"
		if (type.flags & F.Boolean) return "boolean"
		if (type.flags & F.BigInt) return "bigint"
		if (type.flags & F.ESSymbol) return "symbol"
		if (type.flags & F.UniqueESSymbol) return "symbol"
		if (type.flags & F.Void) return "void"
		if (type.flags & F.Undefined) return "undefined"
		if (type.flags & F.Null) return "null"
		if (type.flags & F.Never) return "never"
		if (type.flags & F.Unknown) return "unknown"
		if (type.flags & F.Any) return "unknown"
		if (type.flags & F.NonPrimitive) return "object"

		/* literals */
		if (type.isStringLiteral()) return JSON.stringify(type.value)
		if (type.isNumberLiteral()) return `${type.value}`
		if (type.flags & F.BigIntLiteral) {
			const v = (type as ts.BigIntLiteralType).value
			return `${v.negative ? "-" : ""}${v.base10Value}n`
		}
		if (type.flags & F.BooleanLiteral) return checker.typeToString(type)
		if (type.flags & F.TemplateLiteral) return "string"

		/* a type parameter with no binding — its constraint, or unknown */
		if (type.flags & F.TypeParameter) {
			const constraint = checker.getBaseConstraintOfType(type)
			return constraint && constraint !== type ? next(constraint) : "unknown"
		}

		/* union */
		if (type.isUnion()) return unionText(type.types.map(next))

		/* intersection */
		if (type.isIntersection()) return intersectionText(type.types.map(next))

		/* array */
		if (checker.isArrayType(type)) {
			const args = checker.getTypeArguments(type as ts.TypeReference)
			const readonlyArray = type.getSymbol()?.getName() === "ReadonlyArray"
			const el = args.length > 0 ? arrayText(next(args[0])) : "unknown[]"
			return readonlyArray ? `readonly ${el}` : el
		}

		/* tuple — rest and optional elements kept */
		if (checker.isTupleType(type)) {
			const ref = type as ts.TypeReference
			const args = checker.getTypeArguments(ref)
			const target = ref.target as ts.TupleType
			const parts = args.map((arg, i) => {
				const flags = target.elementFlags?.[i] ?? compiler.ElementFlags.Required
				if (flags & compiler.ElementFlags.Rest) return `...${arrayText(next(arg))}`
				if (flags & compiler.ElementFlags.Variadic) return `...${next(arg)}`
				if (flags & compiler.ElementFlags.Optional) return `${next(arg)}?`
				return next(arg)
			})
			return `${target.readonly ? "readonly " : ""}[${parts.join(", ")}]`
		}

		/* function (pure callable, no data properties) */
		const sigs = type.getCallSignatures()
		if (sigs.length > 0 && type.getProperties().length === 0) {
			const parts = sigs.map((sig) => this.#signature(sig))
			return parts.length === 1 ? parts[0] : parts.map((p) => `(${p})`).join(" & ")
		}

		/* well-known globals — keep name, serialize type args */
		const sym = type.getSymbol()
		if (sym) {
			const name = sym.getName()
			const decl = sym.declarations?.[0]
			if (decl && isLibFile(decl.getSourceFile().fileName) && name !== "Object" && !name.startsWith("__")) {
				const args = (type as ts.TypeReference).typeArguments ?? []
				const declaredParams = (decl as { typeParameters?: unknown[] }).typeParameters?.length ?? args.length
				const kept = args.slice(0, declaredParams)
				return kept.length > 0 ? `${name}<${kept.map(next).join(", ")}>` : name
			}

			/* named types — prefer import() reference over structural expansion */
			if (name && !name.startsWith("__") && name !== "Object") {
				const ref = this.asRef(type)
				if (ref) return ref
			}
		}
		const aliasRef = type.aliasSymbol ? this.asRef(type) : null
		if (aliasRef) return aliasRef

		/* Record<string, V> — index signature only */
		const stringIdx = type.getStringIndexType()
		if (stringIdx && type.getProperties().length === 0) {
			return `Record<string, ${next(stringIdx)}>`
		}

		/* object — expand to structural form */
		const props = type.getProperties().filter((p) => isPublicName(p.getName()))
		const entries: string[] = []
		for (const p of props) {
			const decls = p.getDeclarations()
			if (decls?.length) {
				const flags = compiler.getCombinedModifierFlags(decls[0])
				if (flags & (compiler.ModifierFlags.Private | compiler.ModifierFlags.Protected)) continue
			}
			const pt = checker.getTypeOfSymbolAtLocation(p, decls?.[0] ?? node)
			const opt = (p.flags & compiler.SymbolFlags.Optional) !== 0
			const ro =
				decls?.some((d) => (compiler.getCombinedModifierFlags(d) & compiler.ModifierFlags.Readonly) !== 0) ?? false
			entries.push(`${ro ? "readonly " : ""}${quoteKey(p.getName())}${opt ? "?" : ""}: ${next(pt)}`)
		}
		if (stringIdx) entries.push(`[key: string]: ${next(stringIdx)}`)
		for (const sig of sigs) entries.push(this.#signature(sig, true))
		if (entries.length > 0) return `{ ${entries.join("; ")} }`
		if (props.length === 0) return "{}"
		return "unknown"
	}

	/** `<T extends X>(a: A, b?: B, ...rest: C[]) => R`, or the call-signature member form */
	#signature(sig: ts.Signature, member = false): string {
		const { checker, compiler, node } = this
		const typeParams = sig.getTypeParameters() ?? []
		const tp =
			typeParams.length > 0
				? `<${typeParams
						.map((t) => {
							const c = t.getConstraint()
							return `${t.symbol.getName()}${c ? ` extends ${this.#typeParamText(c)}` : ""}`
						})
						.join(", ")}>`
				: ""
		const params = sig.getParameters().map((p) => {
			const pt = checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration ?? node)
			const decl = p.valueDeclaration
			const param = decl && compiler.isParameter(decl) ? (decl as ts.ParameterDeclaration) : undefined
			const isRest = param?.dotDotDotToken !== undefined
			const optional = !isRest && param !== undefined && checker.isOptionalParameter(param)
			/* an optional parameter's type carries `| undefined`; `?` already says so */
			const text = optional ? this.#typeParamText(checker.getNonNullableType(pt)) : this.#typeParamText(pt)
			return `${isRest ? "..." : ""}${p.getName()}${optional ? "?" : ""}: ${text}`
		})
		const ret = this.#typeParamText(checker.getReturnTypeOfSignature(sig))
		return member ? `${tp}(${params.join(", ")}): ${ret}` : `${tp}(${params.join(", ")}) => ${ret}`
	}

	/** A type inside a signature: a bare type parameter stays by name, bound by the signature. */
	#typeParamText(t: ts.Type): string {
		if (t.flags & this.compiler.TypeFlags.TypeParameter) return t.symbol.getName()
		return this.asRef(t) ?? this.serialize(t)
	}
}

/**
 * Does `type` contain `token` outside every bracket and string? Used to parenthesize only
 * where precedence needs it.
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

function arrayText(el: string): string {
	return hasTopLevel(el, "|") || hasTopLevel(el, "&") || hasTopLevel(el, "=>") || el.startsWith("readonly ")
		? `(${el})[]`
		: `${el}[]`
}

function unionText(parts: string[]): string {
	return [...new Set(parts)].map((p) => (hasTopLevel(p, "=>") ? `(${p})` : p)).join(" | ")
}

function intersectionText(parts: string[]): string {
	return parts.map((p) => (hasTopLevel(p, "|") || hasTopLevel(p, "=>") ? `(${p})` : p)).join(" & ")
}

/* ---- module specifiers ---- */

type PackageInfo = { dir: string; json: Record<string, unknown> }

const packageCache = new Map<string, PackageInfo | null>()

function nearestPackage(fromFile: string): PackageInfo | null {
	let dir = dirname(fromFile)
	const visited: string[] = []
	let found: PackageInfo | null = null
	let prev = ""
	while (dir !== prev) {
		const cached = packageCache.get(dir)
		if (cached !== undefined) {
			found = cached
			break
		}
		visited.push(dir)
		const file = join(dir, "package.json")
		if (existsSync(file)) {
			try {
				const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
				/* a package.json without a name (a "type": "module" marker) is not a package boundary */
				if (typeof json.name === "string") {
					found = { dir, json }
					break
				}
			} catch {
				/* unreadable — keep walking */
			}
		}
		prev = dir
		dir = dirname(dir)
	}
	for (const d of visited) packageCache.set(d, found)
	return found
}

/** Every file an `exports` value can point at, with the subpath that names it. */
function exportTargets(exports: unknown): Array<{ subpath: string; target: string }> {
	const out: Array<{ subpath: string; target: string }> = []
	const collect = (subpath: string, value: unknown): void => {
		if (typeof value === "string") out.push({ subpath, target: value })
		else if (Array.isArray(value)) for (const v of value) collect(subpath, v)
		else if (value !== null && typeof value === "object") {
			for (const v of Object.values(value as Record<string, unknown>)) collect(subpath, v)
		}
	}
	if (typeof exports === "string" || Array.isArray(exports)) collect(".", exports)
	else if (exports !== null && typeof exports === "object") {
		const entries = Object.entries(exports as Record<string, unknown>)
		if (entries.length > 0 && entries.every(([k]) => !k.startsWith("."))) collect(".", exports)
		else for (const [k, v] of entries) collect(k, v)
	}
	return out
}

function stripTypeExtension(path: string): string {
	return path
		.replace(/\.d\.[mc]?ts$/, "")
		.replace(/\.[mc]?tsx?$/, "")
		.replace(/\.[mc]?js$/, "")
}

/** `@types/foo` types the `foo` package; `@types/scope__name` types `@scope/name`. */
function typedPackageName(name: string): string {
	if (!name.startsWith("@types/")) return name
	const bare = name.slice("@types/".length)
	return bare.includes("__") ? `@${bare.replace("__", "/")}` : bare
}

/**
 * The specifier a generated file should use to import `filePath`.
 *
 * A file of another package is named through that package — its `exports` subpath when one
 * points at the file (any condition: `types`, `default`, or a source condition), its `types`
 * entry, or (no `exports` map) its path without extension; an `@types` package by the package it
 * types. A file of the output's own package is a relative path. Lib files never get here.
 */
function moduleSpecifier(filePath: string, outputDir: string | undefined): string {
	const pkg = nearestPackage(filePath)
	const ownPkg = outputDir ? nearestPackage(join(outputDir, "_")) : null
	const relativeSpecifier = (): string => {
		if (!outputDir) return filePath
		let rel = relative(outputDir, filePath).split(sep).join("/")
		if (!rel.startsWith(".")) rel = `./${rel}`
		return rel
	}
	if (!pkg || (ownPkg && pkg.dir === ownPkg.dir)) return relativeSpecifier()
	const name = typedPackageName(String(pkg.json.name))
	const rel = `./${relative(pkg.dir, filePath).split(sep).join("/")}`

	if (pkg.json.exports !== undefined) {
		const match = exportTargets(pkg.json.exports).find(
			(e) => e.target === rel || stripTypeExtension(e.target) === stripTypeExtension(rel),
		)
		if (match) return match.subpath === "." ? name : `${name}/${match.subpath.replace(/^\.\//, "")}`
		/* the package does not export this file — a path into it would not resolve */
		return relativeSpecifier()
	}
	const typesEntry = pkg.json.types ?? pkg.json.typings
	if (
		typeof typesEntry === "string" &&
		stripTypeExtension(`./${typesEntry.replace(/^\.\//, "")}`) === stripTypeExtension(rel)
	) {
		return name
	}
	const sub = stripTypeExtension(rel.slice(2)).replace(/\/index$/, "")
	return sub === "index" || sub === "" ? name : `${name}/${sub}`
}

/**
 * Rewrite absolute `import("…")` paths into resolvable module specifiers, and drop the
 * `import()` around lib types (`Date`, `Promise`), which are global.
 */
function sanitizeImportPaths(str: string, outputDir?: string): string {
	return str.replace(/import\("([^"]+)"\)\./g, (_match, filePath: string) => {
		if (isLibFile(filePath)) return ""
		return `import("${moduleSpecifier(filePath, outputDir)}").`
	})
}

export type ExtractedChainTypes = {
	base: ExtractedBaseCtx
	/** per-route middleware additions keyed by "method /full/path" (basePath included) */
	routeMiddleware: Record<string, string>
	/** structured per-property middleware data for sub-type dedup */
	routeMiddlewareProps: Record<string, Array<{ name: string; opt: boolean; type: string }>>
}

const HTTP_METHODS = new Set(["all", "delete", "get", "head", "options", "patch", "post", "put"])

/**
 * Extracts base ctx and per-route middleware additions from sub-chains.
 *
 * Every source file of the program is scanned for HTTP method calls (`.get()`, `.post()`, …)
 * on a Honey instance. A route is keyed by its full path — the receiver's `$basePath` type
 * joined with the literal path, exactly as the router registers it — so `v1.get("/items")`
 * and `pub.get("/items")` never share an entry. A receiver whose base path is not a literal
 * type cannot be keyed and is skipped: a route without an entry gets the base ctx, never
 * another route's.
 */
export async function extractChainTypes(options: {
	entryPath: string
	exportName: string
	outputDir?: string
	tsconfigPath?: string
}): Promise<ExtractedChainTypes> {
	const { appType, checker, compiler, node: baseNode, project } = await loadEntry(options)
	const ser = new Serializer(checker, baseNode, compiler)

	function getCtxType(tsType: ts.Type, locationNode?: ts.Node): ts.Type | null {
		const sym = tsType.getProperty("$ctx")
		if (!sym) return null
		return checker.getTypeOfSymbolAtLocation(sym, locationNode ?? sym.valueDeclaration ?? baseNode)
	}

	function basePathOf(tsType: ts.Type, locationNode: ts.Node): string | null {
		const sym = tsType.getProperty("$basePath")
		if (!sym) return null
		const t = checker.getTypeOfSymbolAtLocation(sym, locationNode)
		return t.isStringLiteral() ? t.value : null
	}

	/* extract base ctx */
	let envType = "Record<string, unknown>"
	const envSym = appType.getProperty("$env")
	if (envSym) envType = ser.serialize(checker.getTypeOfSymbolAtLocation(envSym, baseNode))

	const baseCtxType = getCtxType(appType, baseNode)
	if (!baseCtxType) {
		throw new Error(`Export "${options.exportName}" has no $ctx — not a Honey instance`)
	}
	const baseMwProps = extractMiddlewareProps(baseCtxType, ser)
	const baseMiddlewareType = propsType(baseMwProps)

	/* build name→type map for reusing base type references in route middleware */
	const basePropTypeByName = new Map<string, string>()
	for (const p of baseMwProps) basePropTypeByName.set(p.name, p.type)

	/* collect base middleware property names for diffing */
	const baseMwPropNames = new Set<string>()
	for (const p of baseCtxType.getProperties()) {
		const name = p.getName()
		if (!HONEY_CTX_PROPS.has(name) && !name.startsWith("_")) baseMwPropNames.add(name)
	}

	const sanitize = (s: string) => sanitizeImportPaths(s, options.outputDir)

	const routeMiddleware: Record<string, string> = Object.create(null)
	const routeMiddlewareProps: Record<string, Array<{ name: string; opt: boolean; type: string }>> = Object.create(null)

	function visitNode(node: ts.Node): void {
		if (compiler.isCallExpression(node) && compiler.isPropertyAccessExpression(node.expression)) {
			const methodName = node.expression.name.text
			const pathArg = node.arguments[0]
			if (HTTP_METHODS.has(methodName) && pathArg && compiler.isStringLiteralLike(pathArg)) {
				const receiverExpr = node.expression.expression
				const receiverType = checker.getTypeAtLocation(receiverExpr)
				const ctxType = getCtxType(receiverType, receiverExpr)
				const basePath = ctxType ? basePathOf(receiverType, receiverExpr) : null
				if (ctxType && basePath !== null) {
					for (const variant of fullPaths(basePath, pathArg.text)) recordRoute(`${methodName} ${variant}`, ctxType)
				}
			}
		}
		compiler.forEachChild(node, visitNode)
	}

	/** The paths the router serves for this registration — an optional last param yields two. */
	function fullPaths(basePath: string, path: string): string[] {
		try {
			return expandOptional(parsePattern(joinPatterns(basePath, path))).map((segments) => canonical(segments))
		} catch {
			/* a pattern the router would refuse registers nothing */
			return []
		}
	}

	function recordRoute(key: string, ctxType: ts.Type): void {
		/* extract extra middleware props by iterating intersection MEMBERS individually.
		 * This preserves source-level declarations (e.g. ShorthandPropertyAssignment)
		 * that get lost when extracting from the flattened intersection. */
		const extraEntries: MwPropEntry[] = []
		const dupeNames = new Set<string>()
		const members = ctxType.isIntersection() ? (ctxType as ts.IntersectionType).types : [ctxType]
		for (const member of members) {
			for (const rp of extractMiddlewareProps(member, ser)) {
				if (baseMwPropNames.has(rp.name)) continue
				if (extraEntries.some((e) => e.name === rp.name)) {
					dupeNames.add(rp.name)
					continue
				}
				extraEntries.push(rp)
			}
		}
		/* a property in several intersection members (e.g. auth narrowed by a later middleware)
		 * is read from the flattened intersection, so TypeScript computes the intersected type */
		for (const dupeName of dupeNames) {
			const sym = ctxType.getProperty(dupeName)
			if (!sym) continue
			const t = checker.getTypeOfSymbolAtLocation(sym, sym.valueDeclaration ?? baseNode)
			const typeStr = ser.asRef(t) ?? ser.serialize(t)
			const idx = extraEntries.findIndex((e) => e.name === dupeName)
			if (idx !== -1) extraEntries[idx] = { ...extraEntries[idx], type: typeStr }
		}
		if (extraEntries.length === 0) return

		/* reuse compact base type references when the route has the same property
		 * (e.g. shardDb: ShardDb from base → reuse import ref instead of structural expansion) */
		const entries = extraEntries.map((e) => {
			const baseRef = basePropTypeByName.get(e.name)
			return baseRef && baseRef.length < e.type.length ? { ...e, type: baseRef } : e
		})
		routeMiddleware[key] = sanitize(propsType(entries) ?? "{}")
		routeMiddlewareProps[key] = entries.map((e) => ({ name: e.name, opt: e.opt, type: sanitize(e.type) }))
	}

	/* every source file of the program, not only the entry: routes are often registered in
	   modules the entry imports */
	for (const sf of project.getSourceFiles()) {
		const compilerSf: ts.SourceFile = bridge(sf.compilerNode)
		if (compilerSf.isDeclarationFile) continue
		if (/[\\/]node_modules[\\/]/.test(compilerSf.fileName)) continue
		visitNode(compilerSf)
	}

	/* extract $taps */
	let tapsType: string | null = null
	const tapsSym = appType.getProperty("$taps")
	if (tapsSym) {
		const tapsStr = ser.serialize(checker.getTypeOfSymbolAtLocation(tapsSym, baseNode))
		if (tapsStr !== "{}" && tapsStr !== "Record<string, unknown>") tapsType = tapsStr
	}

	return {
		base: {
			envType: sanitize(envType),
			middlewareType: baseMiddlewareType ? sanitize(baseMiddlewareType) : null,
			tapsType: tapsType ? sanitize(tapsType) : null,
		},
		routeMiddleware: { ...routeMiddleware },
		routeMiddlewareProps: { ...routeMiddlewareProps },
	}
}
