import { describe, expect, it } from "vitest"
import plugin from "./no-console.js"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

const rule = plugin.rules["no-console"]
const MESSAGE = "console belongs to telemetry/logger.ts; log through the logger"

describe("honey/no-console", () => {
	it("rejects console in core and gen source", () => {
		const fixture = {
			"packages/core/src/routing/app.ts": 'console.log("x")\n',
			"packages/core/src/middleware/cors.ts": 'export const f = () => console["warn"]("x")\n',
			"packages/gen/src/cli.ts": "export const out = console.error\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/routing/app.ts", message: MESSAGE },
			{ file: "packages/core/src/middleware/cors.ts", message: MESSAGE },
			{ file: "packages/gen/src/cli.ts", message: MESSAGE },
		])
	})

	it("allows the logger, tests, and code outside the packages' src", () => {
		const fixture = {
			"packages/core/src/telemetry/logger.ts": 'export const log = () => console.info("x")\n',
			"packages/core/src/routing/app.test.ts": 'console.log("x")\n',
			"packages/core/tests/integration/routing.test.ts": 'console.log("x")\n',
			"bench/src/hotpath.ts": 'console.table("x")\n',
			"packages/core/src/routing/match.ts": "const logger = { console: 1 }\nexport const n = logger.console\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("fails oxlint through the honey plugin entry", () => {
		const fixture = {
			"packages/core/src/routing/app.ts": 'console.log("x")\n',
			"packages/core/src/telemetry/logger.ts": 'console.log("x")\n',
		}
		expect(oxlintReports("no-console", fixture)).toEqual([
			{ file: "packages/core/src/routing/app.ts", message: MESSAGE },
		])
	})
})
