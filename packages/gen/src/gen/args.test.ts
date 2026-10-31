/**
 * The generate CLI's arguments (bit 17 phase h): an unknown flag, a missing value, a stray argument, an unknown target,
 * an option no target asked for and a boolean that is not true or false are usage errors; targets repeat once each,
 * values come inline or next, and a target's options keep their generator's names.
 */
import { describe, expect, it } from "vitest"
import { parseGenerate, usage, UsageError } from "./args.ts"

/** What parseGenerate makes of `argv`: "accepted", or the usage error's message. */
function refused(argv: string[]): string {
	try {
		parseGenerate(argv)
		return "accepted"
	} catch (error) {
		return error instanceof UsageError ? error.message : `not a usage error: ${String(error)}`
	}
}

describe("generate's arguments (phase h)", () => {
	it("refuses an unknown flag, a missing value, a stray argument, an unknown target and an option no target asked for", () => {
		const base = ["--spec", "s.json", "--out", "o"]
		expect([
			refused([...base, "--target", "ts", "--nope"]),
			refused([...base, "--target"]),
			refused([...base, "--target", "--ts-name"]),
			refused([...base, "--target", "ts", "stray"]),
			refused([...base, "--target", "kotlin"]),
			refused([...base, "--target", "ts", "--rust-crate-name", "x"]),
			refused([...base, "--target", "java", "--watch=maybe"]),
			refused(["--out", "o", "--target", "ts"]),
			refused(["--spec", "s.json", "--target", "ts"]),
			refused(["--spec", "s.json", "--out", "o"]),
			refused([...base, "--target", "ts", "--"]),
		]).toEqual([
			"unknown option --nope",
			"--target requires a value",
			"--target requires a value",
			'unexpected argument "stray"',
			'--target "kotlin": want one of cli, csharp, go, java, mcp, python, rust, ts',
			"options for rust, which no --target names",
			'--watch takes true or false, not "maybe"',
			"--spec or --app is required",
			"--out is required",
			"--target is required",
			'unexpected argument "--"',
		])
	})

	it("takes repeated targets once each, values inline or next, and a boolean bare, true or false", () => {
		const run = parseGenerate([
			"--spec=s.json",
			"--out",
			"o",
			"--target",
			"go",
			"--target=cli",
			"--target",
			"go",
			"--target",
			"java",
			"--java-client-name",
			"ShopClient",
			"--cli-binary-name",
			"shop",
			"--watch",
		])
		expect([run.spec, run.out, run.targets, run.options.java, run.options.cli, run.watch]).toEqual([
			"s.json",
			"o",
			["go", "cli", "java"],
			{ clientName: "ShopClient" },
			{ binaryName: "shop" },
			true,
		])
	})
})

describe("generate's --watch, the one boolean flag", () => {
	/* bit 21 i6: no target option is a boolean now, so --watch alone holds the bare, true and false forms */
	it("takes --watch bare or =true as true, and =false as false", () => {
		const base = ["--spec", "s.json", "--out", "o", "--target", "go"]
		expect(["--watch", "--watch=true", "--watch=false"].map((flag) => parseGenerate([...base, flag]).watch)).toEqual([
			true,
			true,
			false,
		])
	})
})

/*
 * bit 21 i2 (python), i3 (go), i4 (rust), i5 (csharp) and i6 (java): a client always throws and its safe mirror answers
 * a Result, so the error-mode option is gone, in every target
 */
describe("generate's removed options", () => {
	it.each(["python", "go", "rust", "csharp", "java"])(
		"refuses --%s-throw-on-error as the unknown option it now is",
		(target) => {
			const base = ["--spec", "s.json", "--out", "o", "--target", target]
			const flags = [`--${target}-throw-on-error`, `--${target}-throw-on-error=false`]
			expect(flags.map((flag) => refused([...base, flag]))).toEqual(
				flags.map(() => `unknown option --${target}-throw-on-error`),
			)
		},
	)
})

/*
 * The usage text is what a reader finds first, so it names the targets `--target` actually takes: it listed seven of
 * the eight (mcp was missing) until it was derived from the table itself (bit 22).
 */
describe("generate's usage text", () => {
	it("names every target --target accepts, and refuses none of them", () => {
		const listed = /^  --target <name>   (.*); repeat/m.exec(usage())?.[1]?.split(", ") ?? []
		const accepted = listed.filter(
			(target) => refused(["--spec", "s.json", "--out", "o", "--target", target]) === "accepted",
		)
		expect([listed.length, accepted]).toEqual([8, listed])
	})
})
