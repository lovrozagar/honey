/* The logger is the one console owner (00-rules "Gates"): every other line logs through it, so the level check, the
 * redaction and the sink choice live in one place. Tests were excluded at bit 00 without a recorded reason; a stray
 * log landed in source.test (caa906b); scope widened at bit 20 to every file under packages/core/{src,tests,lint} and
 * packages/gen/{src,tests}: tests, fixtures and helpers alike. A console call inside a string a test spawns is no
 * member expression and stays allowed. */
const LOGGER = "packages/core/src/telemetry/logger.ts"

/* The scripts whose stdout is their protocol, each by exact path with its reason; any other file is fixed instead. */
export const PROTOCOL = new Map([
	["packages/core/tests/integration/proxy-upstream/server.ts", "prints the port the parent test reads"],
	["packages/core/tests/integration/proxy-upstream/upstream.mjs", "prints the port the parent test reads"],
	["packages/gen/tests/integration/conformance/gate.ts", "a CLI gate: its verdict is its output"],
	["packages/core/tests/e2e/run-build.ts", "test:build's CLI runner: its per-target report is its output"],
	["packages/core/tests/e2e/run-strict-consumer.ts", "test:packaging's CLI runner: its diagnostics are its output"],
	["packages/core/tests/e2e/cf-workers/scripts/live-smoke.ts", "test:live's CLI soak: its timings are its output"],
	["packages/core/tests/e2e/cf-workers/scripts/options-tail.ts", "a CLI timing tool: the slowest preflights printed"],
])

/* every file under packages/core/{src,tests,lint} and packages/gen/{src,tests} */
const SCOPE = /\/(packages\/(?:core\/(?:src|tests|lint)|gen\/(?:src|tests))\/.*)$/

function inScope(filename) {
	/* the repo path from the first in-scope segment: an exemption is that exact path, never a copy nested deeper */
	const path = SCOPE.exec(`/${String(filename).replaceAll("\\", "/")}`)?.[1]
	return path !== undefined && path !== LOGGER && !PROTOCOL.has(path)
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
