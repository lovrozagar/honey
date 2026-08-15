import { existsSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import type { ts } from "ts-morph"

export type ExtractedBaseCtx = {
	envType: string
	middlewareType: string | null
	tapsType: string | null
}

function findTsConfig(fromPath: string): string | undefined {
	let dir = dirname(resolve(fromPath))
	let prev = ""
	while (dir !== prev) {
		const p = resolve(dir, "tsconfig.json")
		if (existsSync(p)) return p
		prev = dir
		dir = dirname(dir)
	}
	return undefined
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
	const { Project, ts } = await import("ts-morph")

	const tsConfigFilePath = options.tsconfigPath ?? findTsConfig(options.entryPath)

	const project = new Project({
		skipAddingFilesFromTsConfig: true,
		tsConfigFilePath,
	})

	project.addSourceFilesAtPaths(options.entryPath)
	project.resolveSourceFileDependencies()

	const sourceFile = project.getSourceFileOrThrow(options.entryPath)
	const varDecl = sourceFile.getVariableDeclaration(options.exportName)
	if (!varDecl) {
		throw new Error(`Export "${options.exportName}" not found in ${options.entryPath}`)
	}

	const type = varDecl.getType()
	/* ts-morph bundles different TS version — structurally identical at runtime */
	function bridge<T>(value: unknown): T {
		return value as T
	}
	const checker: ts.TypeChecker = bridge(project.getTypeChecker().compilerObject)
	const node: ts.Node = bridge(varDecl.compilerNode)
	const tsLib: typeof ts = bridge(ts)

	function getType(sym: ReturnType<typeof type.getProperty>): ts.Type {
		const s: ts.Symbol = bridge(sym?.compilerSymbol)
		return checker.getTypeOfSymbolAtLocation(s, node)
	}

	/* extract $env */
	let envType = "Record<string, unknown>"
	const envProp = type.getProperty("$env")
	if (envProp) {
		envType = serialize(getType(envProp), checker, node, tsLib)
	}

	/* extract $ctx and isolate middleware additions */
	const ctxProp = type.getProperty("$ctx")
	if (!ctxProp) {
		throw new Error(`Export "${options.exportName}" has no $ctx — not a Honey instance`)
	}

	const ctxType = getType(ctxProp)
	const middlewareType = extractMiddleware(ctxType, checker, node, tsLib)

	/* extract $taps — typed tap payloads declared via .taps<T>() */
	let tapsType: string | null = null
	const tapsProp = type.getProperty("$taps")
	if (tapsProp) {
		const tapsT = getType(tapsProp)
		const tapsStr = serialize(tapsT, checker, node, tsLib)
		if (tapsStr !== "{}" && tapsStr !== "Record<string, unknown>") {
			tapsType = tapsStr
		}
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

/** Resolve an import() reference from a declaration's type annotation */
function resolveTypeRefFromDecl(
	decl: ts.Declaration | undefined,
	checker: ts.TypeChecker,
	compiler: typeof ts,
): string | undefined {
	if (!decl) return undefined
	const typeRef = (decl as { type?: ts.TypeNode }).type
	if (!typeRef || !compiler.isTypeReferenceNode(typeRef)) return undefined
	const typeName = (typeRef as ts.TypeReferenceNode).typeName

	let refSym = checker.getSymbolAtLocation(typeName)
	while (refSym && refSym.flags & compiler.SymbolFlags.Alias) {
		refSym = checker.getAliasedSymbol(refSym)
	}
	if (!refSym) return undefined

	const refDecls = refSym.declarations
	if (!refDecls?.length) return undefined

	const srcFile = refDecls[0].getSourceFile()
	if (!isExportedFromFile(refSym, srcFile, checker)) return undefined

	return `import("${srcFile.fileName}").${refSym.getName()}`
}

type MwPropEntry = { name: string; opt: boolean; type: string }

function extractMiddlewareProps(
	ctxType: ts.Type,
	checker: ts.TypeChecker,
	node: ts.Node,
	compiler: typeof ts,
): MwPropEntry[] {
	const allProps = ctxType.getProperties()
	const mwProps = allProps.filter((p) => {
		const name = p.getName()
		if (HONEY_CTX_PROPS.has(name)) return false
		/* skip internal/private properties (underscore-prefixed) */
		if (name.startsWith("_")) return false
		return true
	})

	return mwProps.map((p) => {
		const t = checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration ?? node)
		const opt = (p.flags & compiler.SymbolFlags.Optional) !== 0

		/* 1. try declaration-site TypeReference (explicit annotation on property or variable) */
		let typeStr: string | undefined
		const mwDecl = p.valueDeclaration ?? p.declarations?.[0]
		typeStr = resolveTypeRefFromDecl(mwDecl, checker, compiler)

		/* 1b. shorthand property — trace to the underlying variable's type annotation */
		if (!typeStr && mwDecl && compiler.isShorthandPropertyAssignment(mwDecl)) {
			const varSym = checker.getShorthandAssignmentValueSymbol(mwDecl)
			if (varSym) {
				const varDecl = varSym.valueDeclaration ?? varSym.declarations?.[0]
				typeStr = resolveTypeRefFromDecl(varDecl, checker, compiler)

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
									typeStr = resolveTypeRefFromDecl(innerDecl, checker, compiler)
								}
							}
						}
					}
				}
			}
		}

		/* 2. try resolved type as named import reference */
		if (!typeStr) {
			typeStr = serializeAsRef(t, checker, node, compiler) ?? undefined
		}

		/* 3. structural fallback */
		if (!typeStr) {
			typeStr = serialize(t, checker, node, compiler)
		}

		return { name: p.getName(), opt, type: typeStr }
	})
}

