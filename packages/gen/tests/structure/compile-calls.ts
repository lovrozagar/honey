/**
 * Which module a call resolves to (the toolchain tests' stray-compile legs): every language names its any-fixture
 * compile `compiledFixture`, so a leg judges a call by the module its name is bound to, never by the name's text.
 */
import { dirname, join } from "node:path"
import { ts } from "ts-morph"

/** What a file's top-level statements bind `name` to: local names and namespaces to modules, and re-exports. */
type Bindings = {
	readonly bound: Map<string, string>
	readonly reexported: string[]
	readonly spaces: Map<string, string>
}

/** Whether an import or export specifier names `name` (as imported, whatever it is bound to). */
const names = (element: ts.ImportSpecifier | ts.ExportSpecifier, name: string) =>
	(element.propertyName ?? element.name).text === name

/** The gen-relative module a statement of gen-relative `file` imports or re-exports from; undefined for a package or none. */
function moduleOf(file: string, statement: ts.Statement): string | undefined {
	const spec = (statement as { readonly moduleSpecifier?: ts.Expression }).moduleSpecifier
	if (spec === undefined || !ts.isStringLiteral(spec) || !spec.text.startsWith(".")) return undefined
	return join(dirname(file), spec.text)
}

/** `statement`'s import or re-export of `name` from `module`, recorded into `into`. */
function bind(statement: ts.Statement, module: string, name: string, into: Bindings): void {
	if (ts.isExportDeclaration(statement)) {
		const clause = statement.exportClause
		const all = clause === undefined || (ts.isNamedExports(clause) && clause.elements.some((e) => names(e, name)))
		if (all) into.reexported.push(module)
	}
	const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined
	if (bindings === undefined) return
	if (ts.isNamespaceImport(bindings)) into.spaces.set(bindings.name.text, module)
	else for (const element of bindings.elements) if (names(element, name)) into.bound.set(element.name.text, module)
}

/** The module a call expression's callee resolves `name` to, under `at`'s bindings; undefined for any other call. */
function callee(node: ts.CallExpression, name: string, at: Bindings): string | undefined {
	const target = node.expression
	if (ts.isIdentifier(target)) return at.bound.get(target.text)
	if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) && target.name.text === name)
		return at.spaces.get(target.expression.text)
	return undefined
}

/**
 * The gen-relative modules whose export `name` the source `text` of gen-relative `file` calls or re-exports, once
 * per call: bound by a named or aliased import, reached through a namespace import, or re-exported (`export *`
 * included); `file` itself for its own declaration. A bare mention binds nothing.
 */
export function callsOf(file: string, text: string, name: string): string[] {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
	const at: Bindings = { bound: new Map(), reexported: [], spaces: new Map() }
	for (const statement of source.statements) {
		if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) at.bound.set(name, file)
		const module = moduleOf(file, statement)
		if (module !== undefined) bind(statement, module, name, at)
	}
	const found = [...at.reexported]
	const visit = (node: ts.Node): void => {
		const module = ts.isCallExpression(node) ? callee(node, name, at) : undefined
		if (module !== undefined) found.push(module)
		ts.forEachChild(node, visit)
	}
	visit(source)
	return found
}
