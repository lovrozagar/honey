/**
 * The build's watch globs (bit 19 h1, ported from v0's unit/plugin/glob.test.ts and two ws9-12 tooling regressions):
 * a pattern is anchored at the project root, `**` spans segments, `*` and `?` stay in one, braces alternate, classes
 * work, a name's regex metacharacters are literal; WATCH_IGNORE_RE skips generated files, dependencies and temp files.
 */
import { describe, expect, it } from "vitest"
import { matchesGlob, WATCH_IGNORE_RE } from "./glob.ts"

const ROOT = "/project"
const m = (file: string, ...patterns: string[]) => matchesGlob(`${ROOT}/${file}`, patterns, ROOT)

describe("watch glob matching", () => {
	// v0: 9905b12df1
	it("src/** matches every file under src, at any depth", () => {
		expect([m("src/a.ts", "src/**"), m("src/routes/users/get.ts", "src/**"), m("lib/a.ts", "src/**")]).toEqual([
			true,
			true,
			false,
		])
	})

	// v0: ba6f8716a2
	it("src/routes/** matches nested files", () => {
		expect([m("src/routes/a.ts", "src/routes/**"), m("src/routes/v1/a.ts", "src/routes/**")]).toEqual([true, true])
	})

	// v0: 0371afda3d
	it("brace alternation", () => {
		const pattern = "src/**/*.{ts,tsx}"
		expect([m("src/a.tsx", pattern), m("src/x/a.ts", pattern), m("src/x/a.js", pattern)]).toEqual([true, true, false])
	})

	// v0: 7f209fea43
	it("a leading ./ is ignored", () => {
		expect(m("src/a.ts", "./src/**/*.ts")).toBe(true)
	})

	// v0: 3cb8f1d64d
	it("is anchored at the project root", () => {
		expect([m("node_modules/x/src/a.ts", "src/**/*.ts"), m("packages/app/src/a.ts", "src/**/*.ts")]).toEqual([
			false,
			false,
		])
	})

	// v0: aa19987e5f
	it("never matches outside the root", () => {
		expect(matchesGlob("/elsewhere/src/a.ts", ["src/**", "**"], ROOT)).toBe(false)
	})

	// v0: e20ded1033
	it("* and ? stay within one segment; classes work", () => {
		expect([
			m("src/a.ts", "src/*.ts"),
			m("src/x/a.ts", "src/*.ts"),
			m("src/a1.ts", "src/a?.ts"),
			m("src/a1.ts", "src/a[0-9].ts"),
			m("src/ab.ts", "src/a[!0-9].ts"),
			m("src/a1.ts", "src/a[!0-9].ts"),
		]).toEqual([true, false, true, true, true, false])
	})

	// v0: 09b5a4e53b
	it("regex metacharacters in names are literal", () => {
		expect([m("src/a+b.ts", "src/a+b.ts"), m("src/aab.ts", "src/a+b.ts")]).toEqual([true, false])
	})
})

describe("watch patterns over a project (ws9-12 tooling regressions)", () => {
	// v0: bebc5bb860
	it.each([
		["src/**", "src/routes/users/list.ts"],
		["src/routes/**", "src/routes/users/list.ts"],
		["src/**/*.{ts,tsx}", "src/routes/page.tsx"],
		["./src/**/*.ts", "src/routes/users/list.ts"],
	])("watch pattern %s regenerates on %s", (pattern, file) => {
		expect(m(file, pattern)).toBe(true)
	})

	// v0: 40f6d79eff
	it("src/**/*.ts does not match a file under node_modules", () => {
		expect(m("node_modules/x/src/a.ts", "src/**/*.ts")).toBe(false)
	})
})

describe("WATCH_IGNORE_RE", () => {
	/* creating the _gen directory fires a watch event for the bare directory path */
	// v0: df5a0af728
	it.each([
		"/app/src/_gen",
		"/app/src/_gen/routes.gen.ts",
		"/app/src/routes.gen.ts",
		"/app/src/routes.gen.ts.ab12cd.tmp",
		"/app/node_modules/x/index.ts",
	])("ignores %s", (path) => {
		expect(WATCH_IGNORE_RE.test(path)).toBe(true)
	})

	// v0: fd3357dd1c
	it.each(["/app/src/app.ts", "/app/src/_general.ts", "/app/src/my_gen/x.ts", "/app/src/gen.ts"])(
		"watches %s",
		(path) => {
			expect(WATCH_IGNORE_RE.test(path)).toBe(false)
		},
	)
})

describe("brace edge cases and relative files (bit 19 h1)", () => {
	it("nests brace alternations, and reads a relative file from the root", () => {
		expect([m("src/c.ts", "src/{a,{b,c}}.ts"), matchesGlob("src/a.ts", ["src/**"], ROOT)]).toEqual([true, true])
	})

	it("reads a stray ** inside a segment as *, within one segment", () => {
		expect([m("src/abc.ts", "src/a**.ts"), m("src/a/bc.ts", "src/a**.ts")]).toEqual([true, false])
	})

	it("an unclosed brace is a literal character", () => {
		expect([m("src/{a.ts", "src/{a.ts"), m("src/a.ts", "src/{a.ts")]).toEqual([true, false])
	})
})