function extractMiddleware(
	ctxType: ts.Type,
	checker: ts.TypeChecker,
	node: ts.Node,
	compiler: typeof ts,
): string | null {
	const props = extractMiddlewareProps(ctxType, checker, node, compiler)
	if (props.length === 0) return null
	const entries = props.map((p) => `${p.name}${p.opt ? "?" : ""}: ${p.type}`)
	return `{ ${entries.join("; ")} }`
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

/**
 * Attempts to build an `import("path").TypeName` reference for a type.
 * Returns null if the type has no usable named symbol.
 *
 * Prefers compact references over structural expansion:
 * - .d.ts types: import("drizzle-orm/d1").DrizzleD1Database
 * - .ts type aliases: import("./db.orm.gen").CoreDb
 * - globals (Promise, Map, etc.) are skipped — handled by serialize()
 */
function serializeAsRef(
	type: ts.Type,
	checker: ts.TypeChecker,
	node: ts.Node,
	compiler: typeof ts,
	depth = 0,
): string | null {
	if (depth > 6) return null

	/* union with never members (from intersection narrowing) — simplify first */
	if (type.isUnion()) {
		const nonNever = (type as ts.UnionType).types.filter((t) => !(t.flags & compiler.TypeFlags.Never))
		if (nonNever.length === 1) {
			return serializeAsRef(nonNever[0], checker, node, compiler, depth)
		}
	}

	const sym = type.getSymbol() ?? type.aliasSymbol
	if (!sym) return null

	const name = sym.getName()
	if (!name || name.startsWith("__") || name === "Object") return null

	const decls = sym.declarations
	if (!decls?.length) return null

	const sf = decls[0].getSourceFile()
	const fileName = sf.fileName

	/* skip global/lib types — serialize() handles these with its globals set */
	if (fileName.includes("/lib.") || fileName.includes("/lib/")) return null

	const isDts = sf.isDeclarationFile
	const isTypeAlias =
		(sym.flags & compiler.SymbolFlags.TypeAlias) !== 0 || decls.some((d) => compiler.isTypeAliasDeclaration(d))

	/* only reference .d.ts symbols or explicit type aliases from .ts files */
	if (!isDts && !isTypeAlias) return null

	/* skip ambient .d.ts scripts (no exports) — import() can't resolve them */
	if (isDts) {
		const tsSf = sf as unknown as { externalModuleIndicator?: unknown }
		if (!tsSf.externalModuleIndicator) return null
	}

	/* skip non-exported symbols — import() on them resolves to `any` */
	if (!isExportedFromFile(sym, sf, checker)) return null

	/* build type arguments if present */
	const ref = type as ts.TypeReference
	const typeArgs = ref.typeArguments ?? type.aliasTypeArguments
	if (typeArgs?.length) {
		const args = typeArgs.map((arg) => {
			const argRef = serializeAsRef(arg, checker, node, compiler, depth + 1)
			return argRef ?? serialize(arg, checker, node, compiler)
		})
		return `import("${fileName}").${name}<${args.join(", ")}>`
	}

	return `import("${fileName}").${name}`
}

function serialize(type: ts.Type, checker: ts.TypeChecker, node: ts.Node, compiler: typeof ts, depth = 0): string {
	if (depth > 8) return "unknown"

	const next = (t: ts.Type) => serialize(t, checker, node, compiler, depth + 1)

	/* primitives */
	if (type.flags & compiler.TypeFlags.String) return "string"
	if (type.flags & compiler.TypeFlags.Number) return "number"
	if (type.flags & compiler.TypeFlags.Boolean) return "boolean"
	if (type.flags & compiler.TypeFlags.BigInt) return "bigint"
	if (type.flags & compiler.TypeFlags.ESSymbol) return "symbol"
	if (type.flags & compiler.TypeFlags.Void) return "void"
	if (type.flags & compiler.TypeFlags.Undefined) return "undefined"
	if (type.flags & compiler.TypeFlags.Null) return "null"
	if (type.flags & compiler.TypeFlags.Never) return "never"
	if (type.flags & compiler.TypeFlags.Unknown) return "unknown"
	if (type.flags & compiler.TypeFlags.Any) return "unknown"

	/* literals */
	if (type.isStringLiteral()) return `"${(type as ts.StringLiteralType).value}"`
	if (type.isNumberLiteral()) return `${(type as ts.NumberLiteralType).value}`

	/* union */
	if (type.isUnion()) {
		return type.types
			.map((t) => {
				const s = next(t)
				/* parenthesize function types inside unions — TS syntax requires it */
				return s.includes("=>") ? `(${s})` : s
			})
			.join(" | ")
	}

	/* intersection */
	if (type.isIntersection()) return type.types.map(next).join(" & ")

	/* array */
	if (checker.isArrayType(type)) {
		const args = checker.getTypeArguments(type as ts.TypeReference)
		if (args.length > 0) {
			const el = next(args[0])
			return el.includes("|") || el.includes("&") ? `(${el})[]` : `${el}[]`
		}
		return "unknown[]"
	}

	/* tuple */
	if (checker.isTupleType(type)) {
		const args = checker.getTypeArguments(type as ts.TypeReference)
		return `[${args.map(next).join(", ")}]`
	}

	/* function (pure callable, no data properties) */
	const sigs = type.getCallSignatures()
	if (sigs.length > 0 && type.getProperties().length === 0) {
		const sig = sigs[0]
		const params = sig.getParameters().map((p) => {
			const pt = checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration ?? node)
			const decl = p.valueDeclaration
			const isRest =
				decl !== undefined &&
				compiler.isParameter(decl) &&
				(decl as ts.ParameterDeclaration).dotDotDotToken !== undefined
			return `${isRest ? "..." : ""}${p.getName()}: ${next(pt)}`
		})
		const ret = checker.getReturnTypeOfSignature(sig)
		return `(${params.join(", ")}) => ${next(ret)}`
	}

	/* well-known globals — keep name, serialize type args */
	const sym = type.getSymbol()
	if (sym) {
		const name = sym.getName()
		const globals = new Set([
			"AbortController",
			"AbortSignal",
			"ArrayBuffer",
			"Blob",
			"DataView",
			"Date",
			"Error",
			"File",
			"FormData",
			"Headers",
			"Map",
			"Promise",
			"ReadableStream",
			"RegExp",
			"Request",
			"Response",
			"Set",
			"SharedArrayBuffer",
			"TransformStream",
			"URL",
			"URLSearchParams",
			"WeakMap",
			"WeakSet",
			"WritableStream",
		])
		if (globals.has(name)) {
			const ref = type as ts.TypeReference
			if (ref.typeArguments?.length) {
				return `${name}<${ref.typeArguments.map(next).join(", ")}>`
			}
			return name
		}

		/* named types — prefer import() reference over structural expansion */
		if (name && !name.startsWith("__") && name !== "Object") {
			const ref = serializeAsRef(type, checker, node, compiler, 0)
			if (ref) return ref

			/* fallback: typeToString for .d.ts types without clean ref */
			const decls = sym.declarations
			if (decls?.length) {
				const sf = decls[0].getSourceFile()
				if (sf.isDeclarationFile) {
					return checker.typeToString(
						type,
						node,
						compiler.TypeFormatFlags.UseFullyQualifiedType | compiler.TypeFormatFlags.NoTruncation,
					)
				}
			}
		}
	}

	/* Record<string, V> — index signature only */
	const stringIdx = type.getStringIndexType()
	if (stringIdx && type.getProperties().length === 0) {
		return `Record<string, ${next(stringIdx)}>`
	}

	/* object — expand to structural form */
	const props = type.getProperties()
	if (props.length > 50) {
		return checker.typeToString(type, node, compiler.TypeFormatFlags.NoTruncation)
	}
	if (props.length > 0) {
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
			entries.push(`${ro ? "readonly " : ""}${p.getName()}${opt ? "?" : ""}: ${next(pt)}`)
		}
		if (entries.length > 0) return `{ ${entries.join("; ")} }`
	}

	/* fallback */
	return checker.typeToString(type, undefined, compiler.TypeFormatFlags.NoTruncation)
}

