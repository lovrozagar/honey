/* The logger is the one console owner (00-rules "Gates"): every other line logs through it, so
 * the level check, the redaction and the sink choice live in one place. */
const LOGGER = "/packages/core/src/telemetry/logger.ts"

function inScope(filename) {
	const file = String(filename).replaceAll("\\", "/")
	if (file.endsWith(LOGGER) || /\.test\.[cm]?[jt]sx?$/.test(file)) return false
	return file.includes("/packages/core/src/") || file.includes("/packages/gen/src/")
}

export const rule = {
	create(context) {
		if (!inScope(context.filename)) return {}
		return {
			MemberExpression(node) {
				if (node.object.type !== "Identifier" || node.object.name !== "console") return
				context.report({ message: "console belongs to telemetry/logger.ts; log through the logger", node })
			},
		}
	},
}

export default {
	meta: { name: "honey" },
	rules: { "no-console": rule },
}
