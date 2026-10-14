/* H19.3: request state lives on the request context. A module-scope let, var or constructed
 * object outlives the request and leaks between requests, so it needs one of the reasons the
 * blueprint allows, written on its line or the line above. */
const REASON = /^per-process-constant:\s*(?:raw-body|text-codec|rate-limit-store|i18n-dict|build-id|feature-slot)\b/

const MESSAGE =
	"module-scope state needs `// per-process-constant: <reason>` with an allowlisted reason (raw-body, text-codec, rate-limit-store, i18n-dict, build-id, feature-slot)"

const WRAPPERS = new Set(["ParenthesizedExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression"])

function inScope(filename) {
	const file = String(filename).replaceAll("\\", "/")
	if (/\.test\.[cm]?[jt]sx?$/.test(file)) return false
	return file.includes("/packages/core/src/") || file.includes("/packages/gen/src/")
}

function unwrap(node) {
	let current = node
	while (current !== null && current !== undefined && WRAPPERS.has(current.type)) current = current.expression
	return current
}

function isState(declaration) {
	if (declaration.kind !== "const") return true
	return declaration.declarations.some((d) => unwrap(d.init)?.type === "NewExpression")
}

function allowed(context, statement) {
	const text = context.sourceCode.getText()
	const before = context.sourceCode.getCommentsBefore(statement)
	const sameLine = context.sourceCode
		.getCommentsAfter(statement)
		.filter((comment) => !text.slice(statement.end, comment.start).includes("\n"))
	return [...before, ...sameLine].some((comment) => REASON.test(comment.value.trim()))
}

export const rule = {
	create(context) {
		if (!inScope(context.filename)) return {}
		return {
			VariableDeclaration(node) {
				const statement = node.parent?.type === "ExportNamedDeclaration" ? node.parent : node
				if (statement.parent?.type !== "Program" || !isState(node)) return
				if (allowed(context, statement)) return
				context.report({ message: MESSAGE, node })
			},
		}
	},
}

export default {
	meta: { name: "honey" },
	rules: { "no-module-state": rule },
}