/**
 * Converts absolute `import()` paths emitted by `typeToString` into
 * resolvable module specifiers:
 * - node_modules paths → bare package specifiers
 * - project-internal paths → relative from outputDir
 */
function sanitizeImportPaths(str: string, outputDir?: string): string {
	return str.replace(/import\("([^"]+)"\)/g, (_match, filePath: string) => {
		const nmIdx = filePath.lastIndexOf("/node_modules/")
		if (nmIdx !== -1) {
			return `import("${filePath.slice(nmIdx + "/node_modules/".length)}")`
		}
		if (!outputDir) return `import("${filePath}")`
		let rel = relative(outputDir, filePath)
		if (!rel.startsWith(".")) rel = `./${rel}`
		return `import("${rel}")`
	})
}

export type ExtractedChainTypes = {
	base: ExtractedBaseCtx
	/** per-route middleware additions keyed by "method /path" */
	routeMiddleware: Record<string, string>
	/** structured per-property middleware data for sub-type dedup */
	routeMiddlewareProps: Record<string, Array<{ name: string; opt: boolean; type: string }>>
}

const HTTP_METHODS = new Set(["all", "delete", "get", "head", "options", "patch", "post", "put"])

/**
 * Extracts base ctx and per-route middleware additions from sub-chains.
 * Traces HTTP method calls (`.get()`, `.post()`, etc.) back to their
 * Honey instance receiver, computes the ctx diff vs the base export,
 * and returns per-route additions keyed by "method /path".
 */
