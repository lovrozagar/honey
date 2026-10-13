/* H18.2: `ct.startsWith("application/json")` also accepts `application/json5`, and a prefix on a
 * raw header ignores parameters and case. Media types are parsed to their essence and compared
 * exactly, so a prefix test on one is always the bug. */
const MESSAGE = "compare a media type by its parsed essence, never by prefix (H18.2)"

/* `type/` or `type/subtype`: a token, a slash, then token characters */
const MEDIA_TYPE = /^[a-z][\w!#$&^.+-]*\/[\w!#$&^.+-]*$/i
const MEDIA_NAME = /content-?type|media-?type|mime|^accepts?$|essence/i

function inScope(filename) {
	const file = String(filename).replaceAll("\\", "/")
	if (/\.test\.[cm]?[jt]sx?$/.test(file)) return false
	return file.includes("/packages/core/src/") || file.includes("/packages/gen/src/")
}

function literalText(node) {
	if (node?.type === "Literal" && typeof node.value === "string") return node.value
	if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked
	return null
}

function nameOf(node) {
	if (node?.type === "Identifier") return node.name
	if (node?.type === "MemberExpression" && !node.computed) return node.property.name
	return null
}

function isStartsWith(callee) {
	if (callee?.type !== "MemberExpression") return false
	return callee.computed ? literalText(callee.property) === "startsWith" : callee.property.name === "startsWith"
}

export const rule = {
	create(context) {
		if (!inScope(context.filename)) return {}
		return {
			CallExpression(node) {
				if (!isStartsWith(node.callee)) return
				const prefix = literalText(node.arguments[0])
				const receiver = nameOf(node.callee.object)
				const mediaPrefix = prefix !== null && MEDIA_TYPE.test(prefix)
				const mediaReceiver = receiver !== null && MEDIA_NAME.test(receiver)
				if (mediaPrefix || mediaReceiver) context.report({ message: MESSAGE, node })
			},
		}
	},
}

export default {
	meta: { name: "honey" },
	rules: { "content-type-exact-essence": rule },
}
