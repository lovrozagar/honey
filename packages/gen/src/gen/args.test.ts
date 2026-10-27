/**
 * The generate CLI's arguments (bit 17 phase h): an unknown flag, a missing value, a stray argument, an unknown target,
 * an option no target asked for and a boolean that is not true or false are usage errors; targets repeat once each,
 * values come inline or next, and a target's options keep their generator's names.
 */
import { describe, expect, it } from "vitest"
import { parseGenerate, UsageError } from "./args.ts"

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
			refused([...base, "--target", "go", "--go-throw-on-error=maybe"]),
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
			'--go-throw-on-error takes true or false, not "maybe"',
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
			"--go-throw-on-error=false",
			"--cli-binary-name",
			"shop",
			"--watch",
		])
		expect([run.spec, run.out, run.targets, run.options.go, run.options.cli, run.watch]).toEqual([
			"s.json",
			"o",
			["go", "cli"],
			{ throwOnError: false },
			{ binaryName: "shop" },
			true,
		])
	})
})
