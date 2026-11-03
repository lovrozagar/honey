/**
 * The generate CLI's arguments (bit 17 phase h): an unknown flag, a missing value, a stray argument, an unknown target,
 * an option no target asked for and a boolean that is not true or false are usage errors; targets repeat once each,
 * values come inline or next, and a target's options keep their generator's names.
 */
import { describe, expect, it } from "vitest"
import { METADATA_FIELDS } from "../emit/shared/metadata.ts"
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

describe("a boolean target option takes no value (bit 22)", () => {
	const base = ["--spec", "s.json", "--out", "o", "--target", "ts"]

	it("is true when bare, and reads an inline true or false, as --watch does", () => {
		expect(parseGenerate([...base, "--ts-tanstack-query"]).options.ts).toEqual({ tanstackQuery: "true" })
		expect(parseGenerate([...base, "--ts-tanstack-query=true"]).options.ts).toEqual({ tanstackQuery: "true" })
		expect(parseGenerate([...base, "--ts-tanstack-query=false"]).options.ts).toEqual({ tanstackQuery: "false" })
	})

	it("refuses a value after a space, and an inline value that is not a boolean", () => {
		expect([
			refused([...base, "--ts-tanstack-query", "false"]),
			refused([...base, "--ts-tanstack-query=maybe"]),
		]).toEqual(['unexpected argument "false"', '--ts-tanstack-query takes true or false, not "maybe"'])
	})

	it("leaves a valued option of the same target alone", () => {
		expect(parseGenerate([...base, "--ts-name", "Shop", "--ts-tanstack-query"]).options.ts).toEqual({
			name: "Shop",
			tanstackQuery: "true",
		})
		expect(refused([...base, "--ts-name"])).toBe("--ts-name requires a value")
	})
})

describe("the cli target's release options (release program D7, D8)", () => {
	const base = ["--spec", "s.json", "--out", "o", "--target", "cli"]

	it("takes each channel's value under its generator's name, and --cli-aur as a switch", () => {
		expect(
			parseGenerate([
				...base,
				"--cli-repo",
				"acme/shop",
				"--cli-description",
				"Shop",
				"--cli-homepage",
				"https://shop.example.com",
				"--cli-license",
				"MIT",
				"--cli-maintainer",
				"Acme <ops@example.com>",
				"--cli-install-url",
				"https://shop.example.com/cli",
				"--cli-homebrew-tap",
				"acme/homebrew-tap",
				"--cli-scoop-bucket",
				"acme/scoop-bucket",
				"--cli-winget-publisher",
				"Acme",
				"--cli-winget-fork",
				"acme/winget-pkgs",
				"--cli-packages",
				"deb,rpm",
				"--cli-aur",
			]).options.cli,
		).toEqual({
			aur: "true",
			description: "Shop",
			homebrewTap: "acme/homebrew-tap",
			homepage: "https://shop.example.com",
			installUrl: "https://shop.example.com/cli",
			license: "MIT",
			maintainer: "Acme <ops@example.com>",
			packages: "deb,rpm",
			repo: "acme/shop",
			scoopBucket: "acme/scoop-bucket",
			wingetFork: "acme/winget-pkgs",
			wingetPublisher: "Acme",
		})
	})

	it("refuses a value after --cli-aur, as every switch does", () => {
		expect(refused([...base, "--cli-aur", "yes"])).toBe('unexpected argument "yes"')
	})
})

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

describe("generate's --metadata-<field> flags (plan 39 8.2)", () => {
	const base = ["--spec", "s.json", "--out", "o", "--target", "csharp"]

	it("reads each field under its kebab name, authors and keywords split at commas", () => {
		const run = parseGenerate([
			...base,
			"--metadata-authors",
			"Acme Inc <oss@acme.dev>, Bo",
			"--metadata-keywords=shop,api-client",
			"--metadata-license-file",
			"LICENSE",
			"--metadata-description=The Shop API",
		])
		expect(run.metadata).toEqual({
			authors: ["Acme Inc <oss@acme.dev>", "Bo"],
			description: "The Shop API",
			keywords: ["shop", "api-client"],
			licenseFile: "LICENSE",
		})
		expect(parseGenerate(base).metadata).toEqual({})
	})

	it("refuses a field it does not know and a field with no value", () => {
		expect(refused([...base, "--metadata-licence", "MIT"])).toBe("unknown option --metadata-licence")
		expect(refused([...base, "--metadata-description"])).toBe("--metadata-description requires a value")
	})

	it("lists every field in the usage text", () => {
		expect(
			METADATA_FIELDS.filter(
				(field) => !usage().includes(`--metadata-${field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`),
			),
		).toEqual([])
	})
})
