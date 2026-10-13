import { describe, expect, it } from "vitest"
import { WATCH_IGNORE_RE, matchesGlob } from "../../../src/glob.ts"

const ROOT = "/project"
const m = (file: string, ...patterns: string[]) => matchesGlob(`${ROOT}/${file}`, patterns, ROOT)

describe("watch glob matching", () => {
	it("src/** matches every file under src, at any depth", () => {
		expect(m("src/a.ts", "src/**")).toBe(true)
		expect(m("src/routes/users/get.ts", "src/**")).toBe(true)
		expect(m("lib/a.ts", "src/**")).toBe(false)
	})

	it("src/routes/** matches nested files", () => {
		expect(m("src/routes/a.ts", "src/routes/**")).toBe(true)
		expect(m("src/routes/v1/a.ts", "src/routes/**")).toBe(true)
	})

	it("brace alternation", () => {
		expect(m("src/a.tsx", "src/**/*.{ts,tsx}")).toBe(true)
		expect(m("src/x/a.ts", "src/**/*.{ts,tsx}")).toBe(true)
		expect(m("src/x/a.js", "src/**/*.{ts,tsx}")).toBe(false)
	})

	it("a leading ./ is ignored", () => {
		expect(m("src/a.ts", "./src/**/*.ts")).toBe(true)
	})

	it("is anchored at the project root", () => {
		expect(m("node_modules/x/src/a.ts", "src/**/*.ts")).toBe(false)
		expect(m("packages/app/src/a.ts", "src/**/*.ts")).toBe(false)
	})

	it("never matches outside the root", () => {
		expect(matchesGlob("/elsewhere/src/a.ts", ["src/**", "**"], ROOT)).toBe(false)
	})

	it("* and ? stay within one segment; classes work", () => {
		expect(m("src/a.ts", "src/*.ts")).toBe(true)
		expect(m("src/x/a.ts", "src/*.ts")).toBe(false)
		expect(m("src/a1.ts", "src/a?.ts")).toBe(true)
		expect(m("src/a1.ts", "src/a[0-9].ts")).toBe(true)
		expect(m("src/ab.ts", "src/a[!0-9].ts")).toBe(true)
		expect(m("src/a1.ts", "src/a[!0-9].ts")).toBe(false)
	})

	it("regex metacharacters in names are literal", () => {
		expect(m("src/a+b.ts", "src/a+b.ts")).toBe(true)
		expect(m("src/aab.ts", "src/a+b.ts")).toBe(false)
	})
})

describe("WATCH_IGNORE_RE", () => {
	/* creating the _gen directory fires a watch event for the bare directory path; before the CLI
	 * armed its watcher ahead of the first generation that event was never seen */
	it.each([
		"/app/src/_gen",
		"/app/src/_gen/routes.gen.ts",
		"/app/src/routes.gen.ts",
		"/app/src/routes.gen.ts.ab12cd.tmp",
		"/app/node_modules/x/index.ts",
	])("ignores %s", (path) => {
		expect(WATCH_IGNORE_RE.test(path)).toBe(true)
	})

	it.each(["/app/src/app.ts", "/app/src/_general.ts", "/app/src/my_gen/x.ts", "/app/src/gen.ts"])(
		"watches %s",
		(path) => {
			expect(WATCH_IGNORE_RE.test(path)).toBe(false)
		},
	)
})
