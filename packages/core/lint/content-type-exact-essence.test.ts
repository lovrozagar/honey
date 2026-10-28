import { describe, expect, it } from "vitest"
import plugin from "./content-type-exact-essence.js"
import { oxlintReports, reportsOf } from "./rule-harness.ts"
import { SPAWN_TIMEOUT } from "../tests/fixture/spawn-timeout.ts"

const rule = plugin.rules["content-type-exact-essence"]
const MESSAGE = "compare a media type by its parsed essence, never by prefix (H18.2)"

describe("honey/content-type-exact-essence", () => {
	it("rejects a prefix test against a media-type literal", () => {
		const fixture = {
			"packages/core/src/a.ts": 'export const f = (ct: string) => ct.startsWith("application/json")\n',
			"packages/core/src/b.ts": "export const f = (t: string) => t.startsWith('text/')\n",
			"packages/gen/src/c.ts": "export const f = (m: string) => m.startsWith(`multipart/form-data`)\n",
			"packages/core/src/d.ts": 'export const f = (h: Headers) => h.get("content-type")?.startsWith("image/")\n',
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/a.ts", message: MESSAGE },
			{ file: "packages/core/src/b.ts", message: MESSAGE },
			{ file: "packages/gen/src/c.ts", message: MESSAGE },
			{ file: "packages/core/src/d.ts", message: MESSAGE },
		])
	})

	it("rejects a prefix test on a value named for a media type", () => {
		const fixture = {
			"packages/core/src/a.ts": "export const f = (contentType: string, p: string) => contentType.startsWith(p)\n",
			"packages/core/src/b.ts": "export const f = (o: { mediaType: string }, p: string) => o.mediaType.startsWith(p)\n",
			"packages/core/src/c.ts": "export const f = (mime: string, p: string) => mime.startsWith(p)\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "packages/core/src/a.ts", message: MESSAGE },
			{ file: "packages/core/src/b.ts", message: MESSAGE },
			{ file: "packages/core/src/c.ts", message: MESSAGE },
		])
	})

	it("allows exact comparison, unrelated prefixes, tests and code outside src", () => {
		const fixture = {
			"packages/core/src/a.ts": 'export const f = (essence: string) => essence === "application/json"\n',
			"packages/core/src/b.ts":
				'export const f = (path: string) => path.startsWith("/api/") || path.startsWith("http://")\n',
			"packages/core/src/c.ts": 'export const f = (s: string) => s.startsWith("Bearer ")\n',
			"packages/core/src/a.test.ts": 'export const f = (ct: string) => ct.startsWith("text/")\n',
			"bench/src/hotpath.ts": 'export const f = (ct: string) => ct.startsWith("text/")\n',
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("fails oxlint through the honey plugin entry", { timeout: SPAWN_TIMEOUT }, () => {
		const fixture = {
			"packages/core/src/a.ts": 'export const f = (ct: string) => ct.startsWith("application/json")\n',
			"packages/core/src/b.ts": 'export const f = (ct: string) => ct === "application/json"\n',
		}
		expect(oxlintReports("content-type-exact-essence", fixture)).toEqual([
			{ file: "packages/core/src/a.ts", message: MESSAGE },
		])
	})
})