export async function extractChainTypes(options: {
	entryPath: string
	exportName: string
	outputDir?: string
	tsconfigPath?: string
}): Promise<ExtractedChainTypes> {
	const { Project, ts } = await import("ts-morph")

	const tsConfigFilePath = options.tsconfigPath ?? findTsConfig(options.entryPath)

	const project = new Project({
		skipAddingFilesFromTsConfig: true,
		tsConfigFilePath,
	})

	project.addSourceFilesAtPaths(options.entryPath)
	project.resolveSourceFileDependencies()

	const sourceFile = project.getSourceFileOrThrow(options.entryPath)
	const baseVarDecl = sourceFile.getVariableDeclaration(options.exportName)
	if (!baseVarDecl) {
		throw new Error(`Export "${options.exportName}" not found in ${options.entryPath}`)
	}

	function bridge<T>(value: unknown): T {
		return value as T
	}
	const checker: ts.TypeChecker = bridge(project.getTypeChecker().compilerObject)
	const baseNode: ts.Node = bridge(baseVarDecl.compilerNode)
	const tsLib: typeof ts = bridge(ts)

	function getCtxType(tsType: ts.Type, locationNode?: ts.Node): ts.Type | null {
		const sym = tsType.getProperty("$ctx")
		if (!sym) return null
		return checker.getTypeOfSymbolAtLocation(sym, locationNode ?? sym.valueDeclaration ?? baseNode)
	}

	/* extract base ctx */
	const baseType = bridge<ts.Type>(baseVarDecl.getType().compilerType)
	let envType = "Record<string, unknown>"
	const envSym = baseType.getProperty("$env")
	if (envSym) {
		envType = serialize(checker.getTypeOfSymbolAtLocation(envSym, baseNode), checker, baseNode, tsLib)
	}

	const baseCtxType = getCtxType(baseType)
	if (!baseCtxType) {
		throw new Error(`Export "${options.exportName}" has no $ctx — not a Honey instance`)
	}
	const baseMwProps = extractMiddlewareProps(baseCtxType, checker, baseNode, tsLib)
	const baseMiddlewareType =
		baseMwProps.length === 0
			? null
			: `{ ${baseMwProps.map((p) => `${p.name}${p.opt ? "?" : ""}: ${p.type}`).join("; ")} }`

	/* build name→type map for reusing base type references in route middleware */
	const basePropTypeByName = new Map<string, string>()
	for (const p of baseMwProps) {
		basePropTypeByName.set(p.name, p.type)
	}

	/* collect base middleware property names for diffing */
	const baseMwPropNames = new Set<string>()
	for (const p of baseCtxType.getProperties()) {
		const name = p.getName()
		if (!HONEY_CTX_PROPS.has(name) && !name.startsWith("_")) {
			baseMwPropNames.add(name)
		}
	}

	const sanitize = (s: string) => sanitizeImportPaths(s, options.outputDir)

	/* scan for route-defining calls: <expr>.<httpMethod>(<pathLiteral>) */
	const routeMiddleware: Record<string, string> = {}
	const routeMiddlewareProps: Record<string, Array<{ name: string; opt: boolean; type: string }>> = {}
	const compilerSourceFile: ts.SourceFile = bridge(sourceFile.compilerNode)

	function visitNode(node: ts.Node): void {
		if (tsLib.isCallExpression(node) && tsLib.isPropertyAccessExpression(node.expression)) {
			const methodName = node.expression.name.text
			if (HTTP_METHODS.has(methodName) && node.arguments.length > 0) {
				const pathArg = node.arguments[0]
				if (tsLib.isStringLiteral(pathArg)) {
					const path = pathArg.text
					/* get the type of the receiver (the expression before .get/.post/etc.) */
					const receiverExpr = node.expression.expression
					const receiverType = checker.getTypeAtLocation(receiverExpr)
					const ctxType = getCtxType(receiverType, receiverExpr)

					if (ctxType) {
						/* extract extra middleware props by iterating intersection MEMBERS individually.
						 * This preserves source-level declarations (e.g. ShorthandPropertyAssignment)
						 * that get lost when extracting from the flattened intersection. */
						const extraEntries: MwPropEntry[] = []
						const dupeNames = new Set<string>()
						const members = ctxType.isIntersection() ? (ctxType as ts.IntersectionType).types : [ctxType]
						for (const member of members) {
							const memberProps = extractMiddlewareProps(member, checker, baseNode, tsLib)
							for (const rp of memberProps) {
								if (baseMwPropNames.has(rp.name)) continue
								if (extraEntries.some((e) => e.name === rp.name)) {
									dupeNames.add(rp.name)
									continue
								}
								extraEntries.push(rp)
							}
						}
						/* for properties that appeared in multiple intersection members
						 * (e.g. auth narrowed by a later middleware), resolve from the
						 * flattened intersection so TypeScript computes the correct
						 * intersected type instead of using the first member's type */
						for (const dupeName of dupeNames) {
							const sym = ctxType.getProperty(dupeName)
							if (!sym) continue
							const t = checker.getTypeOfSymbolAtLocation(sym, sym.valueDeclaration ?? baseNode)
							const typeStr = serializeAsRef(t, checker, baseNode, tsLib) ?? serialize(t, checker, baseNode, tsLib)
							const idx = extraEntries.findIndex((e) => e.name === dupeName)
							if (idx !== -1) {
								extraEntries[idx] = { ...extraEntries[idx], type: typeStr }
							}
						}

						if (extraEntries.length > 0) {
							/* reuse compact base type references when the route has the same property
							 * (e.g. shardDb: ShardDb from base → reuse import ref instead of structural expansion) */
							const entries = extraEntries.map((e) => {
								const baseRef = basePropTypeByName.get(e.name)
								if (baseRef && baseRef.length < e.type.length) {
									return { ...e, type: baseRef }
								}
								return e
							})

							const key = `${methodName} ${path}`
							routeMiddleware[key] = sanitize(
								`{ ${entries.map((e) => `${e.name}${e.opt ? "?" : ""}: ${e.type}`).join("; ")} }`,
							)
							routeMiddlewareProps[key] = entries.map((e) => ({
								name: e.name,
								opt: e.opt,
								type: sanitize(e.type),
							}))
						}
					}
				}
			}
		}

		tsLib.forEachChild(node, visitNode)
	}

	visitNode(compilerSourceFile)

	/* extract $taps */
	let tapsType: string | null = null
	const tapsSym = baseType.getProperty("$taps")
	if (tapsSym) {
		const tapsT = checker.getTypeOfSymbolAtLocation(tapsSym, baseNode)
		const tapsStr = serialize(tapsT, checker, baseNode, tsLib)
		if (tapsStr !== "{}" && tapsStr !== "Record<string, unknown>") {
			tapsType = tapsStr
		}
	}

	return {
		base: {
			envType: sanitize(envType),
			middlewareType: baseMiddlewareType ? sanitize(baseMiddlewareType) : null,
			tapsType: tapsType ? sanitize(tapsType) : null,
		},
		routeMiddleware,
		routeMiddlewareProps,
	}
}
