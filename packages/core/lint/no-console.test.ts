/**
 * honey/no-console (bit 20 scope): every file under packages/core/{src,tests,lint} and packages/gen/{src,tests},
 * tests, fixtures and helpers included, logs through telemetry/logger.ts; only the logger and the scripts whose stdout
 * is their protocol, each by exact path, may touch console. A console call inside a string is no member expression.
 */
import { describe, expect, it } from "vitest"
import plugin, { PROTOCOL } from "./no-console.js"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

const rule = plugin.rules["no-console"]
const MESSAGE = "console belongs to telemetry/logger.ts; log through the logger"
const LOG = 'console.log("x")\n'

describe("honey/no-console", () => {
	it("rejects console in core and gen source", () => {
		const fixture = {
			"packages/core/src/routing/app.ts": LOG,
			"packages/core/src/middleware/cors.ts": 'export const f = () => console["warn"]("x")\n',
			"packages/gen/src/cli.ts": "export const out = console.error\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/routing/app.ts", message: MESSAGE },
			{ file: "packages/core/src/middleware/cors.ts", message: MESSAGE },
			{ file: "packages/gen/src/cli.ts", message: MESSAGE },
		])
	})

	it("rejects console in a test file, wherever it lives in scope", () => {
		const fixture = {
			"packages/core/src/build/source.test.ts": LOG,
			"packages/core/tests/integration/routing.test.ts": LOG,
			"packages/core/lint/boundaries.test.ts": LOG,
			"packages/gen/src/cli.app.test.ts": LOG,
			"packages/gen/tests/integration/codegen-bin.test.ts": LOG,
		}
		expect(reportsOf(rule, fixture).map((report) => report.file)).toEqual(Object.keys(fixture))
	})

	it("rejects console in a fixture or a helper", () => {
		const fixture = {
			"packages/core/src/build/__fixtures__/project.ts": LOG,
			"packages/gen/src/ir/__fixtures__/app-project.ts": LOG,
			"packages/core/tests/e2e/apps/kitchen/tests/e2e/helpers.ts": LOG,
			"packages/core/tests/integration/support/server.ts": LOG,
			"packages/gen/tests/integration/conformance/harness.ts": LOG,
		}
		expect(reportsOf(rule, fixture).map((report) => report.file)).toEqual(Object.keys(fixture))
	})
})

describe("honey/no-console: what stays allowed", () => {
	it("allows the same call inside a string a test spawns, and a property named console", () => {
		const fixture = {
			"packages/core/src/build/cli.test.ts": 'export const child = "console.log(process.pid)"\n',
			"packages/gen/src/cli.app.test.ts": "export const child = `console.error(${1})`\n",
			"packages/core/src/routing/match.ts": "const logger = { console: 1 }\nexport const n = logger.console\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("allows the logger, each script whose stdout is its protocol, and code outside the scope", () => {
		const fixture = Object.fromEntries([
			["packages/core/src/telemetry/logger.ts", 'export const log = () => console.info("x")\n'],
			...[...PROTOCOL.keys()].map((path) => [path, LOG]),
			["bench/src/hotpath.ts", 'console.table("x")\n'],
			["packages/gen/scripts/build.ts", LOG],
		])
		expect([PROTOCOL.size, reportsOf(rule, fixture)]).toEqual([7, []])
	})

	it("rejects an unlisted file with an exemption's code: beside it, or a copy of its path nested deeper", () => {
		const fixture = {
			"packages/core/tests/integration/proxy-upstream/other.ts": LOG,
			"packages/core/tests/e2e/run.ts": LOG,
			"packages/gen/tests/integration/conformance/gate.test.ts": LOG,
			"packages/gen/tests/fixtures/packages/core/tests/e2e/run-build.ts": LOG,
		}
		expect(reportsOf(rule, fixture).map((report) => report.file)).toEqual(Object.keys(fixture))
	})

	it("fails oxlint through the honey plugin entry", () => {
		const fixture = {
			"packages/core/src/routing/app.ts": LOG,
			"packages/core/src/telemetry/logger.ts": LOG,
			"packages/core/tests/e2e/run-build.ts": LOG,
			"packages/gen/tests/integration/conformance/helper.ts": LOG,
		}
		expect(oxlintReports("no-console", fixture)).toEqual([
			{ file: "packages/core/src/routing/app.ts", message: MESSAGE },
			{ file: "packages/gen/tests/integration/conformance/helper.ts", message: MESSAGE },
		])
	})
})
