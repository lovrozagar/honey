/**
 * The program an app is read from: its tsconfig, the exported app, and every route registration in
 * the program's own files. A registration is a `.handler()` call on a route builder, recognized by
 * the type-only `$ctx`, `$method` and `$path` it carries, whatever method or helper started it.
 */
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type { Project, ts } from "ts-morph"
import { compareCodeUnits } from "../emit/shared/lang.ts"
import type { Compiler } from "./serialize.ts"

/** ts-morph, passed in by the caller: an optional peer this package never imports. */
export type TsMorph = typeof import("ts-morph")

export type EntryOptions = {
	entryPath: string
	exportName: string
	/** the tsconfig to read the project with; else the nearest one (`findTsConfig`) */
	tsconfigPath?: string
}

export type LoadedEntry = {
	/** the app's type */
	appType: ts.Type
	checker: ts.TypeChecker
	compiler: Compiler
	project: Project
}

/* the type-only members every route builder carries */
const BUILDER_MEMBERS = ["$ctx", "$method", "$path"]

/** One route a `.handler()` call registers: where, its methods, its full path (null if not a literal) and its ctx. */
export type Registration = {
	at: string
	ctx: ts.Type
	/** `ctx.input` as the handler receives it (parsed), or null when the route declares no input */
	input: ts.Type | null
	methods: string[]
	path: string | null
}

/**
 * The tsconfig that governs `fromPath`: the nearest one walking up, but never past the project root
 * (the nearest directory with a package.json); a stray tsconfig above it is not this project's.
 */
export function findTsConfig(fromPath: string): string | undefined {
	for (let dir = dirname(resolve(fromPath)), prev = ""; dir !== prev; prev = dir, dir = dirname(dir)) {
		if (existsSync(resolve(dir, "tsconfig.json"))) return resolve(dir, "tsconfig.json")
		if (existsSync(resolve(dir, "package.json"))) return undefined
	}
	return undefined
}

/** Load the entry and its app: `export const app`, an export list, an unexported declaration of the name, or `export default`. */
export function loadEntry(tsMorph: TsMorph, options: EntryOptions): LoadedEntry {
	const project = new tsMorph.Project({
		skipAddingFilesFromTsConfig: true,
		tsConfigFilePath: options.tsconfigPath ?? findTsConfig(options.entryPath),
	})
	project.addSourceFilesAtPaths(options.entryPath)
	project.resolveSourceFileDependencies()
	const file = project.getSourceFileOrThrow(options.entryPath)
	const decl =
		file.getExportedDeclarations().get(options.exportName)?.[0] ?? file.getVariableDeclaration(options.exportName)
	if (decl === undefined) throw new Error(`Export "${options.exportName}" not found in ${options.entryPath}`)
	const checker = project.getTypeChecker().compilerObject
	/* for `export default <expr>` the declaration is the expression itself */
	return { appType: checker.getTypeAtLocation(decl.compilerNode), checker, compiler: tsMorph.ts, project }
}

/** The string literal values among `type` (itself, or a union's members). */
function literals(type: ts.Type): string[] {
	return (type.isUnion() ? type.types : [type]).filter((t) => t.isStringLiteral()).map((t) => t.value)
}

/** The registration a call is, if it is `<route builder>.handler(…)`. */
function registrationOf(entry: LoadedEntry, call: ts.CallExpression): Registration | null {
	const { checker, compiler } = entry
	if (!compiler.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "handler") return null
	const receiver = call.expression.expression
	const builder = checker.getTypeAtLocation(receiver)
	const phantoms = BUILDER_MEMBERS.map((name) => {
		const sym = builder.getProperty(name)
		return sym === undefined ? undefined : checker.getTypeOfSymbol(sym)
	})
	if (phantoms.includes(undefined)) return null
	const [ctx, method, path] = phantoms as ts.Type[]
	/* the handler callback's ctx parameter carries `input`, which the builder's `$ctx` phantom leaves out */
	const handler = checker.getResolvedSignature(call)?.parameters[0]
	const param = handler && checker.getTypeOfSymbol(handler).getCallSignatures()[0]?.parameters[0]
	const input = param && checker.getTypeOfSymbol(param).getProperty("input")
	const file = call.getSourceFile()
	const line = file.getLineAndCharacterOfPosition(call.getStart(file)).line + 1
	const paths = literals(path as ts.Type)
	return {
		at: `${file.fileName}:${line}`,
		ctx: ctx as ts.Type,
		input: input ? checker.getTypeOfSymbol(input) : null,
		/* `.on()`'s methods are literals by its signature; a path is one only as a single literal */
		methods: literals(method as ts.Type),
		path: paths.length === 1 && !(path as ts.Type).isUnion() ? (paths[0] as string) : null,
	}
}

/** Every route the program's own files register (not declaration files, not packages), in file order then source order. */
export function registrations(entry: LoadedEntry): Registration[] {
	const { compiler } = entry
	const out: Registration[] = []
	const visit = (node: ts.Node): void => {
		const found = compiler.isCallExpression(node) ? registrationOf(entry, node) : null
		if (found !== null) out.push(found)
		compiler.forEachChild(node, visit)
	}
	const files = entry.project
		.getSourceFiles()
		.map((file) => file.compilerNode)
		.filter((file) => !file.isDeclarationFile && !/[\\/]node_modules[\\/]/.test(file.fileName))
		.sort((a, b) => compareCodeUnits(a.fileName, b.fileName))
	for (const file of files) visit(file)
	return out
}
