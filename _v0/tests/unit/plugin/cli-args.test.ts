import { describe, expect, it } from "vitest"
import { parseGenerateArgs, parseInitFlags, UsageError } from "../../../src/cli-args.ts"

describe("honey generate argument parsing", () => {
	it("accepts --k v and --k=v", () => {
		expect(parseGenerateArgs(["--app", "src/a.ts"]).app).toBe("src/a.ts")
		expect(parseGenerateArgs(["--app=src/other.ts"]).app).toBe("src/other.ts")
		expect(parseGenerateArgs(["--config=nope.ts"]).config).toBe("nope.ts")
	})

	it("a value flag never swallows the next flag", () => {
		expect(() => parseGenerateArgs(["--app", "--watch"])).toThrow(/--app requires a value/)
		expect(() => parseGenerateArgs(["--config"])).toThrow(/--config requires a value/)
		expect(() => parseGenerateArgs(["--app="])).toThrow(/requires a value/)
	})

	it("rejects unknown flags, so typos fail instead of being ignored", () => {
		expect(() => parseGenerateArgs(["--manifset"])).toThrow(UsageError)
		expect(() => parseGenerateArgs(["--verbose", "--watch"])).toThrow(/unknown option: --verbose/)
	})

	it("rejects stray positionals", () => {
		expect(() => parseGenerateArgs(["src/app.ts"])).toThrow(/unexpected argument/)
	})

	it("boolean flags take no value except true/false", () => {
		expect(parseGenerateArgs(["--watch", "--tree"])).toMatchObject({ tree: true, watch: true })
		expect(parseGenerateArgs(["--tree=false"]).tree).toBe(false)
		expect(() => parseGenerateArgs(["--watch=yes"])).toThrow(/takes no value/)
	})

	it("--plugin takes a non-negative integer", () => {
		expect(parseGenerateArgs(["--plugin", "1"]).plugin).toBe(1)
		expect(() => parseGenerateArgs(["--plugin", "x"])).toThrow(/integer/)
	})
})

describe("honey init argument parsing", () => {
	it("--cloudflare is an alias of --cf", () => {
		expect(parseInitFlags(["--cloudflare"]).cf).toBe(true)
		expect(parseInitFlags(["--cf", "--force"])).toEqual({ cf: true, force: true })
	})

	it("rejects unknown flags", () => {
		expect(() => parseInitFlags(["--cf", "--typo"])).toThrow(/unknown option: --typo/)
	})
})
