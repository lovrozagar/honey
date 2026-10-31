/**
 * The `honey` CLI's argument parsing (bit 19 h1, ported from v0's unit/plugin/cli-args.test.ts): strict, `--k v` and
 * `--k=v`, a value flag never taking the next flag, unknown flags and stray arguments refused, booleans bare, `true`
 * or `false`; `--plugin` an integer; init's `--cloudflare` an alias of `--cf`.
 */
import { describe, expect, it } from "vitest"
import { parseGenerateArgs, parseInitFlags, UsageError } from "./cli-args.ts"

/** What parsing `argv` threw: the usage error's message, else what it returned. */
function refusal(parse: (argv: string[]) => unknown, argv: string[]): unknown {
	try {
		return parse(argv)
	} catch (err) {
		return err instanceof UsageError ? err.message : err
	}
}

describe("honey generate argument parsing", () => {
	// v0: 5cf3040bb7
	it("accepts --k v and --k=v", () => {
		expect([
			parseGenerateArgs(["--app", "src/a.ts"]).app,
			parseGenerateArgs(["--app=src/other.ts"]).app,
			parseGenerateArgs(["--config=nope.ts"]).config,
			parseGenerateArgs(["--merge-tree=a=b.ts"]).mergeTree,
		]).toEqual(["src/a.ts", "src/other.ts", "nope.ts", "a=b.ts"])
	})

	// v0: 53a99dad72
	it("a value flag never swallows the next flag", () => {
		expect([
			refusal(parseGenerateArgs, ["--app", "--watch"]),
			refusal(parseGenerateArgs, ["--config"]),
			refusal(parseGenerateArgs, ["--app="]),
		]).toEqual(["--app requires a value", "--config requires a value", "--app requires a value"])
	})

	// v0: c50d0baa1f
	it("rejects unknown flags, so typos fail instead of being ignored", () => {
		expect([refusal(parseGenerateArgs, ["--manifset"]), refusal(parseGenerateArgs, ["--verbose", "--watch"])]).toEqual([
			"unknown option --manifset",
			"unknown option --verbose",
		])
	})

	// v0: 8f0b740035
	it("rejects stray positionals", () => {
		expect(refusal(parseGenerateArgs, ["src/app.ts"])).toBe('unexpected argument "src/app.ts"')
	})

	// v0: 8b4bf0d3e4
	it("boolean flags take no value except true/false", () => {
		expect([
			parseGenerateArgs(["--watch", "--tree"]),
			parseGenerateArgs(["--tree=false"]).tree,
			refusal(parseGenerateArgs, ["--watch=yes"]),
		]).toEqual([{ tree: true, watch: true }, false, '--watch takes true or false, not "yes"'])
	})

	// v0: 6675715d84
	it("--plugin takes a non-negative integer", () => {
		expect([parseGenerateArgs(["--plugin", "1"]).plugin, refusal(parseGenerateArgs, ["--plugin", "x"])]).toEqual([
			1,
			'--plugin takes a non-negative integer, not "x"',
		])
	})

	it("reads -h and --help as help; the SDK and CLI flags are honey-clients's (Q1)", () => {
		expect([
			parseGenerateArgs(["-h"]).help,
			parseGenerateArgs(["--help"]).help,
			refusal(parseGenerateArgs, ["--sdk"]),
			refusal(parseGenerateArgs, ["--cli-out", "x"]),
		]).toEqual([true, true, "unknown option --sdk", "unknown option --cli-out"])
	})
})

describe("honey init argument parsing", () => {
	// v0: 2a36f102fa
	it("--cloudflare is an alias of --cf", () => {
		expect([parseInitFlags(["--cloudflare"]).cf, parseInitFlags(["--cf", "--force"])]).toEqual([
			true,
			{ cf: true, force: true },
		])
	})

	// v0: 3a045bcf9d
	it("rejects unknown flags", () => {
		expect([refusal(parseInitFlags, ["--cf", "--typo"]), refusal(parseInitFlags, ["app"])]).toEqual([
			"unknown option --typo",
			'unexpected argument "app"',
		])
	})
})
