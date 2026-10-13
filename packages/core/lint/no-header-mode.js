/* H19.7: a client controls every request header, so a header that switches honey into another mode
 * (debug output, a bypass, a format) is a switch an attacker can flip. The server reads standard
 * headers and names the app configured, never one in honey's own namespace. */
const MESSAGE = "a request header never selects an internal mode: do not read a honey-namespaced header (H19.7)"

const HONEY_HEADER = /^(?:x-)?honey-/i
const READS = new Set(["get", "has"])

function inScope(filename) {
	const file = String(filename).replaceAll("\\", "/")
	if (/\.test\.[cm]?[jt]sx?$/.test(file)) return false
	return file.includes("/packages/core/src/")
}

function literalText(node) {
	if (node?.type === "Literal" && typeof node.value === "string") return node.value
	if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked
	return null
}

export const rule = {
	create(context) {
		if (!inScope(context.filename)) return {}
		return {
			CallExpression(node) {
				const callee = node.callee
				if (callee?.type !== "MemberExpression" || callee.computed || !READS.has(callee.property.name)) return
				const header = literalText(node.arguments[0])
				if (header !== null && HONEY_HEADER.test(header)) context.report({ message: MESSAGE, node })
			},
		}
	},
}

export default {
	meta: { name: "honey" },
	rules: { "no-header-mode": rule },
}
