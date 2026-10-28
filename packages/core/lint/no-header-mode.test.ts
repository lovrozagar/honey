import { describe, expect, it } from "vitest"
import plugin from "./no-header-mode.js"
import { oxlintReports, reportsOf } from "./rule-harness.ts"
import { SPAWN_TIMEOUT } from "../tests/fixture/spawn-timeout.ts"

const rule = plugin.rules["no-header-mode"]
const MESSAGE = "a request header never selects an internal mode: do not read a honey-namespaced header (H19.7)"

describe("honey/no-header-mode", () => {
	it("rejects reading a honey-namespaced header, however it is spelled", () => {
		const fixture = {
			"packages/core/src/routing/dispatch.ts":
				'export const f = (req: Request) => req.headers.get("x-honey-debug") === "1"\n',
			"packages/core/src/response/builder.ts": "export const f = (h: Headers) => h.has('Honey-Mode')\n",
			"packages/core/src/middleware/cors.ts": "export const f = (h: Headers) => h.get(`X-HONEY-TRACE`)\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/routing/dispatch.ts", message: MESSAGE },
			{ file: "packages/core/src/response/builder.ts", message: MESSAGE },
			{ file: "packages/core/src/middleware/cors.ts", message: MESSAGE },
		])
	})

	it("allows standard headers, configured names, response writes, tests and the SDKs", () => {
		const fixture = {
			"packages/core/src/routing/dispatch.ts": [
				'export const a = (h: Headers) => h.get("accept") ?? h.get("x-forwarded-for") ?? h.get("x-request-id")',
				"export const b = (h: Headers, name: string) => h.get(name)",
				'export const c = (h: Headers) => h.set("x-honey-version", "1")',
				'export const d = (m: Map<string, number>) => m.get("honeycomb")',
				"",
			].join("\n"),
			"packages/core/src/routing/dispatch.test.ts": 'export const f = (h: Headers) => h.get("x-honey-debug")\n',
			"packages/gen/src/emit/ts/response.ts": 'export const f = (h: Headers) => h.get("x-honey-version")\n',
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("fails oxlint through the honey plugin entry", { timeout: SPAWN_TIMEOUT }, () => {
		const fixture = {
			"packages/core/src/a.ts": 'export const f = (h: Headers) => h.get("x-honey-debug")\n',
			"packages/core/src/b.ts": 'export const f = (h: Headers) => h.get("accept")\n',
		}
		expect(oxlintReports("no-header-mode", fixture)).toEqual([{ file: "packages/core/src/a.ts", message: MESSAGE }])
	})
})
